---
name: execute-task
description: "Implement N tasks end-to-end by fanning out to domain-specialist subagents per each task's `task.explorer.skillsFound[]`. Specialists load project skills, write code scoped to `task.scope`, report gates + invariants, and report back. The execution strategy was already resolved by orchestrate-task-delivery (Phase 3) — execute-task only consumes it. Tests are NOT authored at this phase — `write-tests` runs after `code-review` + `receiving-code-review` close findings. Triggers: execute TASK_03, run the first task, implement task 02, ship TASK_N, run all tasks, build the feature from the plan."
argument-hint: "<featureId>"
---

You are a fan-out controller. For each task ID, dispatch one domain-specialist subagent and aggregate the result.

## Read context

```
!`browzer get-step CONFIG --id $ARGUMENTS`
!`browzer get-step TASKS --id $ARGUMENTS`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`. **Pass ONLY the feat-id** — the Skill arg becomes a literal shell substitution; extra tokens break the `--id` flag.

The TASKS manifest enumerates the per-task `stepId` values (`TASK_01`, `TASK_02`, …). For each one, load its detail with `browzer get-step TASK_<NN> --id $ARGUMENTS` (or `--json` for the structured `#StepView`). The TASK view is a two-part payload: structured frontmatter (`task.role`, `task.explorer.skillsFound[]`, `scope.files[]`, `scope.deps`, `task.doneWhen[]`) plus a markdown body (PRD slice, invariants from CLAUDE.md, deps narrative). Paste ONLY the markdown body verbatim into the specialist prompt. Do not synthesize a new prompt.

`executionStrategy` is loaded above from `browzer get-step CONFIG` (virtual phase reading `workflow.json#config.executionStrategy`); default `serial` when absent. It dictates how the dispatch loop runs:

| Strategy | Loop |
| -------- | ---- |
| `serial` | one task, await, next |
| `parallel` | all tasks in one response block |
| `parallel-worktrees` | one git worktree per task; one specialist per tree |
| `agent-teams` | per task: spawn N specialists (one per `skillsFound[]` entry) reviewing each other |

## Strategy dispatch

Branch on `executionStrategy` BEFORE entering the per-task dispatch contract below:

- **`serial`** — iterate `taskIds[]` in order. Run the per-task dispatch contract; await the specialist's `staging/TASK_NN.json` write before starting the next task.
- **`parallel`** — emit one Skill/Agent invocation per task in a single response block. Do NOT await individual results; aggregate when all return. Requires disjoint `scope.files[]` (enforced by `generate-task`).
- **`parallel-worktrees`** — same as `parallel`, but for each task first run `git worktree add /tmp/wt-<task-id> HEAD` and pass that path as the specialist's working directory. After the specialist's `staging/TASK_NN.json` lands, run `git worktree remove /tmp/wt-<task-id>` (use `--force` if the tree is dirty and the result has already been persisted).
- **`agent-teams`** — for each task, spawn N specialists in parallel (one per `task.explorer.skillsFound[]` entry). Designate the first entry as the lead; lead reviews peers' outputs, reconciles conflicts, and only then writes the final `staging/TASK_NN.json` flipping the task to COMPLETED.

Within each strategy branch, the per-task dispatch contract below applies unchanged.

## Dispatch contract

For each task:

1. Validate every name in `task.explorer.skillsFound[]` exists on disk (the available skills trees). If any is missing, abort the dispatch for that task with: `execute-task: TASK_NN aborted — unknown skill(s): <names>`.

2. **Plugin-agnosticism clause** (conditional): when `scope.files[]` includes any path matching `skills/*/SKILL.md` or `hooks/**`, prepend the following line to the specialist brief before the get-step blob:

   > Plugin agnosticism: this plugin is mirrored to a public repo. Do not introduce monorepo paths (no leading paths that are specific to this monorepo) in SKILL.md prose.

   When `scope.files[]` contains none of these patterns (e.g. `scope.files: ["apps/<app-name>/src/server.ts"]`), omit the line entirely.

3. Spawn the specialist with the get-step blob as the prompt body, prefixed by:

   ```
   You are a <task.role>. Implement TASK_NN per the brief below.
   Use the following skills: <task.explorer.skillsFound joined by comma>.
   Stay strictly inside scope.files[]. Run task.doneWhen[] before declaring success.

   <paste the get-step blob verbatim>
   ```

4. The specialist writes its result to `docs/browzer/<feat>/staging/TASK_NN.json`. The payload is the **execution slot only** — `agents[]`, `files{created,modified,deleted}`, `gates{baseline,postChange,regression}`, `invariantsChecked[]`, `nextSteps`, `scopeAdjustments[]`.

   > Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

   Follow the scaffold exactly, including optional fields like `testsRan` and `fileEditsSummary` when they apply. Do not add a `taskId` wrapper, do not include the full task body — `save-step` takes the phase as a positional argument, locates the matching TASK step by stepId, sets `task.execution` from the staged payload, and flips status to COMPLETED.

5. **Optional — render per-task blast radius**: after the specialist writes `staging/TASK_NN.json`, if `scope.files[]` is non-empty, run the blast-radius script as a best-effort background step:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT:-.}/skills/code-review/scripts/render-dep-graph.mjs" \
     --files "<scope.files[] joined by comma>" \
     --out docs/browzer/$ARGUMENTS/staging/DEP_GRAPH.TASK_NN.mmd
   ```

   The script is co-located with the `code-review` skill (it is the primary consumer); `execute-task` invokes it opportunistically.

   Skip this step if `scope.files[]` is empty, or if the script is not present. On failure (non-zero exit or missing output file), log a warning to stderr and continue — do not block task completion.

6. The autosave hook validates and persists each TASK_NN execution slot. It triggers automatically immediately after each `staging/TASK_NN.json` is written, validates the payload against the workflow schema, and persists into `workflow.json` via `browzer save-step TASK_NN --id <feat>`. On failure it writes a one-line `[autosave]` error to stderr and exits non-zero; the specialist must re-write to retry (the operation is idempotent). Specialists do NOT invoke the hook explicitly.

## Persistence

The autosave hook persists each `staging/TASK_NN.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --async` — TASK_NN execution slots are non-load-bearing: the next phase (`code-review`) does not read individual TASK_NN results back immediately.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- Every `taskIds[]` argument has either:
  - A corresponding `staging/TASK_NN.json` written, OR
  - Been aborted with a clear error message to the operator (the abortion + reason recorded under the aggregated `<M> blocked` count in the return line).

Return one line: `execute-task: <N> tasks completed; <M> blocked`.
