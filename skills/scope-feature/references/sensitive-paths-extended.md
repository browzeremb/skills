# Sensitive paths — extended pattern set (scope-feature)

This file extends the cross-skill base predicate at
`../../../references/sensitive-paths.md` with the broader pattern set used by
`scope-feature` when populating `EXPLORATION.md.sensitiveScopeHits[]`. It does
NOT replace the base predicate — it adds to it. The base predicate (RBAC SSOT
modules, translation catalogues, content-based mutation tokens, operator
extensions in `.browzer/sensitive-paths.json`) is evaluated first; then the
patterns below are unioned in.

In the markdown-chains world, scope-feature is the only skill that EVALUATES
the predicate against the workspace. Downstream skills (`generate-task`,
`code-review`, `feature-acceptance`) consume the persisted result via
`EXPLORATION.md.sensitiveScopeHits[]` — they never re-run the matcher.

Consumers of this file:

1. `scope-feature` — the predicate evaluator. Loads both `../../../references/sensitive-paths.md` and this file at scope-feature run time, unions the patterns, applies them over every `likelyFiles[].path`, and persists the matches to `EXPLORATION.md`.

## Pattern matching algorithm

Patterns use **minimatch / globstar** semantics:

- `**` matches zero or more path segments (including none).
- `*` matches any sequence of characters that does not contain a `/`.
- `{ext1,ext2}` is a brace-expansion shorthand for two separate patterns.
- Matching is case-insensitive on case-insensitive file systems (macOS HFS+, Windows NTFS). Run matchers case-insensitively.
- A pattern matches if the workspace-relative file path matches it anywhere in the path (prefix, middle, or suffix), unless the pattern is anchored with a leading `/`.

Evaluate every pattern against the full workspace-relative path of each file in `domains[].likelyFiles[].path`. A single match from ANY pattern is sufficient to add a `sensitiveScopeHits[]` entry.

## Extended pattern table

| Pattern | Category | Rationale |
|---|---|---|
| `**/auth/**/*.{ts,js,go}` | Authentication code | Auth flows carry session, token, and credential logic; invariants MUST be documented. |
| `**/billing/**` | Billing / payment | Any billing mutation risks financial impact; invariants required. |
| `**/middleware/auth*.{ts,js,go}` | Auth middleware | Middleware runs on every request; a dropped guard is a blanket bypass. |
| `**/migrations/**` | Schema migrations | Irreversible DDL changes require invariant proof of backward-compat or explicit rollback plan. |
| `**/*secret*` | Secrets handling | Files whose names contain "secret" are assumed to carry credential material. |
| `**/*credential*` | Credential storage | Same rationale as secrets. |
| `**/.env*` | Environment / config | Env files carry live credentials; changes require invariant documentation. |
| `**/{authz,rbac,permission}*.{ts,js,go}` | Authorisation SSOT | RBAC SSOT files encode the permission model; mutations without invariants are high-risk. |
| `**/queue/**` | Async job handlers | Consumer Zod-parse rule: every consumer must schema-validate `job.data` at entry. |
| `**/jobs/**` | Job definitions | Same rationale as queue handlers; payload schema invariants are required. |

> The patterns are generic and project-agnostic. They encode categories, not concrete file paths from any specific host repository. The operator-extension mechanism (`.browzer/sensitive-paths.json`) is the correct surface for adding project-specific globs.

## Categories the consumer can hint at

When scope-feature emits a `sensitiveScopeHits[]` entry, the `reason` field
gives a short gloss; the `invariantSources[]` field should point to the file
that documents the relevant invariant in the host repo. The categories below
guide which invariants typically apply per pattern:

- `auth/**` → tenant scoping, `timingSafeEqual` token comparison, bearer-credential validation
- `billing/**` → atomic debit, pre/post-LLM spend gates, refund-on-failure
- `migrations/**` → backward-compat, rollback plan, partition strategy
- `*secret*` / `*credential*` / `.env*` → `isSensitive()` filter, never log/persist raw values
- `authz`/`rbac`/`permission` → `requireAuthz()` preHandler, SSOT module extension rule
- `queue`/`jobs` → Zod-parse `job.data` at consumer entry, `requestId` propagation

These hints feed into the `generate-task` Reviewer's invariant gate: when a
task's scope intersects a sensitive hit, the Reviewer must populate
`task.invariants[]` with rules grounded in the host repo's `CLAUDE.md` or
equivalent docs.

## Interaction with the base predicate

The full predicate evaluated by scope-feature is the union of:

1. `../../../references/sensitive-paths.md` — RBAC SSOT modules (`**/Permission*`, `**/permissions*`), translation catalogues (`**/locales/**/*.{yml,yaml,json}`, `**/translations/**`), and content-based mutation tokens (`useMutation(`, `fetcher.post(` etc.).
2. This file — the ten extended patterns above.
3. Any globs in `.browzer/sensitive-paths.json` (operator-extended patterns).

A `likelyFiles[].path` that matches any glob in any of these three sources triggers a `sensitiveScopeHits[]` entry.

## Content-grep pass

The base predicate file documents a content-grep pass for the new-mutation-token rule. scope-feature reuses that pass over the changed-file set (the union of all `likelyFiles[].path`) — see the "Content-level evaluation" section of `../../../references/sensitive-paths.md` for the `git diff -G` invocation. The two passes (path-glob + content-grep) BOTH run before scope-feature declares "predicate did not match".

## Failure mode (consumed by generate-task)

When a TASK_NN.md whose `scope.files[].path` matches the predicate has empty `invariants[]` AND no `INVARIANT_RATIONALE:` sentinel entry, generate-task's Reviewer REFUSES to emit the task file and reports:

```
ERROR: Sensitive-scope refusal — task <TASK_ID> must declare invariants.
  Offending scope entry : <matched-path>
  Matched pattern       : <pattern>
  Required action       : Populate task.invariants[] with at least one project
                          invariant (rule + source), OR add an INVARIANT_RATIONALE:
                          sentinel entry explaining why no invariant applies.
```

See `../../generate-task/SKILL.md §"Sensitive-scope invariants gate"` for the full refusal protocol and the worked failure example. scope-feature itself does NOT refuse — it only persists the hits to EXPLORATION.md. The gate runs one phase later.
