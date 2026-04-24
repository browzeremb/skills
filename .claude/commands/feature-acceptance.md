---
name: feature-acceptance
description: "Final-phase skill that verifies the shipped feature against its PRD's acceptance criteria, non-functional requirements, and success metrics. Replaces the old verification-before-completion mutation/blast-radius flow (those responsibilities moved to code-review and fix-findings). Always asks operator: autonomous (agent verifies everything) or manual (agent presents checklist + how-to-verify, operator verifies out-of-band). Writes STEP_<NN>_FEATURE_ACCEPTANCE to workflow.json. Fails the step (status: STOPPED) if any AC/NFR/metric is unmet, hinting back to fix-findings or execute-task. Triggers: 'verify acceptance criteria', 'acceptance gate', 'check AC/NFR/metrics', 'feature acceptance', 'verify the feature is done', 'is this feature ready', 'final verification', 'pre-commit acceptance'."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(curl *), Bash(node *), Bash(jq *), Bash(mv *), Bash(date *), Read, Write, Edit, AskUserQuestion, Agent
---

# feature-acceptance — verify the feature against its PRD contract

Runs after `update-docs`, before `commit`. Single responsibility: verify every `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]` the PRD declared, using either autonomous agent-driven checks or a manual operator-driven checklist. Writes `STEP_<NN>_FEATURE_ACCEPTANCE` to `workflow.json`.

The old `verification-before-completion` phases (blast-radius coverage + mutation testing) are deleted — those responsibilities moved to `fix-findings` (§11 of the design spec) and `code-review` (§10) respectively.

Output contract: `../../README.md` §"Skill output contract". One confirmation line on success.

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
NN=$(jq '.steps | length + 1' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_FEATURE_ACCEPTANCE"
```

## Phase 1 — Operator prompt (ALWAYS, even in autonomous flow-mode)

This skill's internal mode is distinct from the flow-level `config.mode`. ALWAYS prompt:

```
AskUserQuestion:
  Mode for feature acceptance?
    (a) autonomous — I verify each AC/NFR/metric programmatically
    (b) manual — I present the checklist + how-to-verify; you verify out-of-band and reply with results
```

Record operator choice in the step payload's `mode` field.

## Phase 2 — Run verification

### 2a — Autonomous path

For each AC in `prd.acceptanceCriteria[]`:

1. **Derive verification method** from the AC description + its `bindsTo[]` functional requirements:
   - **Testable** → run a scoped `pnpm test --filter=<pkg>` (or equivalent) matching the AC. Parse pass/fail + specific test names.
   - **Inspectable** → dispatch an `Agent` (sonnet) to examine the code + return pass/fail with evidence (file paths, line ranges).
   - **Metric-gated** → measure via HTTP probe, Prometheus query, latency bench, etc. Compare to the target in the bound NFR or metric.
2. Record the verdict in `featureAcceptance.acceptanceCriteria[]`:
   ```jsonc
   { "id": "AC-1", "status": "verified|unverified|failed",
     "evidence": "pnpm --filter=@browzer/api test -- routes-auth passed 12/12",
     "method": "test|inspect|metric" }
   ```

For each NFR in `prd.nonFunctionalRequirements[]`:

- Run a category-specific check:
  - **perf** → run a bench (`pnpm bench` or `k6 run`), compare p50/p95 to `target`.
  - **security** → run `pnpm audit` + any invariant checks (`timingSafeEqual` usage, `getWorkspace(id, orgId)` scoping). Dispatch an Agent for deeper manual inspection when automated tooling is insufficient.
  - **a11y** → dispatch an axe-core or playwright a11y probe against the affected UI surface.
  - **observability** → verify the trace/metric the NFR called for is actually emitted (grep for the instrumented call, probe the endpoint, read Langfuse trace).
  - **scalability** → not typically automatable; dispatch an Agent to inspect the code's tenant scoping + resource allocation.
- Record in `featureAcceptance.nfrVerifications[]`:
  ```jsonc
  { "id": "NFR-1", "status": "verified|failed",
    "evidence": "p95 = 180ms at 100 RPS", "measured": "180ms", "target": "< 200ms" }
  ```

For each metric in `prd.successMetrics[]`:

- Measure (probe, query, CI artifact inspection) and compare to `target`.
- Record in `featureAcceptance.successMetrics[]`:
  ```jsonc
  { "id": "M-1", "measured": 42, "target": 40, "status": "met|unmet" }
  ```

### 2b — Operator action required (autonomous path)

When a verification requires an action the agent cannot take alone (deploy to staging, open a browser and click X, observe a human-in-the-loop signal), pause and append to `operatorActionsRequested[]`:

```jsonc
{ "at": "<ISO>", "description": "Deploy to staging and hit /api/health",
  "resolved": false, "resolution": null }
```

Emit to the operator:

```
feature-acceptance: paused at STEP_<NN>_FEATURE_ACCEPTANCE — operator action required
  <description>
  Reply with the result when done (pass/fail + evidence).
```

On operator reply, resolve the entry (`resolved: true` + `resolution` text) and resume verification.

### 2c — Manual path

Render the full AC / NFR / metric list with inline "how to verify":

```
## Feature acceptance checklist

### Acceptance criteria
  AC-1 (binds FR-1): <description>
    How to verify: <derived method>

  AC-2 (binds FR-2): <description>
    How to verify: <derived method>

### Non-functional requirements
  NFR-1 (perf): <description> — target <target>
    How to verify: run `<command>`, compare to target.

  NFR-2 (security): <description>
    How to verify: <specific invariant check>.

### Success metrics
  M-1: <metric> — target <target>, method <method>

Reply with pass/fail per item + evidence.
```

Record operator's replies into the same `acceptanceCriteria[]` / `nfrVerifications[]` / `successMetrics[]` arrays as the autonomous path.

## Phase 3 — Write STEP_<NN>_FEATURE_ACCEPTANCE to workflow.json

Assemble the `featureAcceptance` payload per schema §4:

```jsonc
{
  "mode": "autonomous|manual",
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
  [.featureAcceptance.nfrVerifications[] | select(.status!="verified")] +
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

The always-ask in Phase 1 fires regardless of `config.mode`. In addition, when `.config.mode == "review"`, flip `status` to `AWAITING_REVIEW` before the final write, render `../../references/renderers/feature-acceptance.jq` for the operator, and enter the gate loop (Approve / Adjust / Skip / Stop). Operator adjustments translate to jq ops on `.featureAcceptance.acceptanceCriteria[]` / `.nfrVerifications[]` / `.successMetrics[]` (e.g. "downgrade AC-2 to unverified — I haven't measured yet" → status flip + evidence blanking). Append each round to `reviewHistory[]`.

## Phase 4 — Verdict and one-line confirmation

### Success (all verified + met)

```
feature-acceptance: updated workflow.json <STEP_ID>; status COMPLETED; AC <n> NFR <m> M <k> all passed
```

### Failure (one or more failed)

```
feature-acceptance: stopped at <STEP_ID> — <F> checks failed (AC/NFR/metrics)
hint: re-enter fix-findings or execute-task for remediation; reinvoke feature-acceptance when ready
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
- `../../references/workflow-schema.md` — authoritative schema (`featureAcceptance`).
- `../../references/renderers/feature-acceptance.jq` — markdown renderer invoked in review mode.
- `references/mutation-runners.md` — historical reference (kept from the old skill); mutation now runs in `code-review`, not here.
