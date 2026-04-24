# Code Review — Mandatory Member Briefs

The three mandatory members of every `code-review` dispatch, regardless of tier (basic / recommended / custom). All three ALWAYS run. Briefs below describe scope, execution, and the exact `codeReview` payload fields each role populates.

---

## Senior Software Engineer

**Role**: final quality reviewer. Ensures the implementation honors the repo's
invariants (from `CLAUDE.md` + per-task `task.invariants`) and does not violate
the declared blast radius. Checks adherence to the PRD's `nonFunctionalRequirements`.

**MUST AUDIT** cyclomatic complexity per changed file:

- **JS/TS**: `npx complexity-report <file>` or `eslint --rule 'complexity: [error, 10]'`
  (the threshold default is 10; adjustable via the skill's custom tier).
- **Python**: `radon cc <file>` or equivalent.
- **Go**: `gocyclo <file>`.
- **Rust**: `cargo clippy -- -W clippy::cognitive_complexity` or `scc --stats`.

Record each audited file in `codeReview.cyclomaticAudit[]`:

```jsonc
{
  "file": "apps/api/src/routes/foo.ts",
  "maxComplexity": 12,
  "threshold": 10,
  "verdict": "warn"   // "ok" | "warn" | "fail"
}
```

Findings categories: `logic` | `style` | `maintainability` | `invariant-violation` | `blast-radius`.

Severity mapping:
- Invariant violation → **high**.
- Cyclomatic > 2× threshold → **high**.
- Cyclomatic > threshold but < 2× → **medium** (warn verdict).
- Style / naming / comment issues → **low**.

---

## QA

**Role**: tests, coverage, edge cases, regression risk.

Reviews the diff + the tests authored under this feature (both red tests from `test-driven-development` and green tests from `write-tests`). Specific checks:

- Are there tests for every public surface modified?
- Do tests cover the invariants declared in each `task.invariants[]`?
- Are edge cases covered? (empty, null, boundary values, concurrent access, failure modes from the PRD's `nonFunctionalRequirements`)
- Did the diff introduce any flaky-test patterns? (timing assumptions, network without mocks, order-dependent test state)
- Does `git diff` show any removal of pre-existing tests? If yes, is the removal justified (code being deleted) or a regression (coverage loss)?

Findings categories: `coverage` | `edge-case` | `flakiness` | `regression` | `missing-invariant-coverage`.

Severity mapping:
- A missing test for an invariant-bearing behaviour → **high**.
- Flaky pattern in a merged test → **high**.
- Missing edge-case coverage on a low-risk path → **low**.

QA does NOT run the mutation tester itself — that's the Mutation Testing member's job. QA reads the mutation score (after Mutation Testing records it) and may raise additional findings when the score is below target.

---

## Mutation Testing

**Role**: measure how robust the tests are against code mutations. Produces an empirical coverage-quality signal that transcends line/branch coverage percentages.

**Execution**:

- **JS/TS**: `npx stryker run --mutate <changed-files-glob>` (scoped, not whole-repo). Target: ≥70 mutation score.
- **Python**: `mutmut run --paths-to-mutate <changed-files>`.
- **Go**: `go-mutesting ./<changed-pkg>/...`.
- **Rust**: `cargo mutagen` (if installed) — skip with a warning if not.

Budget: scope mutation run to CHANGED files + their owning package only. Full-repo mutation runs are out of scope — too expensive.

Record in `codeReview.mutationTesting`:

```jsonc
{
  "ran": true,
  "tool": "stryker",
  "score": 75,
  "target": 70,
  "testsToUpdate": [
    {
      "testFile": "apps/api/src/__tests__/foo.test.ts",
      "changeNeeded": "assert exact numeric output, not truthiness (survived arithmetic mutation at foo.ts:42)",
      "reason": "boundary mutation survived — test asserts result > 0 but should assert result == 42"
    }
  ]
}
```

**CONSTRAINT**: do NOT alter any test file. Only record. `fix-findings` will dispatch `write-tests` (or the domain-specialist) to apply the changes.

Findings categories: `mutation`.

Severity mapping:
- Score below target AND a surviving mutation covers an invariant-bearing behaviour → **high**.
- Score below target on non-invariant code → **medium**.
- Score at/above target → no finding (mutation member still records the score for audit).

If the mutation tool is unavailable in the target repo (no installed runner, unsupported language), record:

```jsonc
{ "ran": false, "tool": null, "score": null, "target": 70, "testsToUpdate": [] }
```

and append a `globalWarnings[]` entry to the workflow. Do NOT block the code review.
