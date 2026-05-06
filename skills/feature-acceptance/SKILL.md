---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics — autonomous mode (agent runs every check) or manual mode (operator runs a how-to-verify checklist out of band). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check."
argument-hint: "feat dir: <path>"
mutates:
  - path: steps[].featureAcceptance
    requires: [mode, acceptanceCriteria]
---

# feature-acceptance — verify the feature against its PRD contract

Runs after `update-docs`, before `commit`. Single responsibility: verify every
`acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]`
the PRD declared, using either autonomous agent-driven checks or a manual
operator-driven checklist. Writes `STEP_<NN>_FEATURE_ACCEPTANCE` to `workflow.json`.

Mutation testing belongs to `write-tests`. Blast-radius regression lives in
`code-review`'s regression-tester + `receiving-code-review`'s post-fix gates.
This skill is purely AC/NFR/metric verification.

Output contract: emit ONE confirmation line on success.

```bash
source "${CLAUDE_SKILL_DIR}/scripts/jq-helpers.sh"
# Helpers used: start_step, clarification_audit, verify_acceptance,
#               seed_step, complete_step, append_review_history,
#               bump_completed_count, validate_regression
```

## References router

- **Workflow CLI cheat-sheet (load FIRST):** `../orchestrate-task-delivery/references/pipeline-phases.md`
- Live-verify probe + anti-soft-override regexes + checklist: `references/live-verify.md`
- Phase 3 verdict + status mirror + operator-actions enum: `references/verdict-and-actions.md`
- Phase 2 verification methods (per-AC, NFR, metric, gate, checklist): `references/verification-methods.md`
- workflow.json schema (`featureAcceptance` payload): `references/workflow-schema.md`
- Review-mode renderer: `scripts/renderers/feature-acceptance.jq`
- Legacy mutation reference: `references/mutation-runners.md`
- Banned dispatch-prompt patterns: same as `code-review/SKILL.md` §Banned (no `Read $WORKFLOW`, no inline `jq | mv`, no ad-hoc per-package CLAUDE.md reads).

## Phase 0 — Resolve input

Bind `FEAT_DIR` from args or newest `docs/browzer/feat-*/`. Set
`WORKFLOW="$FEAT_DIR/workflow.json"`.

Read the PRD acceptance contract via browzer workflow:

```bash
AC=$(browzer workflow get-step PRD --field '.prd.acceptanceCriteria' --workflow "$WORKFLOW")
NFR=$(browzer workflow get-step PRD --field '.prd.nonFunctionalRequirements' --workflow "$WORKFLOW")
METRICS=$(browzer workflow get-step PRD --field '.prd.successMetrics' --workflow "$WORKFLOW")
```

If any of AC / NFR / METRICS is missing or empty, emit:

```
feature-acceptance: stopped at STEP_<NN>_FEATURE_ACCEPTANCE — PRD has no <AC|NFR|successMetrics>
hint: extend the PRD via generate-prd adjust flow, or mark the missing category "n/a" explicitly
```

Derive the step id and stamp `startedAt` BEFORE Phase 1 (per workflow-schema
§5.1 — `elapsedMin` must reflect total wall-clock including operator pause):

```bash
NN=$(browzer workflow next-step-number --workflow "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_FEATURE_ACCEPTANCE"
start_step "$STEP_ID"
```

## Phase 1 — Mode resolution (default: prompt; pre-registered path bypasses prompt)

This skill's internal mode is distinct from the flow-level `config.mode`. Resolve in this
order — only the third path renders the prompt.

### 1.0 — Pre-registered (skip prompt)

Invocation args may name the mode explicitly: `Skill(feature-acceptance, "mode: autonomous; …")`,
`mode: manual`, or `mode: hybrid`. When present, take the value verbatim, set
`featureAcceptance.preRegistered: true`, capture the literal phrasing in
`featureAcceptance.modeNote`, and skip the §1.1 prompt entirely. This mirrors the
`code-review.preRegistered` carve-out and is the only legitimate way to bypass the prompt
in autonomous flow-mode (orchestrate-task-delivery's wrapper uses this path so the
operator-acceptance prompt fires exactly once per pipeline, not once per skill entry).

### 1.1 — Prompt (default when not pre-registered)

When §1.0 yielded nothing, prompt via `AskUserQuestion`. The prompt fires regardless of
flow-level `config.mode` because the autonomous/manual/hybrid choice here is a
financial-cost-vs-trust decision the operator owns at acceptance time:

```
AskUserQuestion (header: "AC mode"):
  Mode for feature acceptance?
    (a) autonomous — I verify each AC/NFR/metric programmatically
    (b) manual — I present the checklist + how-to-verify; you verify out-of-band and reply with results
    (c) hybrid — I verify everything I can programmatically AND emit a manual checklist for residual items
```

Record operator choice in the step payload's `mode` field. Normalize freeform answers
(e.g. "autonomous + manual, give me the screen paths") to `hybrid`. Capture the literal
phrasing in `featureAcceptance.modeNote`. Set `featureAcceptance.preRegistered: false`.

```bash
clarification_audit "Mode for feature acceptance?" "$OPERATOR_MODE" "normalized to $FINAL_MODE"
```

