# Task decomposition — domain over file

generate-task groups work by **domain bucket**, never by individual file. Files belonging to the same bucket usually become a single task even when the file count is >5. Splitting a bucket into two tasks needs an explicit reason recorded in the Reviewer's `granularityNote`.

## Why domain, not file

A task is the unit of dispatch to an `execute-task` specialist subagent. That subagent loads domain skills (e.g. `fastify-best-practices`), reads the relevant CLAUDE.md guidance, and executes a coherent change in one mental model. Splitting one domain into multiple tasks duplicates that loading cost and risks inconsistency across tasks that touch the same surface.

A task per file:

- forces N specialists to repeat the same context-load
- multiplies token cost in execute-task's dispatch overhead
- fragments the diff into review chunks that no longer tell a story
- breaks the "atomic unit of intent" review heuristic

A task per domain:

- one specialist owns one coherent surface
- one diff per surface for code-review
- one set of invariants applies uniformly

## Bucket inheritance from EXPLORATION.md

generate-task does not RE-DERIVE buckets. EXPLORATION.md's `domains[]` IS the bucket decision (already made by scope-feature using longest-prefix path matching). generate-task maps:

```
EXPLORATION.md.domains[].name  →  one task
EXPLORATION.md.domains[].likelyFiles[]  →  task.scope.files[]
EXPLORATION.md.domains[].relatedFRs[]  →  task.acceptanceCriteria[].bindsTo[].frId/frText
EXPLORATION.md.domains[].skillsFound[]  →  task.skillsFound[]
```

One domain → one task (default). Two cases override the 1:1:

1. **Split** — a single domain bucket >10 files AND the files cluster into two distinct conceptual surfaces (e.g. `apps/api` has `routes/` and `consumers/` and the PRD touches both independently). Split into two tasks with `dependsOn[]` if ordering matters.
2. **Collapse** — two tiny domain buckets (<2 files each) that are conceptually one feature surface. Collapse into one task, record `mergedFrom[]` in the body narrative.

Both overrides require a `granularityNote.verdict: split | collapse` entry on the affected tasks.

## Canonical-phase filter — suppress redundant tasks

A common decomposition failure is to emit tasks that duplicate the work of later canonical phases:

| Candidate task | Suppress because | Canonical phase that owns it |
|---|---|---|
| "Write unit tests for foo" | The `write-tests` phase authors green coverage + mutation tests for every changed file. | `write-tests` (Phase 8) |
| "Update README to mention new flag" | The `update-docs` phase patches every doc that drifted. | `update-docs` (Phase 9) |
| "Review TASK_03 for security issues" | The `code-review` phase runs 4 mandatory lanes including QA + security. | `code-review` (Phase 6) |
| "Apply review feedback" | The `receiving-code-review` phase consumes findings and closes them. | `receiving-code-review` (Phase 7) |
| "Verify the feature works" | The `feature-acceptance` phase runs AC-gate verification. | `feature-acceptance` (Phase 11) |
| "Write commit message and commit" | The `commit` phase handles message + push. | `commit` (Phase 12) |

When the Reviewer detects a candidate matching one of these patterns, **do not emit a TASK_NN.md file for it**. Append the suppression to `RECEIPTS.md` `## generate-task` section under `### Decomposition decisions` with:

```markdown
- **Suppressed**: "Write unit tests for `routes/upload.ts`"
  Reason: duplicates-canonical-phase-write-tests
  Detected by: reviewer-pass
```

The append-receipts script handles the formatting.

## All-suppressed bucket rule

When the canonical-phase suppression filter eliminates EVERY candidate task in a domain bucket, do NOT emit any TASK_NN.md for that bucket. The bucket is implicitly handled by the canonical phase (typically `update-docs`, `write-tests`, or `code-review` — whichever the suppression filter routes it to).

Record each suppressed candidate in the decisions JSON (consumed by `append-receipts.mjs`) so the operator can audit why a bucket from EXPLORATION.md did not produce a task.

**Anti-pattern**: emitting an empty / token task for a bucket to satisfy a "bucket coverage" instinct. EXPLORATION.md is the input map, not the output guarantee — generate-task is allowed to filter buckets out entirely when canonical phases own them.

Common case: a feature touches `packages/cli` (code) and `docs/` (README update). scope-feature surfaces both buckets. generate-task suppresses the docs candidate ("Update README to mention new flag" → routed to update-docs Phase 9) and emits ONLY a `packages/cli` task. The docs bucket simply has no TASK_NN.md — that is correct.

## Sensitive-scope gate — non-empty invariants[]

When a TASK_NN.md's `scope.files[].path` intersects EXPLORATION.md's `sensitiveScopeHits[]`, the task's `invariants[]` MUST be non-empty. Empty `invariants[]` on a sensitive task is a Reviewer-pass rejection.

Acceptable resolutions:

1. **Discover and populate**: Run `browzer explore "<domain-term>"` and/or `browzer search "<topic>"` over the matched paths. Surface project conventions and add at least one `{rule, source}` entry to `task.invariants[]`. Examples:
   - "RBAC: extend a single SSOT module rather than hardcoding strings in callers" — source: the SSOT module file
   - "i18n: dynamic translation keys require comment-mark annotations or a build step deletes them" — source: the build config that enforces this
   - "auth: token comparison MUST use timingSafeEqual from node:crypto — never ===" — source: the module documenting the rule
2. **Record absence rationale via sentinel**: When no invariant exists, attach a free-form rationale:
   ```yaml
   invariants:
     - rule: "INVARIANT_RATIONALE: scope is a pure rename inside a translation file with no key additions or removals."
       source: "generate-task-reviewer"
   ```

Downstream skills (`receiving-code-review`, `feature-acceptance`) MUST skip entries whose `rule` starts with `INVARIANT_RATIONALE:` when counting real contract violations.

## Why the Reviewer no longer runs an "Explorer pass"

In the old (workflow.json) world, generate-task ran a two-pass workflow internally: Explorer (file mapping via `browzer:explorer` subagent) → Reviewer (validation + skill attachment). In the markdown-chains world, the Explorer pass moved to a separate skill (`scope-feature`) that runs as its own phase BEFORE generate-task.

Net result:

- generate-task is single-pass — only the Reviewer's job remains.
- All file mapping, blast radius, find-skills work was already done; generate-task just COPIES the relevant subset from EXPLORATION.md per task.
- Quality signal is preserved (still a haiku + sonnet split, just across phases now).
- Re-runs are cheap: editing EXPLORATION.md and re-running generate-task does not re-do the discovery.

## HTTP route consumer-contract pass (preserved)

When ANY file in `task.scope.files[].path` is a server route (path contains `/routes/`, `/handlers/`, `/controllers/`, ends with `-route.ts`, `-handler.ts`, or matches `**/api/**/*.{ts,js,go}`), the Reviewer MUST:

1. Read the file's `blastRadius.reverse[]` from EXPLORATION.md (already collected by scope-feature). Reverse importers under a frontend or web entrypoint indicate consumer contracts.
2. Surface field references (e.g. `doc.id`, `doc.name`) from those consumers as `consumerContract: ["id", "name", ...]` in the task body's `## Implementation hints` section.
3. Add an `invariants[]` entry for each field that has no corresponding return-shape documentation, OR flag in `granularityNote.rationale` as an undocumented consumer contract.
