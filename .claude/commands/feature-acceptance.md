---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics — autonomous mode (agent runs every check) or manual mode (operator runs a how-to-verify checklist out of band). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(curl *), Bash(node *), Bash(jq *), Bash(mv *), Bash(date *), Bash(source *), Bash(ls *), Bash(test *), Bash(grep *), Read, Write, Edit, AskUserQuestion, Agent
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
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
# Helpers used: start_step, clarification_audit, verify_acceptance,
#               seed_step, complete_step, append_review_history,
#               bump_completed_count, validate_regression
```

---

## References router

| Topic | Reference |
| --- | --- |
| Phase 1.5 live-verify probe + Phase 2.6 anti-soft-override regex + 2.7 checklist template | `references/live-verify.md` |
| workflow.json schema (`featureAcceptance` payload, verdict computation) | `references/workflow-schema.md` |
| Review-mode renderer | `references/renderers/feature-acceptance.jq` |
| Legacy mutation reference (mutation now runs in code-review) | `references/mutation-runners.md` |

---

## Banned dispatch-prompt patterns

The following patterns are BANNED in any subagent or assistant message this
skill emits:

- `Read docs/browzer/<feat>/<doc>` — use `browzer workflow get-step` or
  `browzer workflow query` instead.
- `Read $WORKFLOW` — use `browzer workflow get-step --field <jqpath>`.
- Inline `jq ... > tmp && mv tmp workflow.json` for state mutations — use the
  `jq-helpers.sh` helpers sourced at the top.
- Ad-hoc lists of per-package CLAUDE.md read instructions — defer to browzer
  explore/search.

---

## Phase 0 — Resolve input

Bind `FEAT_DIR` from args or newest `docs/browzer/feat-*/`. Set
`WORKFLOW="$FEAT_DIR/workflow.json"`.

Read the PRD acceptance contract via browzer workflow:

```bash
AC=$(browzer workflow get-step PRD --field '.prd.acceptanceCriteria' --workflow "$WORKFLOW")
NFR=$(browzer workflow get-step PRD --field '.prd.nonFunctionalRequirements' --workflow "$WORKFLOW")
METRICS=$(browzer workflow get-step PRD --field '.prd.successMetrics' --workflow "$WORKFLOW")
TASK_EXECUTIONS=$(browzer workflow query task-executions --workflow "$WORKFLOW")
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

---

## Phase 1 — Operator prompt (ALWAYS, even in autonomous flow-mode)

This skill's internal mode is distinct from the flow-level `config.mode`.
ALWAYS prompt via `AskUserQuestion`:

```
Mode for feature acceptance?
  (a) autonomous — I verify each AC/NFR/metric programmatically
  (b) manual — I present the checklist + how-to-verify; you verify out-of-band and reply with results
  (c) hybrid — I verify everything I can programmatically AND emit a manual checklist for residual items
```

Record operator choice in the step payload's `mode` field. Normalize freeform
answers (e.g. "autonomous + manual, give me the screen paths") to `hybrid`.
Capture the literal phrasing in `featureAcceptance.modeNote`.

```bash
clarification_audit "Mode for feature acceptance?" "$OPERATOR_MODE" "normalized to $FINAL_MODE"
```

---

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

---

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

### 2.3 — Verification methods (per AC)

- **Testable** → scoped `pnpm test --filter=<pkg>`. Parse pass/fail + test names.
- **Inspectable** → dispatch an `Agent` (sonnet) to examine code; require file paths + line ranges.
- **Metric-gated** → HTTP probe / Prometheus query / latency bench; compare to NFR/metric target.

Record: `{ id, status: "verified|unverified|failed", evidence, method: "test|inspect|metric" }`.

### 2.4 — NFR check categories

| Category | Check |
| --- | --- |
| `perf` | `pnpm bench` or `k6 run`; compare p50/p95 to target. |
| `security` | `pnpm audit` + invariant checks (`timingSafeEqual`, `getWorkspace(id,orgId)` scoping). |
| `a11y` | Axe-core or Playwright a11y probe against affected UI surface. |
| `observability` | Grep for instrumented call, probe endpoint, read trace. |
| `scalability` | Dispatch Agent to inspect tenant scoping + resource allocation. |

Record: `{ id, status: "verified|partial|failed", coversAcceptanceSignal: "pass|warn|block", evidence, measured, target }`.

### 2.5 — Success metrics

For each metric in `prd.successMetrics[]`: probe/query/CI artefact, compare to
target, record as `{ id, measured, target, status: "met|unmet" }`.

