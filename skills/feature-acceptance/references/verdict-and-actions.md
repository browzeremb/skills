# Verdict computation + operator-actions reference

Schema-mapping detail factored out of `SKILL.md` to keep the body under
the per-skill line cap. Phases 3 and 4 of `feature-acceptance` rely on
the rules below.

## Verdict computation

Compute the verdict from four counters: `FAILED`, `UNVERIFIED`,
`BLOCKS_COMMIT`, `PENDING_DEFERRED`.

- `FAILED > 0` → `status: "STOPPED"`
- `FAILED == 0 && BLOCKS_COMMIT > 0` → `status: "STOPPED"` — commit
  MUST NOT run; entries with `kind: "blocks-commit"` are pre-commit
  blockers, not post-merge follow-ups.
- `FAILED == 0 && BLOCKS_COMMIT == 0 && PENDING_DEFERRED > 0` →
  `status: "PAUSED_PENDING_OPERATOR"` — commit still runs.
- `FAILED == 0 && BLOCKS_COMMIT == 0 && UNVERIFIED == 0 &&
  PENDING_DEFERRED == 0` → `status: "COMPLETED"`.

### step.status mirrors verdict — invariant

The `verdict` and `step.status` fields encode the SAME outcome but use
DIFFERENT case conventions per the CUE schema (`workflow-v1.cue`):

- `verdict` (lives at `.featureAcceptance.verdict`) — **lowercase
  hyphenated**: `"completed" | "stopped" | "paused-pending-operator"`
  (see `#FeatureAcceptance.verdict`).
- `step.status` (lives at the step level) — **uppercase underscored**:
  `"COMPLETED" | "STOPPED" | "PAUSED_PENDING_OPERATOR"` (see
  `#StepStatus`).

The two MUST always agree under the case-shift mapping
(`verdict.replace('-', '_').toUpperCase() === step.status`). For
example: `verdict: "paused-pending-operator"` mirrors
`step.status: "PAUSED_PENDING_OPERATOR"` (NOT `"COMPLETED"`); writing
the latter combination is a schema violation. Downstream skills
(commit, sync-workspace) read `step.status` when deciding whether to
fire. Always update both fields in the same `browzer workflow patch`
call:

```bash
browzer workflow patch --await --workflow "$WORKFLOW" \
  --arg "v=paused-pending-operator" \
  --arg "s=PAUSED_PENDING_OPERATOR" \
  --jq '(.steps[] | select(.name=="FEATURE_ACCEPTANCE")).status = $s | (.steps[] | select(.name=="FEATURE_ACCEPTANCE")).featureAcceptance.verdict = $v'
```

## `operatorActionsRequested[].kind` enum (canonical)

| `kind` | Semantics | Blocks `commit`? |
| --- | --- | --- |
| `manual-verification` | Operator runs an out-of-band check (smoke harness, browser inspection). Result feeds back into the same AC array. | NO (commit proceeds; AC stays `unverified` until operator replies) |
| `blocks-commit` | An execution-required AC could not be locally verified. Operator MUST resolve before commit fires. | YES |
| `deferred-post-merge` | Verification is intrinsically post-deploy (canary metrics, production probe, soak window). | NO |
| `deferred-follow-up` | Non-blocking follow-up tracked outside this commit (cleanup PR in 2 weeks, etc.). | NO |
| `inherited-scope-adjustment` | Carried in from `task.execution.scopeAdjustments[]`. | NO |

### Rename note (migration window)

The previous enum used `kind: "deferred-pre-commit"` for the
"blocks-commit" semantics. That label collided with git's `pre-commit`
hook concept and confused operators reading the audit trail. The new
name `blocks-commit` is unambiguous. During the migration window the
audit script accepts EITHER name; new writes MUST use `blocks-commit`.
A one-shot migration:

```bash
jq '(.steps[] | select(.name=="FEATURE_ACCEPTANCE")
   | .featureAcceptance.operatorActionsRequested[]
   | select(.kind=="deferred-pre-commit")).kind = "blocks-commit"' \
  workflow.json
```

### Banned mapping

Do NOT mark a deferred-post-merge AC as `status: "verified"` with
`method: "operator-deferral"`. Use `status: "unverified"` + an
`operatorActionsRequested[]` entry with the appropriate `kind` from
the enum above.

## Banned diagnostic patterns

The following are diagnostic-only — useful when actively debugging
the CLI itself, NEVER on a production orchestrator run:

- `browzer workflow ... --help` — flag enumeration. Operators reading
  the SKILL.md already have the verb table.

`browzer workflow describe-step-type <NAME>` is **NOT banned** — it is
the AUTHORITATIVE live source for step shape, derived directly from
the CUE SSOT (`packages/cli/schemas/workflow-v1.cue`) at runtime.
Skills SHOULD invoke it (with `--save /tmp/<feat>/.schema-cache/<NAME>.json`
to keep the JSON out of the chat) instead of pattern-matching against
markdown reference files. The bug that previously made
`describe-step-type` report `?` optional fields as required was fixed
2026-05-06 (WF-OPTIONAL-MARKER); rely on its output for required vs
optional and for parent-vs-element rows on arrays/structs.

Production orchestrator runs MUST go straight to the canonical recipe
in `SKILL.md` Phase 3 without exploratory `--help` round-trips — those
waste turns and pollute the trace.