## Phase 1.5 — Live-verify probe (autonomous mode)

See `references/live-verify.md §Phase 1.5` for the full probe sequence and
decision table. Summary:

1. Grep `package.json` scripts for `dev:local`, `e2e:smoke`, `dev:docker`, `test:env`.
2. Check `scripts/` for stack-up scripts.
3. Detect MCP browser tools (`mcp__claude-in-chrome__*`) and `agent-browser` skill.
4. Check Playwright installation.

When live-verify is possible AND `mode == autonomous`, dispatch a verification
subagent and record the result:

```bash
verify_acceptance "$STEP_ID" "AC-<n>" "<tool>" "<verified|failed|inconclusive>" "<evidence>"
```

Only defer to `operatorActionsRequested[]` when `outcome != "verified"`.

## Phase 2 — Run verification

All modes write into the same arrays in the step payload; they only differ in
**who** verifies.

### 2.1 — Modes

| Mode | What runs |
| --- | --- |
| `autonomous` | Agent verifies everything programmatically (tests / probes / invariant checks / Agent dispatches). |
| `manual` | Agent renders checklist (AC + NFR + metric, each with how-to-verify). Operator replies. |
| `hybrid` | Autonomous path first, then focused checklist for residual items. |

### 2.2 — Inherit deferred ACs from prior steps

Before classifying any AC, walk prior `task.execution.scopeAdjustments[]` and
auto-map deferred items to `operatorActionsRequested[]`:

```bash
DEFERRED=$(browzer workflow query deferred-scope-adjustments --workflow "$WORKFLOW")
```

For each entry append:
```jsonc
{ "ac": "<AC-id|null>", "kind": "inherited-scope-adjustment",
  "sourceStepId": "<stepId>", "description": "<adjustment verbatim>",
  "reason": "<reason verbatim>", "status": "pending", "at": "<ISO>", "resolved": false }
```

This runs BEFORE 2.3 so the AC list already has deferred entries marked.

### 2.3 – 2.7 — Verification methods, NFR categories, success metrics, gates, checklists

See `references/verification-methods.md`. It covers:

- §2.3 verification methods (testable / inspectable / metric-gated)
- §2.4 NFR check categories (`perf`, `security`, `a11y`, `observability`, `scalability`)
- §2.5 success-metrics record shape + the §2.5.1 anti-soft-override regex contract
- §2.6 operator-action gate
- §2.7 manual + hybrid checklist

## Phase 3 — Write step to workflow.json

Assemble the `featureAcceptance` payload per `references/workflow-schema.md §4`:

```jsonc
{
  "mode": "autonomous|manual|hybrid",
  "modeNote": "string (optional)",
  "executionRequiredProbe": false,
  "liveVerificationAttempt": false,
  "acceptanceCriteria": [
    { "id": "AC-1", "status": "verified", "evidence": "<test-id|inspect-note|metric-value>", "method": "test" }
  ],
  "nfrVerifications": [
    {
      "id": "NFR-1",
      "status": "verified",
      "coversAcceptanceSignal": "pass",
      "evidence": "<measurement source>",
      "measured": "180ms p95",
      "target":   "<200ms p95"
    }
  ],
  "successMetrics": [
    { "id": "M-1", "status": "met", "measured": "47", "target": "≥40" }
  ],
  "operatorActionsRequested": []
}
```

Both `target` AND `measured` are REQUIRED strings on every `nfrVerifications[]`
entry — the CUE schema rejects payloads where either is omitted. Numbers (e.g.
`240`) must be wrapped in a string (`"240ms"`) so the unit travels with the value.

Allowed enum literals:
- `mode`: `"autonomous" | "manual" | "hybrid"`
- `acceptanceCriteria[].status`: `"verified" | "unverified" | "failed"`
- `acceptanceCriteria[].method`: `"test" | "inspect" | "metric"`
- `nfrVerifications[].status`: `"verified" | "partial" | "failed"`
- `nfrVerifications[].coversAcceptanceSignal`: `"pass" | "warn" | "block"`
- `successMetrics[].status`: `"met" | "unmet"`
- `verdict` (top-level): `"completed" | "stopped" | "paused-pending-operator"`

The `featureAcceptance` payload MUST include:

- `executionRequiredProbe: bool` — true when at least one AC required code execution to verify (vs static review)
- `liveVerificationAttempt: bool` — true when the skill attempted live verification (running tests, hitting endpoints, querying APIs); false when only static review was performed

Both fields are mandatory in the CUE schema (TASK_01).

Compute the verdict from the four counters and persist it. Full
mapping table, the step.status MUST mirror the verdict invariant, the
`operatorActionsRequested[].kind` enum, the `deferred-pre-commit` →
`blocks-commit` rename note, the banned `operator-deferral` mapping,
and the banned diagnostic patterns all live in
`references/verdict-and-actions.md` — load it once at the start of
this phase.

Persist via helper (atomic rename):

```bash
complete_step "$STEP_ID" "$FA_PAYLOAD_JQ_EXPR"
bump_completed_count
```

