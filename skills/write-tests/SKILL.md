---
name: write-tests
description: "Author tests for the feature's changed code AND run mutation testing to verify the suite kills mutants across 6 categories (boolean, conditional, arithmetic, boundary, off-by-one, return-value). Auto-detects the host's runner (vitest, jest, pytest, go test, cargo test). Reads testSpecs[] from TASK_*.completed.md and findings from CODE_REVIEW.md / FIX_*.completed.md. Skips cleanly when host has no test infra. Triggers: write tests, add tests, test coverage for, unit tests for, test this, mutation testing, stryker, mutmut, kill mutants, tests for this change, spec these files."
argument-hint: "<featureId>"
---

You are a test-author dispatcher. Author green coverage AND verify the
suite kills mutants. Aggregate into a single TESTS.md.

## Inputs

- `$ARGUMENTS` is the `<featureId>`.
- This skill reads:
  - `docs/browzer/<featureId>/staging/TASK_*.completed.md` frontmatter (`testSpecs[]` with `pinsAcs[]`/`pinsFrs[]`) AND body `### Files modified` / `### Files created` (what to cover)
  - `docs/browzer/<featureId>/staging/FIX_*.completed.md` body `### Files modified` (additional surface from fix)
  - `docs/browzer/<featureId>/staging/CODE_REVIEW.md` frontmatter `findings[]` (orphan findings without testSpec mapping)
  - `docs/browzer/<featureId>/staging/RECEIVING_CODE_REVIEW.md` frontmatter (sanity check that fixes landed)

Does NOT read PRD.md or EXPLORATION.md — testSpecs already inline `pinsAcs[]`/`pinsFrs[]` with the relevant text from generate-task.

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/TESTS.md` | aggregate frontmatter + body |
| (source code) | new/edited test files in-place |

Frontmatter shape in `${CLAUDE_SKILL_DIR}/template.md`. Cross-reference
invariants documented there.

## Preflight (halt conditions)

1. **prdSha drift** — `git hash-object docs/browzer/<feat>/staging/PRD.md` must match the `prdSha` in RECEIVING_CODE_REVIEW.md (or CODE_REVIEW.md if no fixes). Mismatch HALTS.
2. **Upstream high-severity tech-debt without override** — same gate as receiving-code-review's post-wave check.

## Workflow

### Step 1 — Detect runner + mutation tool

Apply the cascade in `${CLAUDE_SKILL_DIR}/references/runner-detection.md`.
If no runner is detectable, skip cleanly:

- Write TESTS.md with `skipped: true`, `skipReason: "<rationale>"`, empty testsAdded[].
- Return: `write-tests: skipped (no test infra)`.

### Step 2 — Collect spec sources

Read every `TASK_*.completed.md` frontmatter. Collect `testSpecs[]` entries:

```yaml
testSpecs:
  - testId: T-1
    file: <test file path>
    intent: green | red | chaos
    scope: unit | integration | e2e | chaos
    description: ...
    pinsAcs: [AC-NN, ...]
    pinsFrs: [FR-NN, ...]
```

For findings without testSpec correspondence (e.g. orphans from
CODE_REVIEW.md), synthesize a spec with `intent: red` and the finding's
`pinsAcs[]` / `pinsFiles[]`.

### Step 3 — Dispatch tester subagent

Compose the dispatch prompt using the compact template at
`${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`:

- **Block 1 — role lead line**: `You are a test author for feature <featureId>. Add coverage for the testSpecs below and verify the suite kills mutants across the 6 mutation categories.`
- **Block 2 — compact invariants**: substitute the seven-invariant template, filling `{{skills}}` with any `test-strategy`-tag-resolved skills from `EXPLORATION.md.skillsFound[]` (when accessible — write-tests does NOT read EXPLORATION; this data must be carried forward in `TASK_*.completed.md.frontmatter.skillsFound[]`), `{{files}}` from the union of every `testSpecs[].file` + every changed source file, `{{out-of-scope}}` = every other path.
- **Block 3 — code-subagent addendum** (path reference only): one line directing the subagent to `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md`. Do NOT paste-include the file.
- **Block 4 — testSpec list + changed-file list**: inlined verbatim (testId, file, intent, scope, description, pinsAcs, pinsFrs) plus runner + mutation tool detected in Step 1.
- **Block 5 — return-shape footer**: the tester return-shape line from the compact template.

Spawn with:

```
Agent(
  subagent_type: "browzer:tester",
  model: sonnet,
  effort: high,
  prompt: <composed>,
)
```

Append to the prompt: "Write your structured summary to `/tmp/write-tests-${featureId}-summary.json` (per the tester subagent contract). Return ONE LINE (≤200 tokens) — full details in the receipt and in the test files themselves."

### Step 4 — Aggregate

After the tester returns:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/aggregate-tests.mjs" "$ARGUMENTS"
```

The script reads the tester's `/tmp/write-tests-${featureId}-summary.json`
receipt and renders TESTS.md (frontmatter + body) atomically.

### Step 5 — Coverage-gap gate (warning, not halt)

Read TESTS.md.frontmatter.summary. If `killRate < 0.80` AND `skipped == false`:

- Surface a warning in the return line.
- Do NOT halt — coverage gaps are recorded; feature-acceptance decides.

## Done when

- TESTS.md exists with frontmatter + body.
- Every `testsAdded[].file` resolves to an existing file on disk (test files actually written).
- `summary.killedMutants + survived == summary.totalMutants` (or skipped == true).
- Return line: `write-tests: <N> tests added; kill rate <pct>%; <gaps> coverage gap(s)` OR `write-tests: skipped (<reason>)`.

## References

- `${CLAUDE_SKILL_DIR}/references/runner-detection.md` — runner + mutation tool detection cascade
- `${CLAUDE_SKILL_DIR}/references/mutation-principles.md` — mutation-resistant test patterns (legacy ref, still useful)
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer (substitute, do not paste-include)
- `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` — code-edit role addendum (referenced by path)
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (consult when authoring; not paste-included)
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — Tests added regex (Block 4)
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — staging-folder discipline + folder map
