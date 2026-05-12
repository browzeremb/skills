---
name: generate-task
description: "Two-pass task decomposer that groups by DOMAIN, not by file. Explorer pass (haiku) maps files, dep graphs, domains, and skills-to-invoke per prospective task; Reviewer pass (sonnet default, opus for complex scopes) validates the mapping, enumerates test coverage targets per task, and rejects sensitive-scope tasks with empty invariants (FR-3, predicate at `references/sensitive-paths.md`). Reads the PRD from `browzer get-step PRD` and the resolved `executionStrategy` from `browzer get-step CONFIG` (virtual phase; the orchestrator seeds it via `workflow init --execution-strategy`). Triggers: break this PRD into tasks, generate tasks, plan the implementation, decompose this spec, task plan, task breakdown, sequence the work, split this into PRs, 'how should I sequence this'."
argument-hint: "<featureId>"
---

You are a task decomposer. Group work by DOMAIN, never one task per file.

## Read context

```!
if [ -n "$ARGUMENTS" ]; then
  browzer get-step CONFIG --id "$ARGUMENTS"
  browzer get-step PRD --id "$ARGUMENTS"
fi
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

1. **Explorer pass** (haiku-class). For every PRD acceptance criterion: `browzer explore "<noun>" --save /tmp/tasks-explore-<noun>.json` → resolve owning files → assign each file to a bucket. Deduplicate. Build per-bucket dep graphs via `browzer deps <file> --save /tmp/tasks-deps-<file-slug>.json`. Attach each receipt path to the task it grounds. Dispatch the Explorer pass as `subagent_type: browzer:explorer`. Pass the PRD acceptance criteria as the query list.
2. **Reviewer pass** (sonnet, opus on bucket >25 files). Validate bucket assignments, enumerate test coverage targets, and attach skills to each task. The PRD's `skillsFound[]` is the source of truth (spec); `task.explorer.skillsFound[]` is the discovery result on each task. The Reviewer copies skills from the PRD onto each task that needs them, then cross-checks against what the Explorer pass surfaced — for any mismatch, validate the skill name exists on disk (the available skills trees); if missing, mark it as a gap and request a PRD update or add the missing skill file. Never invent a fictional skill.

   #### Sensitive-scope invariants gate (FR-3)

   Load the sensitive-path predicate from two files (union of both):

   1. `references/sensitive-paths.md` (this skill's extended predicate — auth, billing, migrations, secrets, RBAC, async jobs, and more; see that file for the matching algorithm and the full pattern table).
   2. `../../references/sensitive-paths.md` (cross-skill base predicate — RBAC SSOT modules, translation catalogues, content-based mutation tokens; also consumed by `code-review`).

   The predicate is a logical OR over ALL path globs from both files plus any operator-extended globs declared in the target repo's `.browzer/sensitive-paths.json`.

   If `.browzer/sensitive-paths.json` exists but fails to parse, fail-closed: treat the task as sensitive-scope and require `invariants[]` (or sentinel rationale) regardless of path-glob match.

   For each task in the manifest, evaluate:

   - Does ANY entry in `task.scope[]` match the predicate?
   - If yes AND `task.invariants[]` is empty AND no equivalent `invariantsRationale` is set ⇒ **REFUSE to emit `staging/TASKS.json`** and fail with the prescriptive error below.

   **Hard refusal — verbatim stderr:**

   ```
   ERROR: Sensitive-scope refusal — task <TASK_ID> must declare invariants.
     Offending scope entry : <matched-path>
     Matched pattern       : <pattern>
     Required action       : Populate task.invariants[] with at least one project
                             invariant (rule + source), OR add an INVARIANT_RATIONALE:
                             sentinel entry explaining why no invariant applies.
     Invariant categories from CLAUDE.md that commonly apply to this pattern:
       - auth/**    → tenant scoping, timingSafeEqual, bearer-credential validation
       - billing/** → atomic debit, pre/post-LLM spend gates, refund-on-failure
       - migrations/** → backward-compat, rollback plan, partition strategy
       - *secret* / *credential* / .env* → isSensitive() filter, never log/persist raw values
       - authz/rbac/permission → requireAuthz() preHandler, SSOT module extension rule
       - queue/jobs → Zod-parse job.data at consumer entry, requestId propagation
   ```

   `save-step` MUST NOT be called until the refusal is resolved. The Reviewer loops on the offending task only; tasks that already passed the gate are not re-validated.

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

   **Operator prompt override:** if the dispatch prompt contains the literal sentinel `INVARIANT_RATIONALE:` on its own line, the Reviewer MAY treat that as pre-authorising Resolution B for all tasks in the run and auto-populate the sentinel `invariants[]` entry using the rationale text that follows. This override is advisory — the Reviewer MUST still surface it in the manifest and in the granularity warnings so the operator sees which tasks were auto-resolved.

   **Future enhancement:** add a first-class `invariantsRationale` string to the TASK CUE schema; remove the sentinel encoding then.

   This gate runs over EVERY task before the manifest is staged. A run that rejects one or more tasks loops back to the Reviewer for that task only; tasks that already pass the gate are not re-validated.

   #### Worked failure example (FR-3)

   **Input:** PRD acceptance criterion — "Implement device-flow token endpoint in the authentication service" with scope `["src/auth/device-flow.ts", "src/middleware/auth-guard.ts"]`.

   **Offending task draft (Reviewer pass output — INVALID):**

   ```json
   {
     "taskId": "TASK_02",
     "title": "Implement device-flow token endpoint",
     "scope": ["src/auth/device-flow.ts", "src/middleware/auth-guard.ts"],
     "skillsFound": ["better-auth-best-practices"],
     "invariants": []
   }
   ```

   **Refusal stderr (verbatim):**

   ```
   ERROR: Sensitive-scope refusal — task TASK_02 must declare invariants.
     Offending scope entry : src/auth/device-flow.ts
     Matched pattern       : **/auth/**/*.{ts,js,go}
     Required action       : Populate task.invariants[] with at least one project
                             invariant (rule + source), OR add an INVARIANT_RATIONALE:
                             sentinel entry explaining why no invariant applies.
     Invariant categories from CLAUDE.md that commonly apply to this pattern:
       - auth/**    → tenant scoping, timingSafeEqual, bearer-credential validation
       - billing/** → atomic debit, pre/post-LLM spend gates, refund-on-failure
       - migrations/** → backward-compat, rollback plan, partition strategy
       - *secret* / *credential* / .env* → isSensitive() filter, never log/persist raw values
       - authz/rbac/permission → requireAuthz() preHandler, SSOT module extension rule
       - queue/jobs → Zod-parse job.data at consumer entry, requestId propagation
   ```

   **Fix A — operator discovers and populates invariants:**

   Run `browzer explore "auth device flow token validation"` → surfaces `src/auth/device-flow.ts` with import of a `timingSafeEqual`-based comparator. Then update the task:

   ```json
   {
     "taskId": "TASK_02",
     "title": "Implement device-flow token endpoint",
     "scope": ["src/auth/device-flow.ts", "src/middleware/auth-guard.ts"],
     "skillsFound": ["better-auth-best-practices"],
     "invariants": [
       {
         "rule": "Token comparison MUST use timingSafeEqual from node:crypto — never ===",
         "source": "src/auth/device-flow.ts"
       }
     ]
   }
   ```

   **Fix B — operator appends sentinel to the dispatch prompt** (when no invariant is discoverable):

   Append to the orchestrator dispatch prompt:

   ```
   INVARIANT_RATIONALE: device-flow.ts is a new file with no prior art in the codebase; no timing-safe or tenancy invariant is yet documented for this path.
   ```

   The Reviewer will auto-populate the sentinel entry:

   ```json
   {
     "invariants": [
       {
         "rule": "INVARIANT_RATIONALE: device-flow.ts is a new file with no prior art in the codebase; no timing-safe or tenancy invariant is yet documented for this path.",
         "source": "generate-task-reviewer"
       }
     ]
   }
   ```

   #### HTTP route consumer-contract pass

   When ANY file in `task.scope[]` is a server route file (heuristic: path contains `/routes/`, `/handlers/`, `/controllers/`, ends with `-route.ts`, `-handler.ts`, or matches `**/api/**/*.{ts,js,go}`), the Explorer pass MUST additionally:

   1. Run `browzer deps <route-file> --reverse --json --save /tmp/rdeps-<route-slug>.json` to discover every client/consumer that imports or proxies the route.
   2. Scan each reverse-dep that lives under a frontend or web entrypoint: extract `(\b[a-zA-Z_]+)\.[a-zA-Z_]+` field references (e.g. `doc.id`, `doc.name`, `doc.pageCount`) and surface them as `consumerContract: ["id", "name", "pageCount"]` on the task's Explorer pass output.

   This protocol is implemented in `agents/explorer.md §2 — Discovery protocol` (step 5, "HTTP route consumer-contract pass"). The Reviewer pass receives the `consumerContract[]` array and MUST add an invariant entry for each field that has no corresponding return-shape documentation, or flag it in `granularityWarnings[]` as an undocumented consumer contract.

   **When the pass triggers:** any `task.scope[]` entry matching a route file heuristic, OR when the PRD acceptance criteria mention "API", "endpoint", "route", or "handler".
3. **Granularity pass** (haiku-class). After bucket assignments are finalized, scan every task's `scope[]` count. Flag tasks with fewer than 2 files as `collapse` candidates and tasks with more than 10 files as `split` candidates. Emit all findings in `granularityWarnings[]` on the `TASKS_MANIFEST` — each entry cites the `taskId`, the `verdict` (`collapse` or `split`), and a one-sentence rationale. This field is CUE-admitted on the `TASKS_MANIFEST` step and surfaces for operator review before `execute-task` runs.

## Produce

Write `docs/browzer/<feat>/staging/TASKS.json` matching the **canonical scaffold** in `template.md` (auto-generated from the workflow CUE schema). The preferred shape is the full `#TasksManifest` object; a bare `[...#TaskBrief]` array is also accepted and auto-wrapped by `save-step`. Any field not present in `template.md`'s field reference is dropped on save.

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

