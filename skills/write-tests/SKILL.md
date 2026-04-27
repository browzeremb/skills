---
name: write-tests
description: "Authors green tests after code changes. Invoked in two contexts: (1) inside execute-task for non-TDD tasks, after the domain-specialist writes code; (2) inside fix-findings after a correction dispatch, to cover the fix. Reads .task.reviewer.testSpecs[] | select(.type==\"green\") from workflow.json when available; otherwise derives coverage from file diffs using browzer deps + domain conventions. Applies mutation-resistant test-design principles (Stryker-style operator checklist) so each test catches at least one plausible mutation (boolean, conditional, arithmetic, boundary, return value, off-by-one). Auto-detects the repo's test runner via scripts/detect-test-setup.mjs and mirrors existing layout. Skips itself if the repo has no test setup. Triggers: 'write tests', 'add tests', 'test coverage for', 'cover these files with tests', 'unit tests for', 'test this', 'add test cases', 'write the green test', 'spec these files', 'tests for this change'."
argument-hint: "[files: <paths>; step: STEP_NN_TASK_MM; feat dir: <path>]"
allowed-tools: Bash(browzer *), Bash(node *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(pnpm *), Bash(pytest *), Bash(go *), Bash(jq *), Bash(mv *), Read, Write, Edit, AskUserQuestion
---

# write-tests — green tests after a code change

An auxiliary skill that authors green tests (tests that MUST pass against the current code) for a set of source files or a task step. **No red mode** — red tests are owned exclusively by `test-driven-development`, which reads `testSpecs` authored by `generate-task.reviewer`.

Two invocation contexts:

1. **Inside `execute-task`** — for non-TDD tasks, the domain-specialist invokes this at end of its scope to author green coverage.
2. **Inside `fix-findings`** — after a correction dispatch lands, to cover the fix.

Output contract: emit ONE confirmation line on success.

---

## Phase 0 — Resolve input

Accepted shapes, in order of preference:

```
Skill(skill: "write-tests", args: "step: STEP_04_TASK_01; feat dir: docs/browzer/feat-<slug>/")
Skill(skill: "write-tests", args: "files: <package>/src/<file-a>.ts <package>/src/<file-b>.ts; feat dir: docs/browzer/feat-<slug>/")
Skill(skill: "write-tests", args: "files: <package>/src/<file>.ts")
Skill(skill: "write-tests")    # interactive
```

### 0.1 Resolve `FEAT_DIR` + `WORKFLOW`

Bind `FEAT_DIR` from args, newest `docs/browzer/feat-*/`, or operator reply. Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

### 0.2 Resolve the target files and green specs

If a `step:` is given, read green specs AND aggregated files from the task step:

```bash
STEP_ID="<resolved step id>"
GREEN_SPECS=$(jq --arg id "$STEP_ID" \
  '.steps[] | select(.stepId==$id) | .task.reviewer.testSpecs[] | select(.type=="green")' \
  "$WORKFLOW")
SCOPE_FILES=$(jq --arg id "$STEP_ID" '.steps[] | select(.stepId==$id) | .task.scope' "$WORKFLOW")
```

Use `GREEN_SPECS` as the authoritative coverage plan. Each spec's `file` + `description` + `coverageTarget` tells you exactly what to write. If `GREEN_SPECS` is empty but the task is TDD-applicable, you are being invoked post-implementation to cover what the `reviewer` didn't explicitly enumerate — derive from diffs.

If an explicit `files:` list is given (no `step:`), take it verbatim. Do not expand scope.

If neither is given, ask the operator, one question:

> Which source files should I write tests for? Paste paths (space- or newline-separated), or say `changed` to take the list from `git diff --name-only $(git merge-base HEAD main)..HEAD`.

State the mode in chat before writing:

> write-tests: 3 files in scope, 5 green specs from task reviewer (step STEP_04_TASK_01) · feat dir docs/browzer/feat-<slug>/

---

## Phase 1 — Detect the repo's test setup

Run the shared detector bundled with this plugin:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs" --repo . > /tmp/write-tests-setup.json 2>&1 \
  || node "$(find ~/.claude/plugins -type f -name 'detect-test-setup.mjs' 2>/dev/null | head -1)" --repo . > /tmp/write-tests-setup.json
```

Parse the JSON. Key fields:

- `hasTestSetup` — if false, **stop**. Emit the skip line in Phase 6.
- `runners` — first entry (highest confidence) is the framework you'll write against.
- `testCommand` — the command the skill runs to verify green.
- `language` — selects the test-file layout + naming convention.

### 1.1 Inline fallback (detector not found)

If neither path resolves, fall back to:

```bash
test -f package.json && cat package.json | node -e "let j=JSON.parse(require('fs').readFileSync(0)); console.log(JSON.stringify({test: j.scripts?.test||null, framework: Object.keys({...j.devDependencies||{}, ...j.dependencies||{}}).find(d => ['vitest','jest','mocha','@playwright/test'].includes(d))}))" || true
test -f pyproject.toml && echo 'python-pytest' || true
test -f go.mod && echo 'go' || true
```

Surface whatever you find and pick a reasonable runner. If nothing detects, stop with the skip line.

---

## Phase 2 — Ground each target file in the repo

For each file in scope, extract the real shape — don't assume.

```bash
browzer explore "<basename of the file>" --json --save /tmp/write-tests-explore-<slug>.json
browzer deps "<path>" --json --save /tmp/write-tests-deps-<slug>.json
```

From the results, harvest:

- **Exports** — the public surface you'll assert against.
- **ImportedBy** — real consumers. Green tests benefit from mirroring how real consumers use the file (integration over pure unit, when feasible).
- **Line ranges** of the functions under test.
- **Existing sibling tests** — if `<module>.test.<ext>` already exists, you augment (not overwrite). Read it first.

If browzer returns nothing useful (new file, missing index), fall back to `Read` on the file plus `ls` on the likely test directory.

---

## Phase 3 — Enumerate behaviours

### 3a — When `GREEN_SPECS` is non-empty (authoritative)

For each spec:
- `file` is the target test file.
- `description` describes the behaviour (map to a single `it`/`test` case).
- `coverageTarget` tells you what mutation class to prioritise (`function`, `branch`, `boundary`).

You may add additional complementary cases the reviewer didn't enumerate, but only when they fit within the spec's coverage intent. Flag any additions under `notes` in the agent entry.

### 3b — When deriving from file diffs (no spec)

For each file, read it (or the line range browzer returned). List every *observable behaviour*:

1. The happy path per exported function / method / class / endpoint.
2. Every `if` / `switch` / pattern-match branch — each one is a test case.
3. Every boundary: empty input, maximum input, zero, negative, null, undefined, whitespace-only, very-long.
4. Every `throw` / `raise` / `panic` / error return — the error path is a test case.
5. Every async / retry / timeout path.
6. Every external effect (DB call, HTTP call, queue push) — test it **happens** with the right arguments.

Cap at **~8 per file** for a single invocation. If more, note excess as `deferred` and ask.

---

## Phase 4 — Design tests to survive mutations

For each behaviour, a test passes this quality bar only if it would **fail** under at least one plausible mutation of the code it covers. See `references/mutation-principles.md` for the full operator taxonomy.

### Operator checklist (mentally run each test through it before writing)

| Mutation                              | Test must catch? | Typical shape                                   |
| ------------------------------------- | ---------------- | ----------------------------------------------- |
| `<` → `<=`, `>` → `>=` (boundary)     | yes              | Assert at the exact boundary AND one past it.   |
| `&&` → `\|\|`, `\|\|` → `&&` (logical) | yes              | At least one test per branch of compound conditions. |
| `true` → `false` (literal)            | yes              | Don't stub with a dummy `true`; pass real inputs. |
| `+` → `-`, `*` → `/` (arithmetic)     | yes              | Assert exact numeric outcome, not truthiness.   |
| `return x` → `return`                 | yes              | Assert on the return value, never on the call itself. |
| `if (x)` → `if (true)`                | yes              | At least one test must take the FALSE branch.   |
| Loop off-by-one                       | yes              | Test with length 0, 1, N, and N+1 inputs.       |
| Early-return removed                  | yes              | Test that side effects DON'T happen when they shouldn't. |
| String literal replaced               | yes              | Assert on exact strings where semantic (error messages, type tags). |

A test that passes under all of the above is a *useless* test.

### Anti-patterns (do NOT commit these)

- **Testing mock behaviour**.
- **Production `destroy()` / `__reset()` / `setMock*()` methods** — put test cleanup in a test util.
- **Partial mocks** — if you mock, mirror the real API; don't omit fields the code-under-test consumes.
- **Over-mocking** — mocking the thing whose side effects the test depends on.
- **Tests without assertions**.
- **Tautological tests** — compute expected values independently.

(Full reasoning + examples in `references/mutation-principles.md`.)

---

## Phase 5 — Write the tests + verify green

Mirror the repo's existing conventions. Preserve imports, `beforeEach` fixtures, assertion library, async style, fixture locations, file headers.

Per the formatter-delegation rule (`references/subagent-preamble.md` §Formatter delegation), do NOT run `biome check --write` / `prettier --write` / `ruff format` after writing — the plugin's auto-format hook runs in-loop.

### Verify green

Run the test runner scoped to the files you wrote:

```bash
<testCommand> <path/to/new-test-file-1> <path/to/new-test-file-2>

# Examples:
#   pnpm vitest run <package>/src/__tests__/<file>.test.ts
#   pytest <package>/tests/test_<file>.py
#   go test ./<package>/<area> -run Test<Name>
#   cargo test --lib auth::
```

Every newly authored test MUST pass. The full repo-wide test suite MUST still be green (no regressions introduced by shared fixtures). If a test fails after writing, either the test is wrong OR the code has a bug — read both carefully. If the test is right and the code is wrong, STOP and surface the regression under `warnings`. Do NOT fix the code from this skill.

---

## Phase 6 — Update workflow.json

Append a write-tests agent entry into the task step's `.task.execution.agents[]` (or the fix-findings step's dispatches[] when invoked by fix-findings). Use jq + atomic rename:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AGENT=$(jq -n \
  --arg now "$NOW" \
  --argjson filesAuthored '<array of test file paths>' \
  --argjson greenCount '<number of green tests authored>' \
  '{
     role: "test-author",
     skill: "write-tests",
     model: env.AGENT_MODEL // "sonnet",
     status: "completed",
     startedAt: $now,
     completedAt: $now,
     notes: ("\($greenCount) green tests authored/augmented in " + ($filesAuthored | join(", ")))
   }')

jq --arg id "$STEP_ID" \
   --argjson agent "$AGENT" \
   --arg now "$NOW" \
   '(.steps[] | select(.stepId==$id)) |= (
      .task.execution = ((.task.execution // {}) + {
        agents: (((.task.execution.agents // []) | map(select(.role != "test-author"))) + [$agent])
      })
    )
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

When invoked by `fix-findings`, attach to the fixFindings step's `dispatches[]` rather than a task's `agents[]`. The caller passes the target step id.

---

## Phase 7 — One-line confirmation

Success:

```
write-tests: wrote <N> test cases across <F> files; all green
```

Examples:

```
write-tests: wrote 14 test cases across 3 files; all green
write-tests: wrote 5 test cases across 1 file; all green
```

Skip (no test setup):

```
write-tests: skipped — no test setup detected (<detector hint>); 0 tests written
```

Warnings append with `;`:

```
write-tests: wrote 6 test cases across 2 files; all green; ⚠ full suite not run — requires Docker infra
```

Failure:

```
write-tests: stopped — <one-line cause>
hint: <single next step>
```

---

## Invocation modes

- **Inside `execute-task` (non-TDD tasks)** — the domain-specialist invokes `Skill(write-tests, "step: <current STEP_ID>")` at end of its scope to cover the implementation with green tests.
- **Inside `fix-findings`** — after a correction dispatch lands, the orchestrator invokes this skill to cover the fix.
- **Standalone** — operator invokes directly to patch test coverage. Interactive file-selection.
- **Skipped** — when the detector returns `hasTestSetup: false`. Not a failure; a no-op with a warning.

---

## Non-negotiables

- **Output language: English** for test file comments, test names, JSON payload, and the confirmation line.
- **No red mode.** Red tests are authored exclusively by `test-driven-development`.
- **No new test frameworks** without operator approval. If the repo has no test setup, skip — don't bootstrap.
- **Never silently edit code-under-test.** Green-mode tests that fail are a regression signal, not a license to edit source.
- **Never bypass the mutation checklist.**
- `workflow.json` is mutated ONLY via `jq | mv`.

---

## Related skills and references

- `test-driven-development` — red-phase counterpart; authors failing tests BEFORE implementation for TDD-applicable tasks.
- `execute-task` — invokes this skill for non-TDD tasks post-implementation.
- `code-review` — runs AFTER write-tests; its mutation-testing agent assesses the coverage this skill produced.
- `references/workflow-schema.md` — authoritative schema (`task.reviewer.testSpecs`, `task.execution.agents`).
- `references/mutation-principles.md` — the Stryker-inspired operator list + anti-patterns, with examples.
- `superpowers:testing-strategies`, `superpowers:test-driven-development` — conceptual parents; not invoked at runtime.
