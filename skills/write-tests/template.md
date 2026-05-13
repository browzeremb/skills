# Write-tests template

Single artefact: `docs/browzer/<feat>/staging/TESTS.md`. LLM-authored
aggregate with frontmatter `testsAdded[]` array consumed by
feature-acceptance.

---

## Frontmatter (REQUIRED)

```yaml
---
featureId: feat-YYYYMMDD-<slug>
prdSha: <SHA mirrored from upstream phases>
generatedAt: <RFC3339>
runner: vitest | jest | pytest | go test | cargo test | null
mutationTool: stryker | mutmut | go-mutesting | null
skipped: false                              # true when host has no test infra
skipReason: "<rationale>"                   # REQUIRED when skipped == true
summary:
  totalTests: <int>
  killedMutants: <int>
  totalMutants: <int>
  killRate: <float ∈ [0,1]>                 # killedMutants / totalMutants; 0 when totalMutants == 0
  coverageGaps: <int>
testsAdded:
  - testId: T-1
    file: <repo-relative path to test file>
    symbolUnderTest: <path>::<dottedName>   # the source symbol the test covers
    intent: green | red | chaos
    killedMutants: <int>
    totalMutants: <int>
    pinsTestSpec: T-1                       # mirror from TASK_NN.completed.md.testSpecs[].testId when applicable
    pinsAcs: [AC-NN, ...]                   # OPTIONAL — mirrors testSpec.pinsAcs
    pinsFrs: [FR-NN, ...]                   # OPTIONAL — mirrors testSpec.pinsFrs
mutationCategoriesCovered:                  # 6 canonical categories — must list those killed at least once
  - boolean
  - conditional
  - arithmetic
  - boundary
  - off-by-one
  - return-value
---
```

---

## Body (REQUIRED)

```markdown
# Tests added

## Coverage log

### Files modified
- (regex-strict per ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md Block 1; test files updated)

### Files created
- (regex-strict — Block 2; new test files)

### Tests added
- (regex-strict — Block 4: `T-N <file>::<symbol> <intent> <killed>/<total>`)

## Mutation analysis

<one paragraph summarizing kill rate per category. Surface any category
with 0 kills as a coverage gap.>

## Coverage gaps

<sub-section ONLY when summary.coverageGaps > 0:
list each gap with file::symbol and the reason it's gapped. The
80% gate in feature-acceptance reads these.>

## Surviving mutants

<sub-section ONLY when survived count > 0:
per surviving mutant: location, mutant kind, rationale (why unkillable
or accepted). Aggregate kill rate excludes formally-accepted survivors
from the denominator.>

## Skipped (only when frontmatter.skipped == true)

<rationale paragraph: why no tests could be authored. Examples: "host
has no test runner declared in package.json", "language not supported by
mutation tooling — Stryker/mutmut/go-mutesting do not cover Rust", etc.>
```

---

## Cross-reference invariants

1. Every `testsAdded[].file` path MUST exist on disk after this phase runs.
2. Every `testsAdded[].symbolUnderTest` MUST follow `<repo-relative path>::<dottedName>` schema. The path prefix MUST appear in some upstream `### Files modified` or `### Files created` block (TASK_*.completed.md or FIX_*.completed.md).
3. `summary.killedMutants + survived == summary.totalMutants`.
4. `summary.killRate == round(summary.killedMutants / max(summary.totalMutants, 1), 2)`.
5. When `skipped == true`, ALL of `testsAdded[]`, `runner`, `mutationTool`, `summary.*` MAY be empty/null/zero; `skipReason` is the only required content field.
6. `mutationCategoriesCovered[]` MUST be a subset of the 6 canonical names. Missing categories surface as coverage gaps.
7. `testsAdded[].pinsTestSpec` MAY reference a `TASK_NN.completed.md.testSpecs[].testId` to provide spec traceability — REQUIRED when the test was authored from an explicit testSpec; OMITTED when the test was authored from a code-review finding (track via `pinsAcs[]`/`pinsFrs[]` instead).
