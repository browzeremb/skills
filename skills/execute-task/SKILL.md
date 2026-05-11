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

## Pre-flight: receipts mode

Before entering the per-task dispatch contract, run a one-shot pre-flight to determine whether blast-radius receipts are mandatory or best-effort for this run:

```bash
# Pre-flight: verify browzer is reachable + workspace is indexed
if ! browzer status --json >/dev/null 2>&1; then
  echo "[execute-task] WARNING: browzer not reachable or workspace not initialized; degrading blast-radius receipts to best-effort for this run"
  RECEIPTS_MODE=best-effort
else
  RECEIPTS_MODE=mandatory
fi
```

- `RECEIPTS_MODE=mandatory` (default): per-file receipt failures are task-level blockers per the exit-code matrix in step 5 below.
- `RECEIPTS_MODE=best-effort`: receipts SHOULD still be attempted, but a missing receipt does NOT block the task. Surface each miss as a warning and add a `nextSteps` entry pointing the operator at `use-rag-cli` (install/login) and `embed-workspace-graphs` (run `browzer init`) to repair their browzer setup.

## Dispatch contract

For each task:

1. Validate every name in `task.explorer.skillsFound[]` exists on disk (the available skills trees). If any is missing, abort the dispatch for that task with: `execute-task: TASK_NN aborted — unknown skill(s): <names>`.

2. **Plugin-agnosticism clause** (conditional): when `scope.files[]` includes any path matching `skills/*/SKILL.md` or `hooks/**`, prepend the following line to the specialist brief before the get-step blob:

   > Plugin agnosticism: this plugin is mirrored to a public repo. Do not introduce monorepo paths (no leading paths that are specific to this monorepo) in SKILL.md prose.

   When `scope.files[]` contains none of these patterns (e.g. `scope.files: ["apps/<app-name>/src/server.ts"]`), omit the line entirely.

3. Determine dispatch parameters, then spawn the specialist:

   **Model:** use `task.suggestedModel` when present in the TASK view. Default `sonnet`.

   **Effort** (map from `scope[]` file count):
   | scope[] count | effort |
   |---|---|
   | 1 file | `medium` |
   | 2–5 files | `high` |
   | 6–15 files | `xhigh` |
   | >15 files | `max` |

   Spawn using `subagent_type: browzer:coder`, passing the resolved model and effort:

   ```
   You are a <task.role>. Implement TASK_NN per the brief below.
   Invoke each of the following skills via `Skill(skill: '<name>')` before writing code: <task.explorer.skillsFound joined by comma>. Skills listed here are required context loaders, not annotations — do not skip them.
   Stay strictly inside scope.files[]. Run task.doneWhen[] before declaring success.

   Before writing any code, run `browzer explore '<type or enum name> runtime shape'` for each TypeScript type or interface used in mocks. Compare the result against any mock definitions in the codebase. If mocks use `as unknown as <T>`, treat this as a red flag and investigate the actual API response shape before proceeding.

   <paste the get-step blob verbatim>
   ```

4. The specialist writes its result to `docs/browzer/<feat>/staging/TASK_NN.json`. The payload is the **execution slot only** — `agents[]`, `files{created,modified,deleted}`, `gates{baseline,postChange,regression}`, `invariantsChecked[]`, `nextSteps`, `scopeAdjustments[]`.

   > Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

   Follow the scaffold exactly, including optional fields like `testsRan` and `fileEditsSummary` when they apply. Do not add a `taskId` wrapper, do not include the full task body — `save-step` takes the phase as a positional argument, locates the matching TASK step by stepId, sets `task.execution` from the staged payload, and flips status to COMPLETED.

