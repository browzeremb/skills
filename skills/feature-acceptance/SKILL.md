---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics — autonomous mode (agent runs every check) or manual mode (operator runs a how-to-verify checklist out of band). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(curl *), Bash(node *), Bash(jq *), Bash(mv *), Bash(date *), Read, Write, Edit, AskUserQuestion, Agent
---

# feature-acceptance — verify the feature against its PRD contract

Runs after `update-docs`, before `commit`. Single responsibility: verify every `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]` the PRD declared, using either autonomous agent-driven checks or a manual operator-driven checklist. Writes `STEP_<NN>_FEATURE_ACCEPTANCE` to `workflow.json`.

Mutation testing now belongs to `write-tests`; blast-radius regression lives in `code-review`'s `regression-tester` agent and `receiving-code-review`'s post-fix gates. This skill is purely AC/NFR/metric verification.

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

Stamp `startedAt` BEFORE Phase 1 begins (per workflow-schema §5.1) — the verdict step often pauses on operator response, and `elapsedMin` should reflect total wall-clock including the pause.

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

### 2.2 — Inherit deferred ACs from prior steps' scopeAdjustments

Before classifying any AC, walk every prior step's `task.execution.scopeAdjustments[]` (and `codeReview.notes` / `receivingCodeReview.dispatches[*].notes` when present) and auto-map any deferred / out-of-scope items to `operatorActionsRequested[]`. Without this auto-mapping, ACs that earlier task steps marked as deferred (e.g. live browser checks, deploy-time observation, environment-blocked smoke runs) end up listed here as `unverified` and force the verdict to `STOPPED` instead of `paused-pending-operator-action`. The mapping must be automatic so deferred ACs surface as operator actions, not autonomous-mode failures.

```bash
DEFERRED=$(browzer workflow query deferred-scope-adjustments --workflow "$WORKFLOW")
```

`query deferred-scope-adjustments` walks every step's `task.execution.scopeAdjustments[]` and returns the entries whose `owner`, `reason`, or `adjustment` text matches a deferred-marker keyword (`operator`, `deferred`, `follow-up`, `staging`, `deploy-time`, `skipped`, …). Each entry carries its originating `stepId`, the verbatim `adjustment` / `reason` / `resolution` / `owner` strings, deduped by `adjustment+reason`. No need to chase per-step `stepId` capture — the query embeds it.

For each entry in `DEFERRED`, append to `operatorActionsRequested[]`:

```jsonc
{ "ac": "<AC-id if mappable, else null>",
  "kind": "inherited-scope-adjustment",
  "sourceStepId": "<originating step>",
  "description": "<adjustment text verbatim>",
  "reason": "<reason text verbatim>",
  "status": "pending", "at": "<ISO>", "resolved": false }
```

Mapping rules:

- If the adjustment text mentions a specific AC id (`AC-12`, `AC-5`, etc.), bind `ac` to that id and flip its `status` to `unverified` BEFORE Phase 2.5's regex pass runs.
- If the adjustment names a route, surface, or component (`/dashboard/members`, `WorkspaceMultiselect`, etc.), match it against AC text via case-insensitive substring; bind on first match.
- If neither rule matches, leave `ac: null` — the operator will resolve it as a free-floating action.

This step runs BEFORE 2.3 (verification methods) so the AC list it sees already has the deferred entries marked. Skipping this step makes Phase 4's verdict count deferred ACs as ordinary autonomous-mode failures, which forces a `STOPPED` status that should have been a `paused` status with a clear operator-action list.

### 2.3 — Verification methods (per AC)

For every AC, derive the method from the description + `bindsTo[]`:

- **Testable** → scoped `pnpm test --filter=<pkg>` (or equivalent). Parse pass/fail + specific test names.
- **Inspectable** → dispatch an `Agent` (sonnet) to examine the code; require pass/fail with file paths + line ranges as evidence.
- **Metric-gated** → measure via HTTP probe / Prometheus query / latency bench / CI artefact; compare to the bound NFR or metric target.

Record every result with `{ id, status: "verified|unverified|failed", evidence, method: "test|inspect|metric" }`.

### 2.4 — NFR check categories

| Category | Check |
| --- | --- |
| `perf` | Run a bench (`pnpm bench` or `k6 run`); compare p50/p95 to `target`. |
| `security` | `pnpm audit` + invariant checks (`timingSafeEqual` usage, `getWorkspace(id, orgId)` scoping). Dispatch an Agent for deeper manual inspection when automated tooling is insufficient. |
| `a11y` | Axe-core or Playwright a11y probe against the affected UI surface. |
| `observability` | Grep for the instrumented call, probe the endpoint, read the trace in whatever observability backend the repo uses. |
| `scalability` | Not typically automatable — dispatch an Agent to inspect tenant scoping + resource allocation. |

