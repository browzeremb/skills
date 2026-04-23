---
name: test-driven-development
description: "Enforces the Red-Green-Refactor TDD cycle around `execute-task`. When invoked (opt-in by default), writes failing tests FIRST via `write-tests` in red mode, verifies they fail for the right reason, then hands off to `execute-task` which writes the minimal implementation to turn them green. This skill is the RED phase — `execute-task` is the GREEN phase — so the operator actually watches the test fail before any production code is written. Integrated as a step inside `orchestrate-task-delivery`: it runs per-task BEFORE `execute-task`, and the orchestrator passes the Scope-block files so this skill knows what to cover. Accepts an `enabled` flag (default `true`) so the orchestrator or operator can opt out per-task — useful for throwaway prototypes, generated code, config-only changes, or tasks whose Scope is already entirely tests. Auto-skips when the repo has no test setup (via `scripts/detect-test-setup.mjs`). Writes a `.meta/TDD_<ts>.json` report. Triggers: 'tdd', 'test-driven development', 'write the test first', 'red first', 'failing test first', 'red-green-refactor', 'RGR', 'test first, then implement', 'tdd this', 'tdd loop', 'let's do tdd', 'red phase', 'write the failing test for'."
argument-hint: "[task: TASK_NN | files: <paths>; feat dir: <path>; enabled: true|false]"
allowed-tools: Bash(browzer *), Bash(node *), Bash(git *), Bash(date *), Bash(ls *), Bash(test *), Read, Write, AskUserQuestion
---

# test-driven-development — RED phase before `execute-task`

A discipline skill. Invoked BEFORE `execute-task` when the operator wants the TDD rigour: write the failing test, watch it fail for the right reason, then let `execute-task` produce the minimal code that turns it green.

This skill is based on the principles of `superpowers:test-driven-development` — it does **not** invoke that skill; it re-implements the discipline inside the Browzer plugin so this plugin ships self-contained.

Output contract: `../../README.md` §"Skill output contract".

---

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
```

If this skill is enabled for a task and you let `execute-task` touch production code before RED is verified, the discipline is broken. The skill's success criterion is not "wrote tests" — it's "wrote tests, verified they fail for the right reason, then passed control to the implementation phase with a known-red state."

---

## Phase 0 — Resolve input

Accepted argument shapes:

```
Skill(skill: "test-driven-development", args: "task: TASK_03 — spec at docs/browzer/feat-<slug>/TASK_03.md")
Skill(skill: "test-driven-development", args: "files: apps/api/src/routes/auth.ts apps/api/src/middleware/rbac.ts; feat dir: docs/browzer/feat-<slug>/")
Skill(skill: "test-driven-development", args: "enabled: false")
```

### 0.1 `enabled` flag

- Default: **`true`** — run the TDD cycle.
- `enabled: false` — skill is a no-op. Emit `test-driven-development: skipped — disabled by caller` and return control immediately. The orchestrator typically sets `enabled: false` when the task's Scope is entirely test files (no production code), or when the operator explicitly opted out.

### 0.2 Task or files

One of these MUST be present (unless `enabled: false`):

- `task: TASK_NN — spec at …` — read the task spec, extract the Scope-block files, use those.
- `files: <paths>` — take the list verbatim.

If neither is provided, ask the operator (single question):

> Which source files should the RED tests cover? Paste paths (space-separated), or say `TASK_NN` to pull Scope from the task spec.

### 0.3 State in chat

```
test-driven-development: enabled · <N> source files in scope · feat dir <path>
```

One line, so the operator can veto before any write.

---

## Phase 1 — Detect test setup (shared detector)

Run the same detector `write-tests` and `verification-before-completion` use:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs" --repo . > /tmp/tdd-setup.json 2>&1 \
  || node "$(find ~/.claude/plugins -type f -name 'detect-test-setup.mjs' 2>/dev/null | head -1)" --repo . > /tmp/tdd-setup.json
```

If `hasTestSetup` is false, emit:

```
test-driven-development: skipped — no test setup detected (<hint>); RED phase cannot run
```

