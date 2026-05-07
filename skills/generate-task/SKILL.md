---
name: generate-task
description: "Two-pass task decomposer that groups by DOMAIN, not by file. Explorer pass (haiku) maps files, dep graphs, domains, and skills-to-invoke per prospective task; Reviewer pass (sonnet default, opus for complex scopes) validates the mapping and enumerates test coverage targets per task. Reads the PRD from `browzer get-step PRD` and the resolved `executionStrategy` from `browzer get-step CONFIG` (virtual phase; the orchestrator seeds it via `workflow init --execution-strategy`). Triggers: break this PRD into tasks, generate tasks, plan the implementation, decompose this spec, task plan, task breakdown, sequence the work, split this into PRs, 'how should I sequence this'."
argument-hint: "<featureId>"
---

You are a task decomposer. Group work by DOMAIN, never one task per file.

## Read context

```
!`browzer get-step CONFIG --id $ARGUMENTS`
!`browzer get-step PRD --id $ARGUMENTS`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`. **Pass ONLY the feat-id** — the Skill arg becomes a literal shell substitution; extra tokens break the `--id` flag.

`get-step PRD` self-heals: if no PRD step is persisted yet but `staging/PRD.{md,json}` exists (e.g. autosave hook didn't fire), the CLI runs `save-step` from the staged file before returning. If neither exists, the skill exits `2 — generate-prd must run first`.

CONFIG carries `executionStrategy` (`serial | parallel | parallel-worktrees | agent-teams`) — already resolved by the orchestrator at `workflow init` time. Default `serial` when the field is absent. Honor it: `parallel*` strategies require non-overlapping `scope.files[]` across tasks; `serial` may share files across tasks.

## Domain grouping rules

One task per domain bucket. Files belong to exactly one bucket.

| Bucket | Match | Role |
| ------ | ----- | ---- |
| `cli` | every file under the CLI package | Go engineer |
| `skills/<X>` | files under the skill named `<X>` | Skill author (one task per `<X>`) |
| `apps/<app>` | files under `apps/<app>/**` | App-specific engineer (one task per app) |
| `packages/<pkg>` | files under shared library / utility packages | Package engineer (one task per package) |
| `infra` | monitoring configs, compose files, hook config | DevOps |
| `docs` | files under `docs/**` not part of `staging/` | Tech writer |

A single task may legitimately touch >10 files inside its bucket — that is the point. Splitting one bucket into two tasks needs an explicit reason recorded under `task.splitReason`.

### `scope.deps` field

`scope.deps` is an object with two arrays of normalized module identifiers (relative file paths like `./src/foo.ts` or package names like `lodash`):

- `forward` — modules this task's files import/use. Maps from `browzer deps <file>` `imports[]` output.
- `reverse` — modules that import/use this task's files (blast radius). Maps from `browzer deps --reverse <file>` `importedBy[]` output.

## Two-pass process

1. **Explorer pass** (haiku-class). For every PRD acceptance criterion: `browzer explore "<noun>" --save /tmp/tasks-explore-<noun>.json` → resolve owning files → assign each file to a bucket. Deduplicate. Build per-bucket dep graphs via `browzer deps <file> --save /tmp/tasks-deps-<file-slug>.json`. Attach each receipt path to the task it grounds.
2. **Reviewer pass** (sonnet, opus on bucket >25 files). Validate bucket assignments, enumerate test coverage targets, and attach skills to each task. The PRD's `skillsFound[]` is the source of truth (spec); `task.explorer.skillsFound[]` is the discovery result on each task. The Reviewer copies skills from the PRD onto each task that needs them, then cross-checks against what the Explorer pass surfaced — for any mismatch, validate the skill name exists on disk (the available skills trees); if missing, mark it as a gap and request a PRD update or add the missing skill file. Never invent a fictional skill.
3. **Granularity pass** (haiku-class). After bucket assignments are finalized, scan every task's `scope.files[]` count. Flag tasks with fewer than 2 files as `collapse` candidates and tasks with more than 10 files as `split` candidates. Emit all findings in `granularityWarnings[]` on the `TASKS_MANIFEST` — each entry cites the `taskId`, the `verdict` (`collapse` or `split`), and a one-sentence rationale. This field is CUE-admitted on the `TASKS_MANIFEST` step and surfaces for operator review before `execute-task` runs.

## Produce

Write `docs/browzer/<feat>/staging/TASKS.json` matching the **canonical scaffold** in `template.md` (auto-generated from the workflow CUE schema). The preferred shape is the full `#TasksManifest` object; a bare `[...#TaskBrief]` array is also accepted and auto-wrapped by `save-step`. Any field not present in `template.md`'s field reference is dropped on save.

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

## Persistence

The autosave hook persists `staging/TASKS.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — TASKS_MANIFEST is load-bearing: `execute-task` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- `docs/browzer/<feat>/staging/TASKS.json` exists and parses as either a `#TasksManifest` object or a bare `[...#TaskBrief]` array.
- Every `skillsFound[]` entry was verified on disk (the available skills trees).
- File overlap across tasks respects `executionStrategy` — `parallel*` strategies have disjoint `scope[]` (the per-task file list).
- When the granularity pass produced any findings, `TASKS_MANIFEST.granularityWarnings[]` is populated with `taskId`, `verdict` (`collapse` | `split`), and `rationale` for each flagged task.
- The autosave hook validates and persists. It calls `browzer save-step <PHASE> --id <feat> --from <staged-file>`, which CUE-validates and persists into `workflow.json` atomically. Failures arrive as a one-line stderr message; re-write the staging file to retry. If the hook does not fire (e.g. the file was authored via Bash heredoc), the next `browzer get-step <PHASE>` self-heals by running `save-step` from the staged file before returning.

Return one line: `generate-task: <N> tasks written; strategy=<executionStrategy>`.
