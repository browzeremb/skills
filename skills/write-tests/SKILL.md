---
name: write-tests
description: "Author tests for a code change AND run mutation testing (Stryker / mutmut / go-mutesting) to verify the suite kills mutants. Each test is mutation-resistant by design — catches at least one plausible mutation (boolean, conditional, arithmetic, boundary, off-by-one, return-value). Auto-detects the repo's runner; skips when no test setup exists. Use after fixes land or for any 'cover these files' request. Triggers: write tests, add tests, test coverage for, unit tests for, test this, mutation testing, stryker, mutmut, kill mutants, 'tests for this change', spec these files."
argument-hint: "<featureId>"
---

You are a test author. Write green coverage AND verify the suite kills mutants.

## Read context

```
!`browzer get-step WRITE_TESTS --id $ARGUMENTS 2>/dev/null || echo "(no prior WRITE_TESTS step — first run)"`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob lists every changed file from completed TASK_NN steps and the relevant test runner the orchestrator probed.

## Process

Dispatch the test author with `subagent_type: browzer:tester`, `model: sonnet`, `effort: high`.

1. **Pre-flight.** Detect the repo's runner (vitest, jest, pytest, go test, ...). If no test infra exists, set `skipped: true` with rationale and stop.
2. **Author tests** scoped to the changed files. Cover happy path + edge cases + boundary conditions.
3. **Mutation testing.** Run Stryker (JS/TS), mutmut (Python), or go-mutesting (Go). Mutation-resistant principles in `references/mutation-principles.md`. Six mutation categories MUST be killed: boolean, conditional, arithmetic, boundary, off-by-one, return-value.
4. **Iterate** on surviving mutants until each is killed or formally documented as unreachable.

## Produce

Write `docs/browzer/<feat>/staging/WRITE_TESTS.json`.

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

When `skipped: true`, the only required field is `rationale`.

Top-level flat mutation fields (added alongside `mutationTesting` object; populate either or both):

- **`mutationScore`** — integer mutation score 0–100 (or `null` if not yet run).
- **`killed`** — integer count of mutants killed (or `null`).
- **`survived`** — integer count of mutants survived (or `null`).
- **`categories`** — array of mutation category strings that were verified (or `null`).

These are aliases for the nested `mutationTesting.{score,…}` fields. Use the flat form for concise reporting and the nested form for full detail.

## Persistence

The autosave hook persists `staging/WRITE_TESTS.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — WRITE_TESTS is not load-bearing for the next phase; wait for durable write before continuing.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- File exists at `docs/browzer/<feat>/staging/WRITE_TESTS.json`.
- Every survived mutant carries an explicit `rationale`.
- The autosave hook validates and persists.

Return one line: `write-tests: <N> tests added; mutation score=<score>`.
