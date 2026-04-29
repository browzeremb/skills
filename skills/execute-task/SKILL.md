---
name: execute-task
description: "Implement one task end-to-end by dispatching domain specialists per its `task.explorer.skillsFound[]`. Each specialist loads project skills first, writes code scoped to `task.scope`, reports gates + invariants, and aggregates into `task.execution`. For free-form requests without a plan, calls `generate-task` first. Tests are NOT authored at this phase — they're written after `code-review` + `receiving-code-review` by the `write-tests` skill. Triggers: execute TASK_03, run the first task, implement task 02, do this task, ship TASK_N, build the feature from the plan, 'implement this'."
argument-hint: "[TASK_N | task-number | feat dir: <path> | free-form task description]"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(jq *), Bash(mv *), Bash(date *), Bash, Read, Edit, Write, Glob, Grep, Agent
---

# execute-task — run one task end-to-end

Step 3 of the workflow. Picks one task from `workflow.json` and implements it end-to-end by dispatching specialist agents per the `task.explorer.skillsFound[]` domains that `generate-task` discovered.

Tests are **not** authored at this phase. The pipeline writes tests AFTER `code-review` + `receiving-code-review` close findings — `write-tests` runs against the final post-fix state and runs Stryker/mutmut/go-mutesting in the same pass.

You are the **orchestrator**. You read, plan, dispatch, review, verify. You don't write application code. Your only writes (if any) are trivial integration glue (<15 lines: barrel export, one-line import, config key).

`workflow.json` is the canonical state. You read task steps via `jq` and write `.task.execution` fields via `browzer workflow *` CLI subcommands — never via `Read`/`Write`/`Edit`.

---

## References router

| Reference | Load when |
|-----------|-----------|
| `references/dispatch-pattern.md` | Dispatching domain-specialist agents (Phase 2), using the per-domain template, deciding parallel vs serial, applying isolation rules, or assembling the Phase 3 aggregate execution payload. |
| `references/subagent-preamble.md` | Paste §Step 0-5 verbatim into every dispatched agent prompt. |
| `references/workflow-schema.md` | Any jq filter against `workflow.json` — authoritative schema. |

---

## Phase 0 — Resolve the input

Skill is invoked with one of:

