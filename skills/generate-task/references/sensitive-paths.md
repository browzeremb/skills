# Sensitive paths — generate-task FR-3 predicate

This file extends the cross-skill predicate in `../../references/sensitive-paths.md` with the fuller pattern set used by the generate-task Reviewer pass (FR-3). It does NOT replace the global file — it adds to it. The global predicate (RBAC modules, translation catalogues, content-based mutation tokens, operator extensions) is evaluated first; then the patterns below are unioned in.

Consumers of the FR-3 gate MUST evaluate BOTH files:

1. Load `../../references/sensitive-paths.md` — the base predicate.
2. Load this file — the generate-task extended predicate.
3. Apply the logical OR across all pattern sets.

## Pattern matching algorithm

Patterns use **minimatch / globstar** semantics:

- `**` matches zero or more path segments (including none).
- `*` matches any sequence of characters that does not contain a `/`.
- `{ext1,ext2}` is a brace-expansion shorthand for two separate patterns.
- Matching is case-insensitive on case-insensitive file systems (macOS HFS+, Windows NTFS). Run matchers case-insensitively.
- A pattern matches if the workspace-relative file path matches it anywhere in the path (prefix, middle, or suffix), unless the pattern is anchored with a leading `/`.

Evaluate every pattern against the full workspace-relative path of each file in `task.scope[]`. A single match from ANY pattern is sufficient to trigger the gate.

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

> The patterns above are generic and project-agnostic. They encode categories, not concrete file paths from any specific host repository. The operator-extension mechanism (`.browzer/sensitive-paths.json`) is the correct surface for adding project-specific globs.

## Interaction with the global predicate

The full predicate is the union of:

1. `../../references/sensitive-paths.md` — RBAC SSOT modules (`**/Permission*`, `**/permissions*`), translation catalogues (`**/locales/**/*.{yml,yaml,json}`, `**/translations/**`), and content-based mutation tokens (`useMutation(`, `fetcher.post(` etc.).
2. This file — the ten extended patterns above.
3. Any globs in `.browzer/sensitive-paths.json` (operator-extended patterns).

A `task.scope[]` entry that matches any glob in any of these three sources is a sensitive-scope match.

## Failure mode

When a task in the manifest matches the predicate AND `task.invariants[]` is empty AND no `INVARIANT_RATIONALE:` sentinel entry is present:

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

See `generate-task/SKILL.md §"Sensitive-scope invariants gate (FR-3)"` for the full refusal protocol and the worked failure example.