5. **Blast-radius receipts (mandatory)**: before the task is considered complete, the specialist MUST produce a reverse-dependency receipt for EVERY file in `scope.files[]`. For each file, run:

   ```bash
   SANITIZED=$(echo "<file>" | tr '/' '_')
   browzer deps "<file>" --reverse --json --save "/tmp/rdeps-${SANITIZED}.json"
   ```

   When `RECEIPTS_MODE=mandatory`, a non-zero exit code OR a missing output file is a TASK-LEVEL ERROR per the exit-code decision matrix below. When `RECEIPTS_MODE=best-effort`, a missing receipt is a warning + `nextSteps` follow-up — never a block.

   **Exit-code decision matrix** (applies in `mandatory` mode; in `best-effort` mode, log + continue):

   | Exit | Meaning | Action |
   | ---- | ------- | ------ |
   | 0 | OK + receipt written | Continue. |
   | 2 | Unauthenticated | Task BLOCKED. Surface under `nextSteps` with handoff to the `use-rag-cli` skill so the operator can re-auth (`browzer login`). |
   | 3 / `not found` | File not yet in the workspace index | Fall back: `browzer sync && browzer deps "<file>" --reverse --json --save "/tmp/rdeps-${SANITIZED}.json"`. If the file is outside the workspace root, or was generated post-init (e.g. build artefacts, generated code), record a SKIP with rationale under `nextSteps` — do NOT block the task. |
   | 4 | Workspace not initialized | Task BLOCKED. Surface under `nextSteps` with handoff to the `embed-workspace-graphs` skill so the operator can run `browzer init`. |
   | 5 | Backend down / unreachable | NOT a task fault. Mark the task `DEFERRED-INFRA` (NOT `BLOCKED`) and surface an operator-handoff `nextSteps` entry describing the backend outage. The orchestrator decides whether to retry. |
   | other non-zero | Unknown failure | Task BLOCKED. Record the offending file path + raw exit code under `nextSteps` and surface to the orchestrator. |

   For any BLOCKED outcome, do not flip the task to COMPLETED. For SKIP and DEFERRED-INFRA, the task may still complete provided every other receipt obligation is satisfied.

   **Additional best-effort rendering** (does NOT replace the receipts above): when `scope.files[]` is non-empty, the specialist MAY also render a Mermaid graph for `code-review` consumption:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT:-.}/skills/code-review/scripts/render-dep-graph.mjs" \
     --files "<scope.files[] joined by comma>" \
     --out docs/browzer/$ARGUMENTS/staging/DEP_GRAPH.TASK_NN.mmd
   ```

   This Mermaid render is best-effort: if the script is missing or exits non-zero, log a warning and continue. The JSON receipts above remain non-negotiable.

6. The autosave hook validates and persists each TASK_NN execution slot. It triggers automatically immediately after each `staging/TASK_NN.json` is written, validates the payload against the workflow schema, and persists into `workflow.json` via `browzer save-step TASK_NN --id <feat>`. On failure it writes a one-line `[autosave]` error to stderr and exits non-zero; the specialist must re-write to retry (the operation is idempotent). Specialists do NOT invoke the hook explicitly.

   **CLI surface** (for manual recovery or verification): `browzer save-step TASK_01 --id <feat> --from <staging-path>` — `TASK_NN` is the positional phase argument; there is NO `--task-id` flag.

   **TASK-phase lifecycle contract**: a TASK step is not considered done until its `status` in `workflow.json` has transitioned from `PENDING` to `COMPLETED`. This transition happens exclusively through the autosave path above — the specialist writes `staging/TASK_NN.json`, the hook calls `browzer save-step TASK_NN --id <feat>`, and the CLI flips the status atomically. Any TASK step whose status remains `PENDING` (or `IN_PROGRESS`) after the specialist returns is a **contract violation**: the staging file was either never written, written with an invalid payload that failed CUE validation, or the autosave hook did not fire. `feature-acceptance` enforces this precondition and will halt with a named error for every offending task before beginning its acceptance run.

   **Post-dispatch verify**: after the specialist writes `staging/TASK_NN.json` and the autosave hook is expected to have fired, run:

   ```bash
   browzer get-step TASK_NN --id <feat> --json
   ```

   Assert that `status === "COMPLETED"`. If the status is still `PENDING` or `IN_PROGRESS` after a brief retry (allow ~15s for the async autosave hook), log the failure mode — staging file missing, CUE validation error (surfaced in the autosave stderr), or hook did not fire — and surface it to the operator via a `nextSteps` entry rather than silently continuing. Do not wait until `feature-acceptance` to detect a stuck task.

## Persistence

The autosave hook persists each `staging/TASK_NN.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --async` — TASK_NN execution slots are non-load-bearing: the next phase (`code-review`) does not read individual TASK_NN results back immediately.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- Every `taskIds[]` argument has either:
  - A corresponding `staging/TASK_NN.json` written, OR
  - Been aborted with a clear error message to the operator (the abortion + reason recorded under the aggregated `<M> blocked` count in the return line).
- When `RECEIPTS_MODE=mandatory`: every file in `scope[]` (across all completed tasks) has a corresponding `/tmp/rdeps-<sanitized-path>.json` receipt produced via `browzer deps "<file>" --reverse --json --save ...`, OR is recorded as a documented SKIP / DEFERRED-INFRA per the exit-code matrix. Tasks with any unresolved BLOCKED receipt are counted as blocked, not completed.
- When `RECEIPTS_MODE=best-effort`: receipts are attempted but missing ones do not block. Each miss is recorded under `nextSteps` so the operator can repair their browzer setup.

Return one line: `execute-task: <N> tasks completed; <M> blocked`.

Your turn is incomplete until `docs/browzer/<feat>/staging/TASK_NN.json` exists on disk for every dispatched task. Do not stop to summarize or investigate further after writing it.