1. `TASK_N — feat dir: <path>` — preferred. Bind `FEAT_DIR` directly.
2. `TASK_N` or plain number, no path — look up `FEAT_DIR` from chat context or `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -3` and ask.
3. Free-form description — call `generate-task` first, then re-enter with `TASK_01`.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`. Derive `STEP_ID`:

```bash
STEP_ID=$(jq -r --arg tid "TASK_01" '.steps[] | select(.taskId==$tid) | .stepId' "$WORKFLOW")
```

Read task context and lifecycle flags:

```bash
TASK_CONTEXT=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --render execute-task)
TASK_STATUS=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field status)
SUGGESTED_MODEL=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field task.suggestedModel)
TRIVIAL=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field task.trivial)
```

Flip to `RUNNING`:

```bash
browzer workflow set-status --await "$STEP_ID" RUNNING --workflow "$WORKFLOW"
browzer workflow set-current-step --await "$STEP_ID" --workflow "$WORKFLOW"
```

State to user: `**Executing TASK_N — [title].** Skills: <list>. Suggested model: <haiku/sonnet/opus>.`

---

## Phase 1 — Discover repo shape

Read whichever manifest exists (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `CLAUDE.md`/`AGENTS.md`). The task step typically already carries gate commands via `task.explorer` + `task.invariants` — prefer those.

**Sibling-task file staleness**: when executing `TASK_N+K` (K ≥ 1) and any prior sibling task edited a file you're about to touch, line ranges are stale. Subagent prompt MUST include `anchor by content match, not line number`.

---

## Phase 2 — Dispatch domain specialists

Load `references/dispatch-pattern.md` for the full per-domain template, parallel/serial decision rules, isolation requirements, and trivial inline path details.

Key rules:
- No test authoring. Specialists ship working code + lint/typecheck gates only.
- Independent domains → dispatch in parallel, one response turn, multiple `Agent(...)` calls.
- Dependent domains → serialize: A first, then B with A's agents[] entry available.
- `isolation: "worktree"` mandatory when parallel agents touch overlapping files or shared config.

---

## Phase 3 — Aggregate and mark COMPLETED

Load `references/dispatch-pattern.md` §Phase 3 for the full `.task.execution` JSON shape.

Write execution payload and flip to COMPLETED:

```bash
browzer workflow complete-step --await "$STEP_ID" --workflow "$WORKFLOW"
```

**Regression-diff contract gate** (from `references/subagent-preamble.md` §Step 2.5): any step that captured `gates.baseline` MUST have populated `gates.regression`:

```bash
source references/jq-helpers.sh
validate_regression "$STEP_ID" || {
  browzer workflow set-status --await "$STEP_ID" STOPPED --workflow "$WORKFLOW"
  browzer workflow patch --workflow "$WORKFLOW" --jq \
    --arg id "$STEP_ID" \
    '(.steps[] | select(.stepId==$id)).stopReason = "regression-diff-contract-failed"'
  exit 1
}
```

---

## Phase 4 — Completion (one line)

On success:

```
execute-task: updated workflow.json $STEP_ID; status COMPLETED; files <created>/<modified>
```

On failure:

```
execute-task: stopped at $STEP_ID — <one-line cause>
hint: <single actionable next step>
```

## Banned dispatch-prompt patterns

- Subagents table, files list, skills loaded, invariants enforced in chat output.
- Baseline-vs-post-change comparison table printed to chat.
- "Next steps" block in chat — all data lives in `.task.execution` inside `workflow.json`.
- Announcing N parallel agents without emitting N literal `Agent(...)` calls in the same message.
- Editing an application file directly (unless trivial inline path applies per `references/dispatch-pattern.md`).

---

## Phase 5 — Hand-off

You do NOT invoke `code-review`, `update-docs`, `feature-acceptance`, or `commit`. The orchestrator (`orchestrate-task-delivery`) schedules those phases after `execute-task` returns.

---

## Orchestrator anti-patterns (self-check before every message)

- [ ] About to edit an application file? → **Stop, dispatch a subagent** (unless trivial inline path applies).
- [ ] Announced N parallel agents? → Count `Agent()` calls in this message. Must equal N.
- [ ] Parallel agents touching overlapping files? → Add `isolation: "worktree"` to each.
- [ ] Gate failed? → **Dispatch fix agent**, don't fix inline.
- [ ] About to guess library/config shape? → Run `browzer search` first, then Context7 if needed.
- [ ] Verified every applicable repo invariant in subagent's diff against quoted rules?
- [ ] Editing CLAUDE.md / README.md / AGENTS.md? → **Stop. That's `update-docs`'s job.**
- [ ] About to `Read` or `Write` `workflow.json` directly? → **Stop.** Use `browzer workflow *` only.

---

## Non-negotiables

- **Output language: English.** `.task.execution` fields and the one-line completion line are English.
- No application code by orchestrator (except ≤15-line integration glue).
- No silent skips of baseline capture or post-change verification.
- No inline fixes of failed gates.
- No parallel edits of same file without worktree isolation.
- No repo invariant left unchecked when its area was touched.
- No doc updates from this skill — `update-docs` owns that phase.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands.

## Invocation modes

- **Via `orchestrate-task-delivery`:** called once `generate-task` emits the manifest. Per-task: execute-task → (eventually) code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit.
- **Standalone:** `/execute-task TASK_N` or "implement TASK_03" — prefer `TASK_N — feat dir: <path>`. If no task step exists, call `generate-task` first; if PRD also missing, start from `generate-prd`.
