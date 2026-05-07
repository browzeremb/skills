---
name: generate-task
description: "Two-pass task decomposer that groups by DOMAIN, not by file. Explorer pass (haiku) maps files, dep graphs, domains, and skills-to-invoke per prospective task; Reviewer pass (sonnet default, opus for complex scopes) validates the mapping, enumerates test coverage targets per task, and rejects sensitive-scope tasks with empty invariants (FR-3, predicate at `references/sensitive-paths.md`). Reads the PRD from `browzer get-step PRD` and the resolved `executionStrategy` from `browzer get-step CONFIG` (virtual phase; the orchestrator seeds it via `workflow init --execution-strategy`). Triggers: break this PRD into tasks, generate tasks, plan the implementation, decompose this spec, task plan, task breakdown, sequence the work, split this into PRs, 'how should I sequence this'."
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

CONFIG carries `executionStrategy` (`serial | parallel | parallel-worktrees | agent-teams`) — already resolved by the orchestrator at `workflow init` time. Default `serial` when the field is absent. Honor it: `parallel*` strategies require non-overlapping `scope[]` across tasks; `serial` may share files across tasks.

> **Glossary note (scope naming):** the per-task file list is `task.scope[]` — a flat array of repo-relative paths. There is no `task.scope.files[]` field. Treat any prose referencing `scope.files[]` as legacy shorthand for `scope[]`.

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

   #### Sensitive-scope invariants gate (FR-3)

   Load the sensitive-path predicate from `../../references/sensitive-paths.md` (cross-skill shared reference; also consumed by `code-review`). The predicate is a logical OR over path globs (RBAC modules, translation catalogues), content-based mutation tokens introduced by the diff, and any operator-extended globs declared in the target repo's `.browzer/sensitive-paths.json`.

   If `.browzer/sensitive-paths.json` exists but fails to parse, fail-closed: treat the task as sensitive-scope and require `invariants[]` (or sentinel rationale) regardless of path-glob match.

   For each task in the manifest, evaluate:

   - Does ANY entry in `task.scope[]` match the predicate?
   - If yes AND `task.invariants[]` is empty AND no equivalent `invariantsRationale` is set ⇒ **REJECT the task plan** and re-prompt the Reviewer (or block manifest persistence — `save-step` should not be called until the task is resolved).

   Acceptable resolutions (the Reviewer MUST pick one before re-emitting the manifest):

   - **Resolution A — discover and populate invariants.** Run `browzer explore "<domain-term>"` and/or `browzer search "<topic>"` over the target repo, choosing the domain term from the matched glob (e.g. `permission` / `rbac` for `**/Permission*` matches, `i18n` / `translation` / `locale` for `**/locales/**` matches, `mutation` / the relevant mutation surface for content-based hits). Surface project conventions and add at least one entry to `task.invariants[]` carrying both `rule` (the convention, one line) and `source` (the concrete file path or doc that documents it). Abstract examples of the kind of rule worth capturing:
     - "RBAC: extend a single SSOT module rather than hardcoding strings in callers"
     - "i18n: dynamic translation keys (passed via variable) require comment-mark annotations or a build step deletes them"
     - "validation: mutations that take untrusted input MUST validate before persistence"
   - **Resolution B — record an explicit absence rationale via sentinel.** When the Reviewer's targeted `browzer explore` / `browzer search` finds no project rule that covers the scoped paths, attach a free-form rationale explaining the absence — e.g. `"target repo CLAUDE.md does not document i18n conventions and no equivalent SSOT module exists in the codebase"` or `"scope is a pure rename inside a translation file with no key additions or removals"`.

   **Schema note (out of scope for this skill change):** the workflow `TASK` schema currently exposes `invariants[]` (with `rule` + `source`) but does not yet expose a dedicated `invariantsRationale` string field. Until that field lands, encode Resolution B as a single `invariants[]` entry using a sentinel-prefixed rule:
   - `rule` MUST be `"INVARIANT_RATIONALE: <free text>"` (literal `INVARIANT_RATIONALE:` prefix, then the rationale prose).
   - `source` MUST be `"generate-task-reviewer"`.
   - Downstream skills (`receiving-code-review`, `feature-acceptance`) MUST skip entries whose `rule` starts with `INVARIANT_RATIONALE:` when computing contract-violation counts so the rationale never inflates real-rule metrics.

   **Future enhancement:** add a first-class `invariantsRationale` string to the TASK CUE schema; remove the sentinel encoding then.

   This gate runs over EVERY task before the manifest is staged. A run that rejects one or more tasks loops back to the Reviewer for that task only; tasks that already pass the gate are not re-validated.
3. **Granularity pass** (haiku-class). After bucket assignments are finalized, scan every task's `scope[]` count. Flag tasks with fewer than 2 files as `collapse` candidates and tasks with more than 10 files as `split` candidates. Emit all findings in `granularityWarnings[]` on the `TASKS_MANIFEST` — each entry cites the `taskId`, the `verdict` (`collapse` or `split`), and a one-sentence rationale. This field is CUE-admitted on the `TASKS_MANIFEST` step and surfaces for operator review before `execute-task` runs.

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