The `complete_step` helper expands to the canonical recipe — never bypass it. For a NEW step, pick by AC + NFR + metric count:

**Recipe A (RECOMMENDED when AC + NFR + successMetrics + operatorActionsRequested combined ≥10 entries):** `Write` tempfile → `--payload <path>`. Each AC + NFR + metric carries verification evidence + measured value + status; large-feature acceptance steps reach 5-10k tokens of structured JSON. Inlining via `echo "$STEP_JSON"` competes with the subagent output budget and risks the moonbase 2026-05-06 mid-stream-death failure mode.

<!-- # samples-eval: skip — placeholder file path (`/tmp/<feat>/.step-feature-acceptance.json`) is runtime-only -->
```bash
# Use Write tool → /tmp/<feat>/.step-feature-acceptance.json, then:
browzer workflow append-step --await --workflow "$WORKFLOW" --payload "/tmp/<feat>/.step-feature-acceptance.json"
```

**Recipe B (small acceptance step, OR finalising a seeded step — common case for sub-orchestrator-driven runs):**

```bash
echo "$STEP_JSON" | browzer workflow append-step --await --workflow "$WORKFLOW"
# (or, when finalising an in-flight step seeded upstream)
browzer workflow complete-step --await "$STEP_ID" --workflow "$WORKFLOW"
```

### 3.1 — Review gate (when `config.mode == "review"`)

The always-ask in Phase 1 fires regardless. When `.config.mode == "review"`,
flip to `AWAITING_REVIEW`, render `scripts/renderers/feature-acceptance.jq`,
and enter the gate loop (Approve / Adjust / Skip / Stop). Append each round to
`reviewHistory[]` via `append_review_history`.

## Phase 4 — Verdict and one-line confirmation

Cursor shape per `../orchestrate-task-delivery/SKILL.md §5.4` and `../orchestrate-task-delivery/references/agent-dispatch-contract.md`. The orchestrator chains to `commit` when `verdict=APPROVED` and stops when `verdict=BLOCKED` — the cursor is the contract surface.

Verdict mapping:
- `APPROVED` — every AC `verified`, every NFR `verified` (or `partial` with `coversAcceptanceSignal: pass|warn`), every metric `met`. `deferredActions = operatorActionsRequested[].length` (0 when nothing pending; N>0 when operator-deferral entries are queued for post-merge follow-up — these never block commit).
- `BLOCKED` — any AC `failed|unverified`, any NFR `failed` (or `partial` with `coversAcceptanceSignal: block`), any metric `unmet`.

Success (everything passed, nothing deferred):
```
feature-acceptance: stepId=<STEP_ID>; status=COMPLETED; verdict=APPROVED; deferredActions=0
```

Approved with deferred operator actions (orchestrator still chains to `commit`; the deferred items belong to post-merge follow-up):
```
feature-acceptance: stepId=<STEP_ID>; status=PAUSED_PENDING_OPERATOR; verdict=APPROVED; deferredActions=<N>
```

Blocked (orchestrator stops; route is `receiving-code-review` or `execute-task` for remediation):
```
feature-acceptance: stopped at <STEP_ID> — verdict=BLOCKED; <F> checks failed
hint: re-enter receiving-code-review (for code findings) or execute-task (for missing scope); reinvoke feature-acceptance when ready
```

Phase 0 abort (PRD missing AC/NFR/metrics; can't compute verdict):
```
feature-acceptance: stopped at <STEP_ID> — PRD has no <AC|NFR|successMetrics>
hint: extend the PRD via generate-prd adjust flow, or mark the missing category "n/a" explicitly
```

When the failure is an operator-reported staging regression, re-enter
`receiving-code-review` with `reason: "staging-regression"` and append to
existing `receivingCodeReview.dispatches[]` — NEVER to a sibling key.

**Banned from chat output:** AC/NFR/metric tables, evidence blobs, the
`operatorActionsRequested[]` body, per-failure traces. All of that lives in
the JSON step at `featureAcceptance.{acceptanceCriteria,nfrVerifications,successMetrics,operatorActionsRequested}`.
Downstream skills consume it via `browzer workflow get-step <step-id> --field
.featureAcceptance.<path>` — they don't need the cursor to repeat it.

## Non-negotiables

- **Output language: English.** JSON payload in English. Conversational wrapper follows operator's language.
- Phase 1 prompt fires by default, with one explicit carve-out: pre-registered args (`Skill(feature-acceptance, "mode: <autonomous|manual|hybrid>; …")`) bypass the prompt and set `featureAcceptance.preRegistered: true`. This is the only legitimate skip path; "I assumed autonomous because the orchestrator was autonomous" without pre-registered args is a contract violation.
- Do NOT apply fixes. If a criterion fails, stop and hint to `receiving-code-review` / `execute-task`.
- Do NOT run mutation testing here (moved to `code-review`).
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands or the `jq-helpers.sh` helpers. Never with `Read`/`Write`/`Edit`.

## Invocation modes

- **Via `orchestrate-task-delivery`** — phase 7 of the pipeline (after `update-docs`).
- **Standalone** — operator invokes after manual iteration. Re-invocation writes a new `FEATURE_ACCEPTANCE` step.