…and return control. The orchestrator SHOULD still run `execute-task` in this case (there's no TDD discipline to enforce), but the orchestrator — not this skill — decides.

---

## Phase 2 — Is RED even applicable?

Some tasks genuinely should NOT trigger TDD. Check each before proceeding:

| Signal                                                                | RED applies? |
| --------------------------------------------------------------------- | ------------ |
| Scope files are ALL `*.test.*` / `*_test.*` / `__tests__/*`           | **no** — task IS tests; run `execute-task` directly |
| Task description says `generated`, `codegen`, `scaffold`, `migration` | **no** — auto-generated output                       |
| Task is pure config (edits `.json`, `.yaml`, `.toml`, `.env`)         | **no** — no behaviour to test                        |
| Task is pure documentation (edits `.md` only)                         | **no**                                               |
| Task is a refactor with no behaviour change                           | **maybe** — ask operator                             |
| Anything else                                                         | **yes**                                              |

If RED doesn't apply, emit:

```
test-driven-development: skipped — <reason>; 0 tests written
```

Pass control back to the orchestrator.

---

## Phase 3 — Delegate RED to `write-tests`

This skill does not write tests itself — it invokes `write-tests` with `mode: red`. That skill already knows the repo's test layout, assertion library, and mutation-resistance heuristics. Duplicating that logic here would drift out of sync.

```
Skill(skill: "write-tests", args: "files: <list>; mode: red; feat dir: <FEAT_DIR>")
```

Wait for `write-tests` to return. Its confirmation line names the path to `WRITE_TESTS_<ts>.json`.

---

## Phase 4 — Verify RED

Read `WRITE_TESTS_<ts>.json`. Check:

- `verification.status` is `pass` — in red-mode, "pass" means "every red test failed as expected".
- `verification.redTestsFailedAsExpected` equals `verification.testsExecuted` (i.e. EVERY written test failed).
- `warnings` is empty or only contains informational items.

If any red test **passed** (the feature the test exercises is already implemented or the assertion is wrong), that's a RED-phase failure. Surface:

```
test-driven-development: failed — <N> red tests passed against current code (tests are wrong, or feature already exists)
hint: review <test-file-paths>; fix assertions or mark the task as "behaviour already present"
```

Do NOT proceed to `execute-task` — that would ship code "covered" by tests that never exercised it.

If any red test **errored** (syntax error, missing import, compile failure) — that's also a RED-phase failure. Fix the test (re-invoke `write-tests`), don't fix the error and proceed.

---

## Phase 5 — Hand off to GREEN (`execute-task`)

With RED confirmed, the skill's responsibility ends. The orchestrator now dispatches `execute-task` as normal — `execute-task` reads the task spec from `docs/browzer/feat-<slug>/TASK_NN.md`, implements the feature, and runs the repo's quality gates (including the tests `write-tests` just wrote, which MUST flip from red to green).

This skill does NOT invoke `execute-task` itself — the orchestrator owns phase sequencing. This skill's final act is the confirmation line + report.

### If the operator invoked this skill directly (no orchestrator)

Surface a one-line note about the next step:

```
test-driven-development: red verified (<N> failing tests); next: run `execute-task` to implement and turn them green
```

…and stop. Don't auto-dispatch `execute-task` from here; the operator owns that call.

---

## Phase 6 — Write the report

Create `<FEAT_DIR>/.meta/TDD_<timestamp>.json`:

```json
{
  "skill": "test-driven-development",
  "timestamp": "20260423T110000Z",
  "featDir": "docs/browzer/feat-20260423-rbac-tighten/",
  "enabled": true,
  "applicability": {
    "applicable": true,
    "reason": null
  },
  "filesInScope": ["apps/api/src/routes/auth.ts", "apps/api/src/middleware/rbac.ts"],
  "delegate": {
    "skill": "write-tests",
    "mode": "red",
    "reportPath": ".meta/WRITE_TESTS_20260423T110100Z.json"
  },
  "redVerification": {
    "status": "confirmed",
    "testsWritten": 8,
    "testsFailedAsExpected": 8,
    "unexpectedPasses": 0,
    "unexpectedErrors": 0
  },
  "handoff": {
    "nextPhase": "execute-task",
    "taskId": "TASK_03"
  },
  "warnings": []
}
```

If this skill skipped (disabled or not applicable), still write the report with the right `enabled` / `applicability` flags. Downstream phases will check the report to know whether RED ran.

---

## Phase 7 — One-line confirmation

Applicable + ran (when the caller identified a specific `TASK_NN`):

```
test-driven-development: red verified (<N> failing tests, <F> files covered); next: execute-task TASK_NN; report at .meta/TDD_<ts>.json
```

The explicit `next: execute-task TASK_NN` clause tells the orchestrator (or a human reader scanning the log) exactly what follows — the skill itself does not auto-dispatch, but the coordination hop is unambiguous. Drop the clause when the caller didn't provide a `TASK_NN` (e.g. direct invocation with a raw `files:` list):

```
test-driven-development: red verified (<N> failing tests, <F> files covered); next: run `execute-task` to implement and turn them green; report at .meta/TDD_<ts>.json
```

Skipped (disabled, not applicable, or no test setup):

```
test-driven-development: skipped — <reason>; 0 tests written
```

Warnings append with `;`:

```
test-driven-development: red verified (8 failing tests, 2 files covered); next: execute-task TASK_03; report at .meta/TDD_...json; ⚠ 1 red test needed 2 attempts to formulate cleanly
```

Failure:

```
test-driven-development: failed — <one-line cause>
hint: <single next step>
```

---

## Rationalisations to REJECT (and what to do instead)

| Excuse                                                | Do this instead                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| "This is too simple to need RED"                      | Run RED anyway. Simple code is where unexamined assumptions hide.          |
| "I'll write tests after `execute-task`"               | That's `write-tests` in green mode — different discipline, doesn't prove the test catches the bug. |
| "This is a bug fix — the test is the fix"             | Even better case for RED. Write the failing test that reproduces the bug, then fix. |
| "The operator is in a rush"                           | Offer `enabled: false` as an opt-out. Don't half-run the cycle.             |
| "The task spec didn't mention tests"                  | Specs don't mention tests because TDD is a default discipline. Run RED.     |
| "It's mostly config with one line of logic"           | One line of logic still gets one RED test. Everything else is skipped.     |
| "The code we're testing doesn't exist yet"            | Perfect — that's *why* RED fails. Write the test against the imagined API. |

If any of these thoughts show up, route the decision back through Phase 2's applicability table. If that still says RED applies, run RED.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** (most common) — the orchestrator invokes this skill per task, before `execute-task`. The orchestrator decides `enabled` based on: (a) operator preference, (b) presence of test setup, (c) task applicability heuristics.
- **Direct via `/test-driven-development`** — operator wants TDD for an ad-hoc task. Provide `files:` or `task:`. Skill writes RED, reports, returns.
- **Skipped inline** — when `enabled: false` or Phase 2 says "not applicable". Fast no-op.

---

## Non-negotiables

- **Output language: English.** Test bodies, comments, report, confirmation line — all English.
- **No test writing in this skill itself.** Delegation to `write-tests` is mandatory. This skill owns discipline + verification, not authoring.
- **No auto-dispatch of `execute-task`.** The orchestrator sequences phases. When invoked directly, stop after RED verification.
- **No silent override of `enabled: false`.** If the caller said disabled, disabled it is — even if this skill "thinks" TDD would help. Log the decision, return.
- **No TDD claim without watching the test fail.** A written-but-unverified red test is not RED; it's just a test.

---

## Related skills and references

- `write-tests` — the skill this delegates to for test authoring. Invoked with `mode: red`.
- `execute-task` — the GREEN phase. Runs after this skill confirms RED.
- `verification-before-completion` — runs AFTER `execute-task` + green `write-tests`. Handles mutation testing and regression coverage.
- `orchestrate-task-delivery` — sequences TDD → `execute-task` → `write-tests`(green) → `verification-before-completion` → `update-docs` → `commit` → `sync-workspace`.
- `scripts/detect-test-setup.mjs` — shared detector; same one used by `write-tests` and `verification-before-completion`.
- `superpowers:test-driven-development` — conceptual parent (Kent Beck's classic RGR cycle). Referenced here for lineage; not invoked at runtime.
