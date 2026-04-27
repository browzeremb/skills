---
name: feature-acceptance
description: "Final-phase skill that verifies the shipped feature against its PRD's acceptance criteria, non-functional requirements, and success metrics. Replaces the old verification-before-completion mutation/blast-radius flow (those responsibilities moved to code-review and fix-findings). Always asks operator: autonomous (agent verifies everything) or manual (agent presents checklist + how-to-verify, operator verifies out-of-band). Writes STEP_<NN>_FEATURE_ACCEPTANCE to workflow.json. Fails the step (status: STOPPED) if any AC/NFR/metric is unmet, hinting back to fix-findings or execute-task. Triggers: 'verify acceptance criteria', 'acceptance gate', 'check AC/NFR/metrics', 'feature acceptance', 'verify the feature is done', 'is this feature ready', 'final verification', 'pre-commit acceptance'."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(curl *), Bash(node *), Bash(jq *), Bash(mv *), Bash(date *), Read, Write, Edit, AskUserQuestion, Agent
---

# feature-acceptance — verify the feature against its PRD contract

Runs after `update-docs`, before `commit`. Single responsibility: verify every `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]` the PRD declared, using either autonomous agent-driven checks or a manual operator-driven checklist. Writes `STEP_<NN>_FEATURE_ACCEPTANCE` to `workflow.json`.

The old `verification-before-completion` phases (blast-radius coverage + mutation testing) are deleted — those responsibilities moved to `fix-findings` (§11 of the design spec) and `code-review` (§10) respectively.

Output contract: emit ONE confirmation line on success. One confirmation line on success.

---

## Phase 0 — Resolve input

Bind `FEAT_DIR` from args or newest `docs/browzer/feat-*/`. Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

Read the PRD acceptance contract:

```bash
AC=$(jq '.steps[] | select(.name=="PRD") | .prd.acceptanceCriteria' "$WORKFLOW")
NFR=$(jq '.steps[] | select(.name=="PRD") | .prd.nonFunctionalRequirements' "$WORKFLOW")
METRICS=$(jq '.steps[] | select(.name=="PRD") | .prd.successMetrics' "$WORKFLOW")
```

Read the completed task executions for evidence:

```bash
TASK_EXECUTIONS=$(jq '[.steps[] | select(.name=="TASK") | {taskId, execution: .task.execution}]' "$WORKFLOW")
```

If any of AC / NFR / METRICS is missing or empty in the PRD, emit:

```
feature-acceptance: stopped at STEP_<NN>_FEATURE_ACCEPTANCE — PRD has no <AC|NFR|successMetrics>
hint: extend the PRD via generate-prd adjust flow, or mark the missing category "n/a" explicitly
```

Derive the step id:

```bash
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_FEATURE_ACCEPTANCE"
```

## Phase 1 — Operator prompt (ALWAYS, even in autonomous flow-mode)

This skill's internal mode is distinct from the flow-level `config.mode`. ALWAYS prompt:

```
AskUserQuestion:
  Mode for feature acceptance?
    (a) autonomous — I verify each AC/NFR/metric programmatically
    (b) manual — I present the checklist + how-to-verify; you verify out-of-band and reply with results
    (c) hybrid — I verify everything I can programmatically AND emit a manual checklist (with affected routes / UI paths) for what only a human can confirm in staging
```

