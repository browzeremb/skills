---
name: write-tests
description: "Author tests for a code change AND run mutation testing (Stryker / mutmut / go-mutesting) to verify the suite kills mutants. Each test is mutation-resistant by design — catches at least one plausible mutation (boolean, conditional, arithmetic, boundary, off-by-one, return-value). Auto-detects the repo's runner; skips when no test setup exists. Use after fixes land or for any 'cover these files' request. Triggers: write tests, add tests, test coverage for, unit tests for, test this, mutation testing, stryker, mutmut, kill mutants, 'tests for this change', spec these files."
argument-hint: "[files: <paths>; step: STEP_NN_TASK_MM; feat dir: <path>]"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(node *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(pnpm *), Bash(pytest *), Bash(go *), Bash(jq *), Bash(mv *), Bash(source *), Bash(grep *), Read, Write, Edit, AskUserQuestion
---

# write-tests — green tests + mutation testing after fixes land

The single test-authoring skill in the pipeline. Runs as a phase of
`orchestrate-task-delivery` AFTER `receiving-code-review` closes every
finding, so tests cover the final post-fix state of the code. The skill:

1. Authors green tests for the modified file set.
2. Runs mutation testing (Stryker / mutmut / go-mutesting) scoped to the changed scope.
3. Files mutation-killer tests for surviving mutants AND re-runs the suite to confirm green.

Output contract: emit ONE confirmation line on success.

```bash
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
# Helpers used: seed_step, complete_step, append_review_history,
#               bump_completed_count, validate_regression
```

---

## References router

| Topic | Reference |
| --- | --- |
| Phase 1.0 infra preflight + Phase 4 mutation operator taxonomy | `references/preflight.md` |
| Full mutation operator list + anti-patterns with examples | `references/mutation-principles.md` |
| Subagent formatter-delegation rule | `references/subagent-preamble.md` |
| workflow.json schema (`task.reviewer.testSpecs`, `writeTests`) | `references/workflow-schema.md` |

---

## Banned dispatch-prompt patterns

- `Read docs/browzer/<feat>/<doc>` — use `browzer workflow get-step` or `browzer workflow query`.
- `Read $WORKFLOW` — use `browzer workflow get-step --field <jqpath>`.
- Inline `jq ... > tmp && mv tmp workflow.json` for state mutations — use `jq-helpers.sh` helpers.
- Ad-hoc lists of per-package CLAUDE.md read instructions — defer to browzer explore/search.

---

## Phase 0 — Resolve input

Accepted shapes, in order of preference:

```
Skill(skill: "write-tests", args: "step: STEP_04_TASK_01; feat dir: docs/browzer/feat-<slug>/")
Skill(skill: "write-tests", args: "files: <package>/src/<file-a>.ts; feat dir: docs/browzer/feat-<slug>/")
Skill(skill: "write-tests", args: "files: <package>/src/<file>.ts")
Skill(skill: "write-tests")    # interactive
```

Bind `FEAT_DIR` from args, newest `docs/browzer/feat-*/`, or operator reply.
Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

If a `step:` is given, read specs from workflow:

```bash
GREEN_SPECS=$(browzer workflow get-step "$STEP_ID" --field '.task.reviewer.testSpecs[] | select(.type=="green")' --workflow "$WORKFLOW")
SCOPE_FILES=$(browzer workflow get-step "$STEP_ID" --field '.task.scope' --workflow "$WORKFLOW")
```

If `GREEN_SPECS` is empty (standalone invocation), derive coverage from diffs +
browzer deps (Phase 2). If neither `step:` nor `files:` given, ask the operator:

> Which source files should I write tests for? Paste paths, or say `changed` to
> take the list from `git diff --name-only $(git merge-base HEAD main)..HEAD`.

State mode in chat before writing:

> write-tests: 3 files in scope, 5 green specs from task reviewer (step STEP_04_TASK_01) · feat dir docs/browzer/feat-<slug>/

---

## Phase 1.0 — Infra preflight (BEFORE detect-test-setup.mjs)

See `references/preflight.md §Phase 1.0` for the full probe sequence. Summary:

1. Grep `package.json` scripts for `test:env`, `test:integration`, `test:e2e`.
2. If `test:env:wake` exists AND last wake > 30min ago, run `pnpm test:env:wake`.
3. If a Playwright spec is in scope AND chromium not installed, run
   `pnpm exec playwright install chromium`.
4. Check Docker fixture status (`docker ps --filter "name=browzer-"`).

Record each probe under `writeTests.infraProbe[]`:

```jsonc
{ "tool": "pnpm test:env:wake", "attempted": true, "outcome": "ok", "duration": 12, "note": "..." }
```

Deferring "no infra detected" is only valid AFTER this probe returns nothing.

---

## Phase 1 — Detect the repo's test setup

Run the shared detector:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs" --repo . > /tmp/write-tests-setup.json 2>&1 \
  || node "$(find ~/.claude/plugins -type f -name 'detect-test-setup.mjs' 2>/dev/null | head -1)" --repo . > /tmp/write-tests-setup.json
```

Key fields: `hasTestSetup` (false → stop), `runners` (pick first), `testCommand`,
`language`. Inline fallback if detector not found:

```bash
test -f package.json && cat package.json | node -e "let j=JSON.parse(require('fs').readFileSync(0)); \
  console.log(JSON.stringify({test: j.scripts?.test||null, \
  framework: Object.keys({...j.devDependencies||{}, ...j.dependencies||{}}) \
  .find(d => ['vitest','jest','mocha','@playwright/test'].includes(d))}))" || true
test -f pyproject.toml && echo 'python-pytest' || true
test -f go.mod && echo 'go' || true
```

---

## Phase 2 — Ground each target file in the repo

```bash
browzer explore "<basename>" --json --save /tmp/write-tests-explore-<slug>.json
browzer deps "<path>" --json --save /tmp/write-tests-deps-<slug>.json
```

Harvest: exports (public surface), importedBy (real consumers), line ranges of
functions under test, existing sibling tests (augment, don't overwrite).

---

## Phase 3 — Enumerate behaviours

### 3a — When `GREEN_SPECS` is non-empty (authoritative)

Each spec's `file` + `description` + `coverageTarget` maps to a single
`it`/`test` case. Add complementary cases only when they fit within the spec's
coverage intent; flag additions under `notes`.

### 3b — When deriving from file diffs (no spec)

For each file, list observable behaviours:

1. Happy path per exported function/method/class/endpoint.
2. Every `if` / `switch` / pattern-match branch — one test each.
3. Every boundary: empty, max, zero, negative, null, undefined, whitespace-only.
4. Every `throw`/`raise`/`panic`/error return.
5. Every async/retry/timeout path.
6. Every external effect (DB, HTTP, queue) — test it happens with the right args.

Cap at ~8 per file. Note excess as `deferred` and ask.

---

## Phase 4 — Design tests to survive mutations

For each behaviour, verify the test would fail under at least one plausible
mutation. See `references/preflight.md §Phase 4` for the full operator
checklist (9 mutation classes) and anti-patterns. See
`references/mutation-principles.md` for full reasoning + examples.

---

## Phase 5 — Write the tests + verify green

Mirror the repo's existing conventions. Per `references/subagent-preamble.md
§Formatter delegation`, do NOT run biome/prettier/ruff after writing.

Run the test runner scoped to files you wrote:

```bash
<testCommand> <path/to/new-test-file>
# e.g. pnpm vitest run <package>/src/__tests__/<file>.test.ts
```

Every new test MUST pass. Full suite MUST still be green. If a test is right
and the code is wrong, STOP and surface the regression under `warnings`. Do NOT
fix the code from this skill.

---

## Phase 6 — Update workflow.json

When invoked as the pipeline `WRITE_TESTS` phase, append a new
`STEP_<NN>_WRITE_TESTS` step. When invoked standalone against an existing task
step, append a `write-tests` agent entry to that step's `.task.execution.agents[]`.

Use helpers for the atomic write:

```bash
complete_step "$STEP_ID" "$WT_PAYLOAD_JQ_EXPR"
bump_completed_count
```

---

## Phase 7 — One-line confirmation

Success:
```
write-tests: wrote <N> test cases across <F> files; all green
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

- **Pipeline phase 6** — after `receiving-code-review` closes every finding.
- **Standalone** — operator invokes directly for arbitrary files. Interactive file-selection.
- **Skipped** — when detector returns `hasTestSetup: false`. Not a failure; a no-op with warning.

---

## Non-negotiables

- **Output language: English** for test names, JSON payload, and the confirmation line.
- **No new test frameworks** without operator approval.
- **Never silently edit code-under-test.** Failing green tests are a regression signal.
- **Never bypass the mutation checklist** in `references/preflight.md §Phase 4`.
- `workflow.json` is mutated ONLY via `browzer workflow *` or the `jq-helpers.sh` helpers.

---

## Related skills and references

- `code-review` — runs BEFORE; regression-tester agent scopes tests over blast radius.
- `receiving-code-review` — runs BEFORE; closes every code-review finding.
- `update-docs` — runs AFTER; patches docs based on the same file set.
- `references/preflight.md` — Phase 1.0 infra preflight + Phase 4 mutation taxonomy.
- `references/workflow-schema.md` — authoritative schema (`task.reviewer.testSpecs`, `writeTests`).
- `references/mutation-principles.md` — Stryker-inspired operator list + anti-patterns.
- `superpowers:testing-strategies` — conceptual parent; not invoked at runtime.
