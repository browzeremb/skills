---
name: write-tests
description: "Writes or augments tests for a set of source files the caller passes in — or, when no file list is given, asks the operator which files to cover. Two modes: `red` (tests that MUST fail against current code, driven by `test-driven-development`) and `green` (tests that MUST pass after `execute-task` landed the change). Applies mutation-resistant test-design principles distilled from Stryker's operator list so that each test would catch at least one plausible mutation of the code it covers (boolean, conditional, arithmetic, boundary, return value, off-by-one). Auto-detects the repo's test runner via `scripts/detect-test-setup.mjs` (vitest, jest, pytest, go, cargo, rspec, etc.) and mirrors the repo's existing test layout — it does not impose a stack. Invoked as part of `orchestrate-task-delivery` after `execute-task` completes (green mode), and by `test-driven-development` before implementation (red mode). Skips itself with a one-line note if the repo has no test setup (no framework, no scripts, < 2 test files). Writes a `.meta/WRITE_TESTS_<ts>.json` report and emits the usual one-line confirmation. Triggers: 'write tests', 'add tests', 'test coverage for', 'cover these files with tests', 'unit tests for', 'test this', 'add test cases', 'write a failing test', 'write the red test', 'write the green test', 'spec these files', 'tests for this change'."
argument-hint: "[files: <paths>; mode: red|green|auto; feat dir: <path>]"
allowed-tools: Bash(browzer *), Bash(node *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Read, Write, Edit, AskUserQuestion
---

# write-tests — produce mutation-resistant tests for specified files

An auxiliary skill that lives between `execute-task` and `update-docs` in the dev workflow, or immediately after `test-driven-development`. It does **one** thing: given a list of source files (or a set of files inferred from a change), write or augment tests that would fail under realistic mutations of the code they cover.

The skill is based on the principles in `superpowers:testing-strategies` and the mutation-operator taxonomy that Stryker / mutmut / go-mutesting encode. It does not invoke any of those skills or tools at write-time — it internalises the discipline.

Output contract: `../../README.md` §"Skill output contract" (relative to this SKILL.md).

---

## Phase 0 — Resolve input

The skill accepts several shapes, in order of preference:

```
Skill(skill: "write-tests", args: "files: apps/api/src/routes/auth.ts apps/api/src/middleware/rbac.ts; mode: green; feat dir: docs/browzer/feat-20260423-rbac-tighten/")
Skill(skill: "write-tests", args: "files: apps/api/src/auth.ts; mode: red")
Skill(skill: "write-tests", args: "mode: auto")      # will ask the operator which files to cover
Skill(skill: "write-tests")                           # interactive
```

### 0.1 Files

- **Explicit `files:`** — the caller knows what the change touched (orchestrator, TDD skill). Take the list verbatim; do not expand scope. If any listed file doesn't exist, treat it as a `red`-mode signal (the file is about to be created) and ask the operator to confirm.
- **No `files:`** — ask the operator, one question:

  > Which source files should I write tests for? Paste paths (space- or newline-separated), or say `changed` to take the list from `git diff --name-only $(git merge-base HEAD main)..HEAD`.

  Accept either a list or the `changed` shortcut.

### 0.2 Mode

- `red` — tests must fail against the *current* code (TDD red phase). The code either doesn't exist yet or is missing the behaviour under test.
- `green` — tests must pass against the *current* code (post-`execute-task`, covering the new behaviour).
- `auto` (default) — decide per-file:
  - If the file doesn't exist OR has no implementation of the feature named in the task spec → `red`.
  - Otherwise → `green`.

State the mode in chat before writing, so the operator can veto:

> write-tests: mode=green · 3 files in scope · feat dir docs/browzer/feat-20260423-rbac-tighten/

### 0.3 Feat folder

Reuse the workflow convention. Preference: explicit `feat dir:` in args. Fallback: newest `docs/browzer/feat-*/` dir, same as `update-docs` §0.2. If none exists, write the report to `docs/browzer/feat-$(date -u +%Y%m%d)-standalone-write-tests/.meta/`.

---

## Phase 1 — Detect the repo's test setup

Run the shared detector bundled with this plugin. The skill directory is not reliably resolvable from the subagent's CWD — invoke via the plugin's scripts dir (the skill runs in the operator's repo, not the plugin):

```bash
# The plugin ships scripts/detect-test-setup.mjs at packages/skills/scripts/.
# When the skill runs in the operator's repo it needs to find the plugin's
# scripts dir. The canonical discovery path is:
#   1. $CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs (set by runtime)
#   2. $HOME/.claude/plugins/**/browzer/scripts/detect-test-setup.mjs
#   3. Inline fallback (see §1.1)

node "$CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs" --repo . > /tmp/write-tests-setup.json 2>&1 \
  || node "$(find ~/.claude/plugins -type f -name 'detect-test-setup.mjs' 2>/dev/null | head -1)" --repo . > /tmp/write-tests-setup.json
```

Parse the JSON. Key fields:

- `hasTestSetup` — if false, **stop**. Emit:

  ```
  write-tests: skipped — no test setup detected (<hint from detector>); 0 tests written
  ```

  Do NOT create a test framework from scratch unless the caller explicitly invoked the skill with `--bootstrap` (reserved for future use; out of scope here).

- `runners` — first entry (highest confidence) is the framework you'll write against.
- `testCommand` — the command the skill runs to verify red/green.
- `language` — selects the test-file layout + naming convention.

### 1.1 Inline fallback (detector not found)

If neither path resolves (the plugin wasn't shipped with this script for some reason), fall back to:

```bash
test -f package.json && cat package.json | node -e "let j=JSON.parse(require('fs').readFileSync(0)); console.log(JSON.stringify({test: j.scripts?.test||null, framework: Object.keys({...j.devDependencies||{}, ...j.dependencies||{}}).find(d => ['vitest','jest','mocha','@playwright/test'].includes(d))}))" || true
test -f pyproject.toml && echo 'python-pytest' || true
test -f go.mod && echo 'go' || true
```

Surface whatever you find and pick a reasonable runner. If nothing detects, stop with the skip line above.

---

## Phase 2 — Ground each target file in the repo

For each file in scope, extract the real shape — don't assume.

```bash
browzer explore "<basename of the file>" --json --save /tmp/write-tests-explore-<slug>.json
browzer deps "<path>" --json --save /tmp/write-tests-deps-<slug>.json
```

From the results, harvest:

- **Exports** — the public surface you'll assert against. Don't write tests for private/internal helpers.
- **ImportedBy** — real consumers. When writing `green` tests, one good pattern is to mirror how a real consumer uses the file (integration over pure unit, when feasible).
- **Line ranges** of the functions under test.
- **Existing sibling tests** — if `<module>.test.<ext>` already exists, you augment (not overwrite). Read it first.

If browzer returns nothing useful (new file, missing index), fall back to `Read` on the file itself plus `ls` on the likely test directory (`__tests__/`, `tests/`, same-dir sibling).

---

## Phase 3 — Read each file and enumerate behaviours

For each file, read it in full (or the line range browzer returned). List every *observable behaviour* you'd cover:

1. The happy path per exported function / method / class / endpoint.
2. Every `if` / `switch` / pattern-match branch — each one is a test case.
3. Every boundary: empty input, maximum input, zero, negative, null, undefined, whitespace-only, very-long.
4. Every `throw` / `raise` / `panic` / error return — the error path is a test case.
5. Every async / retry / timeout path, if the code has them.
6. Every external effect (DB call, HTTP call, queue push) — test it **happens** with the right arguments, not just that the code doesn't crash.

Cap the behaviours at **~8 per file** for a single invocation. If a file has more, note the excess as `deferred` in the report and ask the operator whether to widen scope.

---

## Phase 4 — Design tests to survive mutations

For each behaviour, a test passes this quality bar only if it would **fail** under at least one plausible mutation of the code it covers. This is the Stryker-inspired discipline — see `references/mutation-principles.md` for the full operator taxonomy.

### Operator checklist (run each test through it mentally before writing)

| Mutation                              | Test must catch? | Typical shape                                   |
| ------------------------------------- | ---------------- | ----------------------------------------------- |
| `<` → `<=`, `>` → `>=` (boundary)     | yes              | Assert at the exact boundary AND one past it.   |
| `&&` → `\|\|`, `\|\|` → `&&` (logical) | yes              | Have at least one test per branch of compound conditions. |
| `true` → `false` (literal)            | yes              | Don't stub with a dummy `true`; pass real inputs. |
| `+` → `-`, `*` → `/` (arithmetic)     | yes              | Assert exact numeric outcome, not truthiness.   |
| `return x` → `return`                 | yes              | Assert on the return value, never on the call itself. |
| `if (x)` → `if (true)`                | yes              | At least one test must take the FALSE branch.   |
| Loop off-by-one                       | yes              | Test with length 0, 1, N, and N+1 inputs.       |
| Early-return removed                  | yes              | Test that side effects DON'T happen when they shouldn't. |
| String literal replaced               | yes              | Assert on exact strings where semantic (error messages, type tags). |

A test that passes under all of the above is a *useless* test — it's verifying mock behaviour, not code behaviour. Rewrite it.

### Anti-patterns (do NOT commit these)

- **Testing mock behaviour** — `expect(screen.getByTestId('sidebar-mock'))`. Unmock or test real behaviour.
- **Production `destroy()` / `__reset()` / `setMock*()` methods** — put test cleanup in a test util, not the production class.
- **Partial mocks** — if you mock, mirror the real API completely; don't omit fields the code-under-test consumes.
- **Over-mocking** — mocking the thing whose side effects the test depends on.
- **Tests without assertions** — if a test has zero `expect` / `assert`, delete it.
- **Tautological tests** — `expect(sum(2, 2)).toBe(sum(2, 2))`. Compute the expected value independently.

(Full reasoning + examples in `references/mutation-principles.md`.)

---

## Phase 5 — Write the tests

Mirror the repo's existing conventions. If `src/__tests__/*.test.ts` is the pattern, use it. If `<src>.spec.ts` sibling is the pattern, use it. If both exist, match the closest sibling's style. Preserve:

- **Imports** — same order/style as the sibling.
- **Setup** — use existing `beforeEach` / `beforeAll` utilities if they're colocated.
- **Assertion library** — don't pull in `expect` if the repo uses `assert`; don't pull in `chai` if the repo uses `vitest`'s `expect`.
- **Async patterns** — `async/await` vs `.then` must mirror existing tests.
- **Fixture locations** — `fixtures/`, `__fixtures__/`, `test-data/` — put new fixtures where existing ones live.
- **File headers** — copyright / license banners if the file has them.

Per the formatter-delegation rule (`../../references/subagent-preamble.md` §Formatter delegation), do NOT run `biome check --write` / `prettier --write` / `ruff format` / etc. after writing the tests — the plugin's auto-format hook takes care of it in Browzer-initialised repos. Keep linter rule checks and typechecks in the verification step.

### Red-mode specifics

- Each test MUST reference the target feature by name / signature as if it existed.
- Each test MUST have a real assertion that would fail against the current code — not a `.todo` / `.skip` marker.
- After writing, run the test runner and capture the failure. If any red test passes, the test is wrong — fix before proceeding.

### Green-mode specifics

- Each test MUST pass against the current code.
- If a test fails after writing, either the test is wrong OR the code has a bug. Read both carefully before deciding. If the test is right and the code is wrong, STOP and surface the regression under `warnings` — do not fix the code from this skill.

---

## Phase 6 — Verify

Run the test runner, scoped to the files you wrote:

```bash
# Derive the command from signals.scripts.test or runners[0].testCommand in /tmp/write-tests-setup.json.
# Pass the specific test files as positional args when the runner supports it:

<testCommand> <path/to/new-test-file-1> <path/to/new-test-file-2>

# Examples:
#   pnpm vitest run apps/api/src/__tests__/auth.test.ts
#   pytest apps/api/tests/test_auth.py
#   go test ./apps/api/auth -run TestAuth
#   cargo test --lib auth::
```

### Red mode

- All written tests MUST fail.
- Each failure MUST be the expected shape (e.g., "expected 'rejects empty email', got undefined") — not a typo, not a missing import, not a syntax error.
- If any test passes, the test is wrong — rewrite and re-run.

### Green mode

- All written tests MUST pass.
- The full repo-wide test suite MUST still be green (no regressions introduced by shared fixtures).
  - Run `<testCommand>` without file filters if feasible. If the full suite is too slow or requires infra that isn't up (Docker, Neo4j), run the nearest scoped filter (`--filter=<pkg>` in turborepo, `pytest <pkg>/` in python) and note the narrowing under `warnings`.
- If any new test fails, investigate. Do NOT commit failing green-mode tests.

---

## Phase 7 — Write the report

Create `<FEAT_DIR>/.meta/WRITE_TESTS_<timestamp>.json`:

```json
{
  "skill": "write-tests",
  "timestamp": "20260423T120000Z",
  "featDir": "docs/browzer/feat-20260423-rbac-tighten/",
  "mode": "green",
  "filesInScope": ["apps/api/src/routes/auth.ts", "apps/api/src/middleware/rbac.ts"],
  "testsWritten": [
    {
      "source": "apps/api/src/routes/auth.ts",
      "testFile": "apps/api/src/__tests__/auth.test.ts",
      "cases": 6,
      "mutations": {
        "covered": ["boundary", "logical", "return", "early-exit", "string-literal"],
        "notCovered": []
      }
    }
  ],
  "testsAugmented": [],
  "testsSkipped": [
    {
      "source": "apps/api/src/lib/legacy-utils.ts",
      "reason": "pre-existing, not in change scope"
    }
  ],
  "runner": { "name": "vitest", "command": "pnpm turbo test --filter=@browzer/api" },
  "verification": {
    "status": "pass",
    "testsExecuted": 49,
    "testsFailed": 0,
    "redTestsFailedAsExpected": 0
  },
  "warnings": []
}
```

---

## Phase 8 — One-line confirmation

Success:

```
write-tests: wrote <N> test cases across <F> files (mode: <red|green>); report at <FEAT_DIR>/.meta/WRITE_TESTS_<ts>.json
```

Examples:

```
write-tests: wrote 14 test cases across 3 files (mode: green); report at docs/browzer/feat-20260423-rbac-tighten/.meta/WRITE_TESTS_20260423T120000Z.json
write-tests: wrote 5 test cases across 1 file (mode: red); report at .meta/WRITE_TESTS_20260423T093000Z.json
```

Skip (no test setup):

```
write-tests: skipped — no test setup detected (<detector hint>); 0 tests written
```

Warnings append with `;`:

```
write-tests: wrote 6 test cases across 2 files (mode: green); report at .meta/WRITE_TESTS_...json; ⚠ full suite not run — requires Docker infra
```

Failure:

```
write-tests: failed — <one-line cause>
hint: <single next step>
```

---

## Invocation modes

- **After `execute-task` (green mode, common)** — `orchestrate-task-delivery` passes `files:` from `HANDOFF_NN.json`'s `files.created` + `files.modified`.
- **Before `execute-task` (red mode)** — `test-driven-development` calls this skill with the task's Scope-block files and `mode: red`. Tests drive the RED → GREEN → REFACTOR cycle.
- **Standalone** — operator invokes directly to patch test coverage. Interactive file-selection.
- **Skipped** — when the detector returns `hasTestSetup: false`. Not a failure; just a no-op with a warning.

---

## Non-negotiables

- **Output language: English** for test file comments, test names, JSON report, and the confirmation line. Conversational wrapper follows the operator's language.
- **No new test frameworks** without operator approval. If the repo has no test setup, skip — don't bootstrap one.
- **Never silently edit code-under-test.** Green-mode tests that fail are a regression signal, not a license to edit source.
- **Never bypass the mutation checklist.** A test that can't catch any of the 9 operators is theatre — rewrite it.
- **Never use Stryker at write-time.** That belongs to `verification-before-completion`. This skill internalises the principle; the runner runs there.

---

## Related skills and references

- `test-driven-development` — red-mode caller; drives the TDD loop before `execute-task`.
- `execute-task` — green-mode caller via the orchestrator; lands the change `write-tests` then covers.
- `verification-before-completion` — runs mutation testing (Stryker or equivalent) AFTER `write-tests` has produced the initial suite.
- `update-docs` — next phase; patches docs that reference the tested surface.
- `references/mutation-principles.md` — the Stryker-inspired operator list + anti-patterns, with examples.
- `superpowers:testing-strategies`, `superpowers:test-driven-development` — conceptual parents; not invoked at runtime.
