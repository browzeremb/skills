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

The `step.status` field on the FEATURE_ACCEPTANCE step is the same
enum as the verdict above, and the two MUST always agree. Writing
`verdict: "PAUSED_PENDING_OPERATOR"` with `step.status: "COMPLETED"`
is a schema violation — the CUE validator rejects it on the next
mutation, and downstream skills (commit, sync-workspace) read
`step.status` when deciding whether to fire. Always update both fields
in the same `browzer workflow patch` call (`--jq '.steps[N].status =
$v | .steps[N].featureAcceptance.verdict = $v'`).

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
- `browzer workflow describe-step-type <NAME>` — schema introspection.
  The skill body inlines every required field; reach for
  `describe-step-type` only if you suspect the skill is stale vs the
  CUE SSOT.

Production orchestrator runs MUST go straight to the canonical recipe
in `SKILL.md` Phase 3 without an exploratory `--help` or
`describe-step-type` round-trip — those waste turns and pollute the
trace.