Record each NFR with `{ id, status: "verified|partial|failed", coversAcceptanceSignal: "pass|warn|block", evidence, measured, target }`. Use `partial` when the feature didn't regress the invariant but a known gap remains; pair with the signal — `warn` = non-blocking follow-up, `block` = NFR unmet (verdict fails unless explicitly overridden in `reviewHistory[]`). `pass` is degenerate; prefer `verified`.

### 2.5 — Success metrics

For each metric in `prd.successMetrics[]`: measure via probe / query / CI artefact, compare to `target`, record as `{ id, measured, target, status: "met|unmet" }`.

### 2.6 — Operator-action gate (autonomous + hybrid)

**Manual-AC detection (autonomous-mode anti-soft-override).** Before classifying an AC as testable / inspectable / metric-gated, scan its description against this regex:

```
/\b(manual smoke|smoke harness|full[- ]stack smoke|staging|click|human[- ]in[- ]the[- ]loop|deploy[- ]time|verify in (browser|UI))\b/i
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
3. The autonomous run does NOT pass FEATURE_ACCEPTANCE while any such entry is `pending` — emit the §2.6 pause line below and wait for operator reply.

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

### 2.6.1 — Operator AC-target relaxations

When the operator amends an AC's target at acceptance time (e.g. "AC-4 says ≤5s but the harness empirically takes ~8s; accept ≤10s"), record the relaxation as a structured entry under `featureAcceptance.acRelaxations[]` per schema §4:

```jsonc
{ "acId": "AC-4",
  "originalTarget": "≤5s",
  "relaxedTarget": "≤10s",
  "rationale": "<verbatim operator phrasing>",
  "source": "operator",
  "at": "<ISO>" }