## Persistence

The autosave hook persists `staging/TASKS.json` automatically on write. Write to `docs/browzer/<feat>/staging/TASKS_MANIFEST.json` (not `TASKS.json`; the autosave hook normalizes the filename).

### Payload shape

The staged file contains the INNER `#TasksManifest` shape (not wrapped in a parent object). Example:

```json
{
  "tasks": [
    {
      "taskId": "TASK_01",
      "title": "Implement user authentication",
      "description": "Add login and signup flows",
      "scope": [
        "src/auth/login.ts",
        "src/routes/auth.ts"
      ],
      "scope.deps": {
        "forward": ["src/db/users.ts", "src/lib/session.ts"],
        "reverse": ["src/server.ts"]
      },
      "skillsFound": ["better-auth-best-practices"],
      "invariants": [
        {
          "rule": "RBAC: extend a single SSOT module rather than hardcoding strings in callers",
          "source": "CLAUDE.md"
        }
      ]
    }
  ],
  "parallelizable": [["TASK_02", "TASK_03"]],
  "totalEstimatedRountrips": 12,
  "granularityWarnings": []
}
```

Recommended flags when manually invoking `save-step`:

- `--quiet --await` — TASKS_MANIFEST is load-bearing: `execute-task` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

### Autosave flow (do NOT use append-step)

