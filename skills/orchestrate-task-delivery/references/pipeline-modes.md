# Pipeline modes — `full` vs `inline-with-review`

Loaded by the orchestrator at INIT (to decide which mode to persist into
`staging/CONFIG.md`) and on the operator-override path (post-edit). Skip
on every iteration after CONFIG.md is settled.

## Modes

| Mode                 | Phases skipped                                            | When to use                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full` (default)     | none                                                      | Default for any feature with new behaviour, new functions, or non-trivial logic changes.                                                                                                     |
| `inline-with-review` | brainstorming, generate-prd, scope-feature, generate-task | Trivial features that don't earn the planning chain — see triggers below. ~50% wall-clock saving with review safety retained (code-review + receiving-code-review + write-tests still run). |

## Auto-select heuristic (only when `--mode` was not passed)

The orchestrator auto-selects `inline-with-review` when the brief
matches **either** the pure-deletion trigger OR the simple-add trigger.
Both compress the same way — the brief is the contract — because the
planning chain (PM → scoper → PO) cannot meaningfully add closure that
the brief itself does not already carry.

### Trigger 1 — pure deletion

- BRIEF.md (or the raw `$ARGUMENTS` prose) contains exclusively deletion
  vocabulary: "remove", "retire", "drop", "delete", "cleanup", "sunset",
  "deprecate".
- AND does NOT contain any of: "add", "implement", "introduce",
  "create", "build", "refactor to <X>", "migrate to <X>".
- AND the brief does NOT cite any new public symbol, route, env var, or
  schema field.

Trace bullet:

> `--note "pipeline-mode auto-selected: inline-with-review (pure deletion)"`

### Trigger 2 — simple add

- Brief names a single new route / handler / endpoint / function / flag
  / env var (one concrete artefact, NOT a multi-component refactor).
- AND brief names at most 2 target file paths (existing or new).
- AND brief does NOT mention sensitive-path keywords (`auth`, `billing`,
  `migrations`, `crypto`, `secret`, `tenant`, RBAC verbs) or
  cross-cutting concerns (schema migration, shared utility rename,
  multi-app coordination).
- AND brief does NOT request behavioural changes to existing public
  contracts (return shape changes, status-code changes, breaking renames).

Examples that fire the simple-add trigger:

- "Add a `GET /healthz` route to `apps/api` returning `{ok: true}`."
- "Add a `--limit` flag to `browzer search` that caps result count to N."
- "Expose a `BROWZER_DEBUG` env var that toggles verbose logs in the CLI."

Examples that DO NOT fire (`full` stays the default):

- "Add a billing webhook handler" — sensitive path.
- "Add a `/healthz` endpoint AND wire it into the gateway proxy AND add
  a Grafana panel" — multi-component.
- "Refactor session refresh to use atomic check+update" — behavioural
  change to existing contract.

Trace bullet:

> `--note "pipeline-mode auto-selected: inline-with-review (simple add)"`

### Conservative-by-design

When ANY signal is ambiguous (brief mixes deletion + add vocabulary,
touches a sensitive path keyword even peripherally, or names >2 files),
default to `full`. False negatives (a trivial feature incorrectly routed
through `full`) cost a few minutes; false positives (a non-trivial
feature routed inline) skip blast-radius probing and can ship a broken
change. The operator can always force `--mode inline-with-review` when
they know the heuristic is being conservative.

## Operator override

The operator may override post-hoc by editing
`staging/CONFIG.md.frontmatter.pipelineMode` and re-invoking the
orchestrator; the next iteration honours the persisted value.

## `inline-with-review` execution path

The state machine routes:

```
INIT → execute-task (inline, single dispatch with brief + scope inlined)
     → code-review
     → receiving-code-review
     → write-tests (optional — runs only when host has a detectable test runner)
     → update-docs
     → feature-acceptance
     → update-docs (final drift-catch, usually skipped for trivial features)
     → finalize-feature
     → commit
```

The single `execute-task` invocation receives a synthesised `TASK_01.md`
whose frontmatter inlines the operator's brief verbatim as
`acceptanceCriteria[].text` and `scope.files[]`:

- **Pure-deletion synthesis** — `scope.files[]` is the deletion target
  list; `invariants[]` is empty or carries `INVARIANT_RATIONALE:`
  sentinels; `trivial: false` (even pure deletions can trip blast-radius
  issues that demand a coder subagent).
- **Simple-add synthesis** — `scope.files[]` is the single new (or
  amended) file path inferred from the brief; `invariants[]` is empty
  (no sensitive scope, no public contract churn); `trivial: true` so
  `execute-task`'s inline fast-path runs without a coder subagent.

The brief is the contract; no PRD or EXPLORATION.md exists in this
mode. If the dispatched coder / reviewer / tester encounters work that
materially exceeds the brief's scope, the operator aborts and re-runs
with `--mode full` — the state machine re-detects from filesystem and
picks up where it can.
