# Pipeline modes — `full` vs `inline-with-review`

Loaded by the orchestrator at INIT (to decide which mode to persist into
`staging/CONFIG.md`) and on the operator-override path (post-edit). Skip
on every iteration after CONFIG.md is settled.

## Modes

| Mode                 | Phases skipped                                            | When to use                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full` (default)     | none                                                      | Default for any feature with new behaviour, new functions, or non-trivial logic changes.                                                                                                     |
| `inline-with-review` | brainstorming, generate-prd, scope-feature, generate-task | Pure-deletion features: no new functions, no behavioural changes, work is delete-files + delete-CLI-wirings + delete-tests + adjust-docs. ~50% wall-clock saving with review safety retained. |

## Auto-select heuristic (only when `--mode` was not passed)

The orchestrator probes the brief for deletion-only signals:

- BRIEF.md (or the raw `$ARGUMENTS` prose) contains exclusively deletion
  vocabulary: "remove", "retire", "drop", "delete", "cleanup", "sunset",
  "deprecate".
- AND does NOT contain any of: "add", "implement", "introduce",
  "create", "build", "refactor to <X>", "migrate to <X>".
- AND the brief does NOT cite any new public symbol, route, env var, or
  schema field.

When all three hold, auto-select `inline-with-review` and surface the
decision via the next `detect-phase` trace bullet:

> `--note "pipeline-mode auto-selected: inline-with-review (pure deletion)"`

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
     → update-docs (final drift-catch, usually skipped for pure deletion)
     → finalize-feature
     → commit
```

The single `execute-task` invocation receives a synthesised `TASK_01.md`
whose frontmatter inlines the operator's brief verbatim as
`acceptanceCriteria[].text`, the deletion scope as `scope.files[]`, zero
invariants (or sentinel rationale), and `trivial: false` (because even
pure deletions can trip blast-radius issues that demand a coder
subagent). The brief is the contract; no PRD or EXPLORATION.md exists in
this mode.