**NEVER use `append-step` for TASKS_MANIFEST.** The `append-step` verb does not materialise the per-task slots (`TASK_01`, `TASK_02`, …) in the workflow. If you used `append-step` by mistake, subsequent `save-step TASK_01` calls will fail with "step not found: TASK_01".

Always use: `browzer save-step TASKS_MANIFEST --id <feat> --from docs/browzer/<feat>/staging/TASKS_MANIFEST.json`

The autosave hook calls this automatically after `Write` detects the staged file. For manual invocation, the payload is the INNER shape shown above (what `browzer workflow describe-step-type TASKS_MANIFEST --json` returns) — no wrapper object.

## Done when

- `docs/browzer/<feat>/staging/TASKS.json` exists and parses as either a `#TasksManifest` object or a bare `[...#TaskBrief]` array.
- Every `skillsFound[]` entry was verified on disk (the available skills trees).
- File overlap across tasks respects `executionStrategy` — `parallel*` strategies have disjoint `scope[]` (the per-task file list).
- When the granularity pass produced any findings, `TASKS_MANIFEST.granularityWarnings[]` is populated with `taskId`, `verdict` (`collapse` | `split`), and `rationale` for each flagged task.
- The autosave hook validates and persists. It calls `browzer save-step <PHASE> --id <feat> --from <staged-file>`, which CUE-validates and persists into `workflow.json` atomically. Failures arrive as a one-line stderr message; re-write the staging file to retry. If the hook does not fire (e.g. the file was authored via Bash heredoc), the next `browzer get-step <PHASE>` self-heals by running `save-step` from the staged file before returning.

## Post-persist status check (FR-5)

After `browzer save-step TASKS_MANIFEST`, verify the persisted status for each `TASK_NN` slot:

```bash
browzer get-step TASK_NN --id "$ARGUMENTS" --json
```

Assert `status === "PLANNED"`. If the CLI returns `COMPLETED` for any task slot, log a warning:

```
WARN: TASK_NN persisted with status=COMPLETED — execution has not yet run. Operator should re-run execute-task for this task.
```

Surface each such warning as a `granularityWarnings[]` entry in `staging/TASKS_MANIFEST.json` (NOT `staging/TASKS.json` — the canonical staging path is `TASKS_MANIFEST.json`). Use `verdict: "premature-completion"` for these entries; include the `taskId` and a one-sentence rationale explaining that a stale execution slot was merged in by `save-step`. A COMPLETED status at this phase means the task plan is still valid but the operator must re-run execute-task for the affected task IDs.

Inspect `staging/TASKS_MANIFEST.json` — specifically the `granularityWarnings[]` array — after every run to confirm no `premature-completion` entries exist before handing off to `execute-task`.

Return one line: `generate-task: <N> tasks written; strategy=<executionStrategy>`.

Your turn is incomplete until `docs/browzer/<feat>/staging/TASKS.json` exists on disk. Do not stop to summarize or investigate further after writing it.
