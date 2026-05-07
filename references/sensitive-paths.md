# Sensitive paths — shared predicate for fast-lane and invariant gates

"Sensitive paths" are the subset of a target repository's files where a contract violation is likely to slip through diff-only heuristics. RBAC modules, translation key catalogues, and any newly introduced mutation call site change behaviour in ways that a spot-check of a unified diff cannot reliably catch — a deleted permission key, a missing locale entry, or an unscoped mutation reads as a small green-line change but breaks an invariant downstream. This predicate exists so multiple skills can agree on a single, machine-checkable definition of "this diff cannot be gated heuristically — escalate".

## Predicate (glob patterns)

A changed file matches the sensitive-path predicate if ANY of the following holds:

- **Path-based — RBAC SSOT modules**:
  - `**/Permission*` (file or folder name match)
  - `**/permissions*` (file or folder name match)
- **Path-based — translation catalogues**:
  - `**/locales/**/*.{yml,yaml,json}` (translation key catalogues)
  - `**/translations/**` (translation directories at any depth)
- **Content-based — new mutation call sites** (the diff INTRODUCES one of these tokens, not merely contains them in unchanged context):
  - `useMutation(`
  - `createMutation(`
  - `useQuery(... mutationFn` (mutation registered via a query hook)
  - `fetcher.post(`, `fetcher.put(`, `fetcher.patch(`, `fetcher.delete(` (any HTTP-mutating fetcher call)
- **Operator-extended**: any path matched by a glob listed in the target repo's `.browzer/sensitive-paths.json` (see "Operator extension" below).

The predicate is a logical OR — a single match is sufficient.

## Content-level evaluation

The path-based bullets above resolve via `git diff --name-only` against the changed-file set, but the content-based bullets (the new-mutation-token rule) and the LOW-severity "introduces token" guidance CANNOT be evaluated by filename alone — `git diff --name-only` cannot inspect added lines. Consumers MUST run BOTH passes before concluding the predicate did not match:

1. **Path-glob pass** — match the changed-file set against the path-based globs above (built-in + operator extensions).
2. **Content-grep pass** — search the diff body for ADDED lines that introduce a new mutation/fetcher call site.

Define `BASE` once, then run the content pass:

```bash
BASE="$(git merge-base HEAD <main-branch>)"

# Returns files in the diff that ADD a new mutation/fetcher call.
# -G matches the regex against ADDED or REMOVED lines; combined with --diff-filter=AM
# (Added/Modified) this narrows to files where the token appears in the diff body.
git diff "$BASE..HEAD" --diff-filter=AM \
  -G '(useMutation|createMutation|fetcher\.(post|put|patch|delete))\(' \
  --name-only
```

The predicate is the UNION of the two passes' file sets. A diff that touches no path-glob files but introduces a new `useMutation(` call still matches and MUST escalate.

The two callers of this content-grep pass are:

- `code-review` — fast-lane gate (FR-1), to decide whether the in-line consolidator fast-lane is banned for the run.
- `generate-task` — Reviewer pass (FR-3), to decide whether a task's `scope[]` qualifies as sensitive for the empty-`invariants[]` rejection.

Both consumers MUST run path-glob AND content-grep before declaring "predicate did not match".

## Consumers

This file is loaded by ≥2 skills and lives under `packages/skills/references/` per the cross-skill shared-reference rule:

- `code-review` — fast-lane gate (FR-1).
- `generate-task` — Reviewer pass empty-invariants rejection (FR-3).

Future skills MAY consume this predicate; new consumers should link to this file rather than re-encode the rules.

## How consumers use the predicate

### `code-review` (fast-lane gate)

When ANY changed file in the diff matches the predicate, the in-line consolidator fast-lane is BANNED for the run. All four mandatory parallel reviewers — `senior-engineer`, `software-architect`, `qa`, and `regression-tester` — MUST run. The fast-lane is reserved for diffs that touch none of the sensitive paths and whose blast radius is provably small; any sensitive-path hit forces the full team review regardless of diff size.

### `generate-task` (Reviewer pass empty-invariants rejection)

When ANY task's `scope[]` matches the predicate AND that task's `invariants[]` is empty, the Reviewer MUST do one of:

1. Populate `invariants[]` with at least one project invariant discovered via `browzer explore` / `browzer search` over the scoped paths (e.g. an RBAC tenancy rule, a locale-key parity rule, a mutation-must-go-through-X rule), OR
2. Set an explicit `invariantsRationale` string explaining why no invariant applies (e.g. "scope is a pure rename inside a translation file with no key additions or removals").

A sensitive-scope task with empty `invariants[]` AND no `invariantsRationale` is a Reviewer-pass rejection.

> NOTE: `invariantsRationale` is not yet a first-class TASK schema field. See `generate-task/SKILL.md` for the encoding workaround (sentinel-prefixed `invariants[]` entry).

## Operator extension

Operators of the target repo can extend the predicate without forking the plugin by creating `.browzer/sensitive-paths.json` at the repo root:

```json
{
  "globs": [
    "**/billing/**",
    "**/migrations/*.sql"
  ]
}
```

Schema:

- Top-level object with a single `globs` key.
- `globs` is a string array of additional glob patterns (same syntax as the built-in patterns above).
- Patterns are appended to — not replacing — the built-in predicate.
- Missing file or empty array means "no extensions"; the built-in predicate still applies.

Consumer skills MUST read this file when present and union its globs into the predicate evaluation.