Record operator choice in the step payload's `mode` field. Operator-typed
freeform answers (e.g. "autonomous + manual, you give me the path of the
affected screens") MUST be normalized to `hybrid` — do not invent a non-enum
mode label. Capture the operator's literal phrasing in
`featureAcceptance.modeNote` so the audit trail keeps the original wording.

## Phase 2 — Run verification

The mode picked in Phase 1 chooses how each `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]` entry gets resolved. All modes write into the same arrays in the step payload — they only differ in **who** verifies.

### 2.1 — Run modes matrix

| Mode | What runs | When to use |
| --- | --- | --- |
| `autonomous` | Agent verifies everything programmatically (tests / probes / invariant checks / Agent dispatches for inspect-only items). | Default for non-UI features with a strong test surface. |
| `manual` | Agent renders a checklist (AC + NFR + metric, each with how-to-verify). Operator replies with pass/fail + evidence per item. | UI-heavy work, third-party flows, anything the agent can't observe. |
| `hybrid` | Autonomous path FIRST for everything programmable. Then render a focused checklist for the residual items that need a human signal (UI smoke-test, eyes-on-staging, inspect-only). | The common case for full-stack features. |

### 2.2 — Verification methods (per AC)

For every AC, derive the method from the description + `bindsTo[]`:

- **Testable** → scoped `pnpm test --filter=<pkg>` (or equivalent). Parse pass/fail + specific test names.
- **Inspectable** → dispatch an `Agent` (sonnet) to examine the code; require pass/fail with file paths + line ranges as evidence.
- **Metric-gated** → measure via HTTP probe / Prometheus query / latency bench / CI artefact; compare to the bound NFR or metric target.

Record every result with `{ id, status: "verified|unverified|failed", evidence, method: "test|inspect|metric" }`.

### 2.3 — NFR check categories

| Category | Check |
| --- | --- |
| `perf` | Run a bench (`pnpm bench` or `k6 run`); compare p50/p95 to `target`. |
| `security` | `pnpm audit` + invariant checks (`timingSafeEqual` usage, `getWorkspace(id, orgId)` scoping). Dispatch an Agent for deeper manual inspection when automated tooling is insufficient. |
| `a11y` | Axe-core or Playwright a11y probe against the affected UI surface. |
| `observability` | Grep for the instrumented call, probe the endpoint, read the trace in whatever observability backend the repo uses. |
| `scalability` | Not typically automatable — dispatch an Agent to inspect tenant scoping + resource allocation. |

Record each NFR with `{ id, status: "verified|partial|failed", coversAcceptanceSignal: "pass|warn|block", evidence, measured, target }`. Use `partial` when the feature didn't regress the invariant but a known gap remains; pair with the signal — `warn` = non-blocking follow-up, `block` = NFR unmet (verdict fails unless explicitly overridden in `reviewHistory[]`). `pass` is degenerate; prefer `verified`.

### 2.4 — Success metrics

For each metric in `prd.successMetrics[]`: measure via probe / query / CI artefact, compare to `target`, record as `{ id, measured, target, status: "met|unmet" }`.

### 2.5 — Operator-action gate (autonomous + hybrid)

**Manual-AC detection (autonomous-mode anti-soft-override).** Before classifying an AC as testable / inspectable / metric-gated, scan its description against this regex:

```
/\b(manual smoke|staging|click|human[- ]in[- ]the[- ]loop|deploy[- ]time|verify in (browser|UI))\b/i
```

If the regex matches AND the operator chose `mode == "autonomous"`, the AC is reserved for human eyes — the autonomous path MUST NOT silently mark it `verified` with a "code-correctness portion" rationalization. The 2026-04-27 retro logged exactly that drift: an AC literally reading "Manual smoke test of staging" was checked off in autonomous mode with `evidence: "Physical staging smoke is recommended pre-deploy but is a deploy-time concern"`.

Action when matched:

1. Set `acceptanceCriteria[i].status = "unverified"`.
2. Append to `operatorActionsRequested[]`:
   ```jsonc
   { "ac": "AC-<n>", "kind": "manual-verification",
     "description": "<verbatim AC text>",
     "status": "pending", "at": "<ISO>", "resolved": false }
   ```
3. The autonomous run does NOT pass FEATURE_ACCEPTANCE while any such entry is `pending` — emit the §2.5 pause line below and wait for operator reply.

**Exception** — split allowed only when the AC text explicitly opts in by containing `code-only` or `code-correctness`. In that case the autonomous path may verify the code-correctness portion; record the rationale verbatim under `acceptanceCriteria[i].rationale` (mandatory field, not optional). No other phrasing of the split is sanctioned.

When a verification requires an action the agent cannot take alone (deploy to staging, click X in a browser, observe a human-in-the-loop signal), pause and append to `operatorActionsRequested[]`:

```jsonc
{ "at": "<ISO>", "description": "Deploy to staging and hit /api/health",
  "resolved": false, "resolution": null }
```

Emit:

```
feature-acceptance: paused at STEP_<NN>_FEATURE_ACCEPTANCE — operator action required
  <description>
  Reply with the result when done (pass/fail + evidence).
```

On operator reply, resolve the entry (`resolved: true` + `resolution`) and resume.

### 2.6 — Manual + hybrid checklist template

Render this checklist when running `manual` (covers everything) or `hybrid` (covers only residual items the autonomous path couldn't resolve):

```
## Feature acceptance checklist

### Routes / surfaces affected
  - <path or component>

### Acceptance criteria
  AC-1 (binds FR-1): <description>
    How to verify: <derived method>

### Non-functional requirements
  NFR-1 (perf): <description> — target <target>
    How to verify: run `<command>`, compare to target.

### Success metrics
  M-1: <metric> — target <target>, method <method>

Reply with pass/fail per item + evidence.
```

Record operator replies into the same `acceptanceCriteria[]` / `nfrVerifications[]` / `successMetrics[]` arrays as the autonomous path.

## Phase 3 — Write STEP_<NN>_FEATURE_ACCEPTANCE to workflow.json

Assemble the `featureAcceptance` payload per schema §4:

```jsonc
{
  "mode": "autonomous|manual|hybrid",
  "modeNote": "string (optional, captures operator freeform phrasing)",
  "acceptanceCriteria": [...],
  "nfrVerifications": [...],
  "successMetrics": [...],
  "operatorActionsRequested": [...]
}
```

Decide final `status` for the step:

```bash
FAILED=$(jq '
  [.featureAcceptance.acceptanceCriteria[] | select(.status!="verified")] +
  [.featureAcceptance.nfrVerifications[]
    | select(
        .status == "failed"
        or (.status == "partial" and .coversAcceptanceSignal == "block")
      )] +
  [.featureAcceptance.successMetrics[] | select(.status!="met")]
  | length
' <<< "$FEATURE_ACCEPTANCE_STEP")
```

- `FAILED == 0` → `status: "COMPLETED"`.
- `FAILED > 0` → `status: "STOPPED"` (at least one criterion failed).

Append via jq + atomic rename:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STEP=$(jq -n \
  --arg id "$STEP_ID" \
  --arg now "$NOW" \
  --arg status "$FINAL_STATUS" \
  --argjson featureAcceptance "$FA_PAYLOAD" \
  '{
     stepId: $id,
     name: "FEATURE_ACCEPTANCE",
     status: $status,
     applicability: { applicable: true, reason: "final acceptance gate" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0,
     itDependsOn: [],
     nextStep: null,
     skillsToInvoke: ["feature-acceptance"],
     skillsInvoked: ["feature-acceptance"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     featureAcceptance: $featureAcceptance
   }')

jq --argjson step "$STEP" \
   --arg now "$NOW" \
   '.steps += [$step]
    | .currentStepId = $step.stepId
    | .totalSteps = (.steps | length)
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

### 3.1 — Review gate (when `config.mode == "review"`)

The always-ask in Phase 1 fires regardless of `config.mode`. In addition, when `.config.mode == "review"`, flip `status` to `AWAITING_REVIEW` before the final write, render `references/renderers/feature-acceptance.jq` for the operator, and enter the gate loop (Approve / Adjust / Skip / Stop). Operator adjustments translate to jq ops on `.featureAcceptance.acceptanceCriteria[]` / `.nfrVerifications[]` / `.successMetrics[]` (e.g. "downgrade AC-2 to unverified — I haven't measured yet" → status flip + evidence blanking). Append each round to `reviewHistory[]`.

## Phase 4 — Verdict and one-line confirmation

### Success (all verified + met)

```
feature-acceptance: updated workflow.json <STEP_ID>; status COMPLETED; AC <n> NFR <m> M <k> all passed
```

### Failure (one or more failed)

```
feature-acceptance: stopped at <STEP_ID> — <F> checks failed (AC/NFR/metrics)
hint: re-enter fix-findings or execute-task for remediation; reinvoke feature-acceptance when ready

When the failure is an operator-reported staging regression (not an internal AC/NFR check), the orchestrator MUST re-enter `fix-findings` with `reason: "staging-regression"` and append to the existing `fixFindings.dispatches[]` array — NEVER to a sibling key like `stagingRegressionFixes`. See orchestrator Step 3.5 §Re-entry.
```

Include a short summary listing the specific failed IDs:

```
feature-acceptance: stopped at STEP_08_FEATURE_ACCEPTANCE — 2 checks failed (AC/NFR/metrics)
  failed: AC-3 (unverified), NFR-2 (failed: p95 measured 240ms, target <200ms)
hint: re-enter fix-findings or execute-task for remediation; reinvoke feature-acceptance when ready
```

**Banned from chat output:** full AC/NFR/metric tables, evidence blobs, operator-action transcripts. All of that lives in the JSON.

---

## Non-negotiables

- **Output language: English.** JSON payload in English. Conversational wrapper follows operator's language.
- Phase 1 prompt ALWAYS fires, even in autonomous flow-mode.
- Do NOT apply fixes. If a criterion fails, stop the step and hint to `fix-findings` or `execute-task`. This skill verifies; it does not remediate.
- Do NOT run mutation testing here (moved to `code-review`).
- Do NOT run blast-radius regression here (moved to `fix-findings`).
- `workflow.json` is mutated ONLY via `jq | mv`. Never with `Read`/`Write`/`Edit`.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — phase 7 of the pipeline (after `update-docs`).
- **Standalone** — operator invokes after manual iteration to re-verify against the PRD. Re-invocation writes a new `FEATURE_ACCEPTANCE` step.

---

## Related skills and references

- `code-review` — runs BEFORE this; the mutation-testing + cyclomatic audit + team review live there.
- `fix-findings` — internal orchestrator loop; the blast-radius regression + quality gates run there after corrections.
- `update-docs` — runs immediately before this; ensures docs reflect final code state.
- `commit` — runs AFTER this; blocks until `feature-acceptance` reaches COMPLETED.
- `references/workflow-schema.md` — authoritative schema (`featureAcceptance`).
- `references/renderers/feature-acceptance.jq` — markdown renderer invoked in review mode.
- `references/mutation-runners.md` — historical reference (kept from the old skill); mutation now runs in `code-review`, not here.