```

Then evaluate the AC's status against the relaxed target, not the original. The PRD stays unchanged (it remains the historical record); the audit trail captures both the original target and the relaxation rationale, machine-readable for future retros. Free-text-only relaxations buried in `reviewHistory[]` are insufficient — they don't show up in the structured view.

### 2.7 — Manual + hybrid checklist template

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

Decide final `status` for the step (three-way, per workflow-schema §"Verdict computation"):

```bash
FAILED=$(jq '
  [.featureAcceptance.acceptanceCriteria[] | select(.status=="failed")] +
  [.featureAcceptance.nfrVerifications[]
    | select(
        .status == "failed"
        or (.status == "partial" and .coversAcceptanceSignal == "block")
      )] +
  [.featureAcceptance.successMetrics[] | select(.status=="unmet")]
  | length
' <<< "$FEATURE_ACCEPTANCE_STEP")

UNVERIFIED=$(jq '
  [.featureAcceptance.acceptanceCriteria[] | select(.status=="unverified")] | length
' <<< "$FEATURE_ACCEPTANCE_STEP")

PENDING_DEFERRED=$(jq '
  [.featureAcceptance.operatorActionsRequested[]
    | select(.resolved == false and .kind == "deferred-post-merge")] | length
' <<< "$FEATURE_ACCEPTANCE_STEP")
```

- `FAILED > 0` → `status: "STOPPED"` (at least one AC/NFR/metric genuinely failed; remediation needed).
- `FAILED == 0 && (PENDING_DEFERRED > 0 || UNVERIFIED > 0 with kind=deferred-post-merge mapping)` → `status: "PAUSED_PENDING_OPERATOR"`. The automated checks all passed; the operator owes deferred follow-up (staging soak, deploy-time observation, manual verification). The orchestrator's `commit` phase still runs — this verdict does NOT block. The truth-claim is honest: deferred entries are NOT "verified", they are explicitly pending.
- `FAILED == 0 && UNVERIFIED == 0 && PENDING_DEFERRED == 0` → `status: "COMPLETED"`.

**Banned mapping**: do NOT mark a deferred-post-merge AC as `status: "verified"` with `method: "operator-deferral"`. Use `status: "unverified"` + an `operatorActionsRequested[]` entry with `kind: "deferred-post-merge"`; the verdict computation handles the rest.

Append via jq + atomic rename. Reuse the `STARTED_AT` captured at Phase 0 so `elapsedMin` reflects real wall-clock (per workflow-schema §5.1):

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_AT="${FA_STARTED_AT:-$NOW}"     # captured at Phase 0
STEP=$(jq -n \
  --arg id "$STEP_ID" \
  --arg startedAt "$STARTED_AT" \
  --arg now "$NOW" \
  --arg status "$FINAL_STATUS" \
  --argjson featureAcceptance "$FA_PAYLOAD" \
  '{
     stepId: $id,
     name: "FEATURE_ACCEPTANCE",
     status: $status,
     applicability: { applicable: true, reason: "final acceptance gate" },
     startedAt: $startedAt,
     completedAt: $now,
     elapsedMin: ((($now | fromdateiso8601) - ($startedAt | fromdateiso8601)) / 60),
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

echo "$STEP" | browzer workflow append-step --workflow "$WORKFLOW"
```

### 3.1 — Review gate (when `config.mode == "review"`)

The always-ask in Phase 1 fires regardless of `config.mode`. In addition, when `.config.mode == "review"`, flip `status` to `AWAITING_REVIEW` before the final write, render `references/renderers/feature-acceptance.jq` for the operator, and enter the gate loop (Approve / Adjust / Skip / Stop). Operator adjustments translate to jq ops on `.featureAcceptance.acceptanceCriteria[]` / `.nfrVerifications[]` / `.successMetrics[]` (e.g. "downgrade AC-2 to unverified — I haven't measured yet" → status flip + evidence blanking). Append each round to `reviewHistory[]`.

## Phase 4 — Verdict and one-line confirmation

### Success (all verified + met)

```
feature-acceptance: updated workflow.json <STEP_ID>; status COMPLETED; AC <n> NFR <m> M <k> all passed
```

### Paused (deferred-post-merge actions outstanding)

```
feature-acceptance: updated workflow.json <STEP_ID>; status PAUSED_PENDING_OPERATOR; AC <n> NFR <m> M <k> verified; <P> deferred-post-merge actions pending
```

The orchestrator chains to commit anyway — this verdict means "feature can ship; operator owes follow-up". The pending actions live in `operatorActionsRequested[]` and are surfaced when the operator resolves them later (manual `feature-acceptance` re-invocation flips their `resolved: true`).

### Failure (one or more failed)

```
feature-acceptance: stopped at <STEP_ID> — <F> checks failed (AC/NFR/metrics)
hint: re-enter receiving-code-review or execute-task for remediation; reinvoke feature-acceptance when ready

When the failure is an operator-reported staging regression (not an internal AC/NFR check), the orchestrator MUST re-enter `receiving-code-review` with `reason: "staging-regression"` and append to the existing `receivingCodeReview.dispatches[]` array — NEVER to a sibling key like `stagingRegressionFixes`. See `receiving-code-review` §Re-entry from feature-acceptance.
```

Include a short summary listing the specific failed IDs:

```
feature-acceptance: stopped at STEP_08_FEATURE_ACCEPTANCE — 2 checks failed (AC/NFR/metrics)
  failed: AC-3 (unverified), NFR-2 (failed: p95 measured 240ms, target <200ms)
hint: re-enter receiving-code-review or execute-task for remediation; reinvoke feature-acceptance when ready
```

**Banned from chat output:** full AC/NFR/metric tables, evidence blobs, operator-action transcripts. All of that lives in the JSON.

---

## Non-negotiables

- **Output language: English.** JSON payload in English. Conversational wrapper follows operator's language.
- Phase 1 prompt ALWAYS fires, even in autonomous flow-mode.
- Do NOT apply fixes. If a criterion fails, stop the step and hint to `receiving-code-review` or `execute-task`. This skill verifies; it does not remediate.
- Do NOT run mutation testing here (moved to `code-review`).
- Do NOT run blast-radius regression here (moved to `code-review`'s `regression-tester` agent + `receiving-code-review`'s post-fix gates).
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — phase 7 of the pipeline (after `update-docs`).
- **Standalone** — operator invokes after manual iteration to re-verify against the PRD. Re-invocation writes a new `FEATURE_ACCEPTANCE` step.

---

## Related skills and references

- `code-review` — runs BEFORE this; the mutation-testing + cyclomatic audit + team review live there.
- `receiving-code-review` — runs before this skill; closes every code-review finding with severity-proportional fix agents and a 7-step ladder.
- `update-docs` — runs immediately before this; ensures docs reflect final code state.
- `commit` — runs AFTER this; blocks until `feature-acceptance` reaches COMPLETED.
- `references/workflow-schema.md` — authoritative schema (`featureAcceptance`).
- `references/renderers/feature-acceptance.jq` — markdown renderer invoked in review mode.
- `references/mutation-runners.md` — historical reference (kept from the old skill); mutation now runs in `code-review`, not here.