### 2.6 — Operator-action gate

See `references/live-verify.md §Phase 2.6` for the full anti-soft-override
regex and action steps. This gate runs AFTER Phase 1.5 — ACs verified by the
live-verify probe bypass it.

See `references/live-verify.md §Phase 2.6.1` for AC-target relaxation protocol.

### 2.7 — Manual + hybrid checklist

See `references/live-verify.md §Phase 2.7` for the checklist template.

---

## Phase 3 — Write step to workflow.json

Assemble the `featureAcceptance` payload per `references/workflow-schema.md §4`:

```jsonc
{
  "mode": "autonomous|manual|hybrid",
  "modeNote": "string (optional)",
  "acceptanceCriteria": [...],
  "nfrVerifications": [...],
  "successMetrics": [...],
  "operatorActionsRequested": [...]
}
```

Compute verdict (`FAILED`, `UNVERIFIED`, `PENDING_DEFERRED` counts), then:

- `FAILED > 0` → `status: "STOPPED"`
- `FAILED == 0 && PENDING_DEFERRED > 0` → `status: "PAUSED_PENDING_OPERATOR"` (commit still runs)
- `FAILED == 0 && UNVERIFIED == 0 && PENDING_DEFERRED == 0` → `status: "COMPLETED"`

**Banned mapping:** do NOT mark a deferred-post-merge AC as `status: "verified"`
with `method: "operator-deferral"`. Use `status: "unverified"` + an
`operatorActionsRequested[]` entry with `kind: "deferred-post-merge"`.

Persist via helper (atomic rename):

```bash
complete_step "$STEP_ID" "$FA_PAYLOAD_JQ_EXPR"
bump_completed_count
```

### 3.1 — Review gate (when `config.mode == "review"`)

The always-ask in Phase 1 fires regardless. When `.config.mode == "review"`,
flip to `AWAITING_REVIEW`, render `references/renderers/feature-acceptance.jq`,
and enter the gate loop (Approve / Adjust / Skip / Stop). Append each round to
`reviewHistory[]` via `append_review_history`.

---

## Phase 4 — Verdict and one-line confirmation

Success:
```
feature-acceptance: updated workflow.json <STEP_ID>; status COMPLETED; AC <n> NFR <m> M <k> all passed
```

Paused:
```
feature-acceptance: updated workflow.json <STEP_ID>; status PAUSED_PENDING_OPERATOR; AC <n> NFR <m> M <k> verified; <P> deferred-post-merge actions pending
```

Failure:
```
feature-acceptance: stopped at <STEP_ID> — <F> checks failed (AC/NFR/metrics)
  failed: AC-3 (unverified), NFR-2 (failed: p95 measured 240ms, target <200ms)
hint: re-enter receiving-code-review or execute-task for remediation; reinvoke feature-acceptance when ready
```

When failure is an operator-reported staging regression, re-enter
`receiving-code-review` with `reason: "staging-regression"` and append to
existing `receivingCodeReview.dispatches[]` — NEVER to a sibling key.

**Banned from chat output:** full AC/NFR/metric tables, evidence blobs,
operator-action transcripts. All of that lives in the JSON.

---

## Non-negotiables

- **Output language: English.** JSON payload in English. Conversational wrapper follows operator's language.
- Phase 1 prompt ALWAYS fires, even in autonomous flow-mode.
- Do NOT apply fixes. If a criterion fails, stop and hint to `receiving-code-review` / `execute-task`.
- Do NOT run mutation testing here (moved to `code-review`).
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands or the `jq-helpers.sh` helpers. Never with `Read`/`Write`/`Edit`.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — phase 7 of the pipeline (after `update-docs`).
- **Standalone** — operator invokes after manual iteration. Re-invocation writes a new `FEATURE_ACCEPTANCE` step.

---

## Related skills and references

- `code-review` — runs BEFORE; mutation-testing + cyclomatic audit + team review.
- `receiving-code-review` — runs before; closes every code-review finding.
- `update-docs` — runs immediately before; ensures docs reflect final code state.
- `commit` — runs AFTER; blocks until `feature-acceptance` reaches COMPLETED.
- `references/live-verify.md` — Phase 1.5 probe, Phase 2.6 regex, Phase 2.7 checklist template.
- `references/workflow-schema.md` — authoritative schema (`featureAcceptance`).
- `references/renderers/feature-acceptance.jq` — markdown renderer for review mode.
- `references/mutation-runners.md` — historical reference (mutation now runs in `code-review`).
