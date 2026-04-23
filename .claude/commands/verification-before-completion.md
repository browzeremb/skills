---
name: verification-before-completion
description: "Last-line-of-defence quality gate run AFTER `execute-task` + `write-tests` and BEFORE `update-docs`/`commit`/`sync-workspace`. Three responsibilities: (1) find every file that imports or depends on the changed files via `browzer deps <path> --reverse` and make sure each consumer either has regression tests OR gets new ones written (delegating back to `write-tests`); (2) run mutation testing on the tests the change introduced — Stryker when the repo is JS/TS, mutmut for Python, go-mutesting for Go, or a conceptual fallback when no tool is available — and dispatch a test-reinforcement agent when the mutation score falls below the configured target; (3) re-run the repo's declared quality gates one last time, on the broadest reasonable scope. If the repo has no test setup, the skill skips steps 1 and 2, runs lint/typecheck/build as available, and returns. Writes a `.meta/VERIFICATION_<ts>.json` report with blast-radius coverage, mutation score, and regression summary. Triggers: 'verify before completion', 'final verification', 'pre-commit verification', 'regression check', 'blast radius check', 'mutation testing', 'stryker run', 'make sure nothing broke', 'check consumers', 'check importers', 'are the tests strong enough', 'verify the tests catch bugs', 'mutation score', 'test quality check', 'verify my changes'."
argument-hint: "[files: <paths>; feat dir: <path>; --mutation-score-target N; --skip-mutation]"
allowed-tools: Bash(browzer *), Bash(node *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(npx *), Bash(pnpm *), Bash(pip *), Bash(python *), Bash(go *), Bash(cargo *), Read, Write, Edit, Agent
---

# verification-before-completion — regression + mutation gate before commit

The last skill that runs before `update-docs` in the 6-phase workflow — sits where a reviewer would otherwise. Its job is to buy confidence that nothing downstream from the change was silently broken AND that the tests that were written are actually strong enough to catch regressions when someone edits this area later.

Output contract: `../../README.md` §"Skill output contract".

---

## Phase 0 — Resolve input

Accepted argument shapes:

```
Skill(skill: "verification-before-completion", args: "files: apps/api/src/routes/auth.ts apps/api/src/middleware/rbac.ts; feat dir: docs/browzer/feat-20260423-rbac-tighten/")
Skill(skill: "verification-before-completion", args: "--mutation-score-target 80 --skip-mutation false")
Skill(skill: "verification-before-completion")
```

### 0.1 Files

- Preferred: explicit `files:` from the caller (orchestrator reads from `HANDOFF_NN.json`'s `files.created` + `files.modified`).
- Fallback: derive from git:

  ```bash
  BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo "HEAD~1")
  git diff --name-only "$BASE"..HEAD -- ':(exclude)*.md' ':(exclude)*.mdx'
  ```

  Exclusions mirror `update-docs`: skip markdown (those are covered by `update-docs`, not this skill).

### 0.2 Feat folder

Preferred: explicit `feat dir:`. Fallback: newest `docs/browzer/feat-*/` dir. If none exists, write the report to `docs/browzer/feat-$(date -u +%Y%m%d)-standalone-verification/.meta/`.

### 0.3 Flags

- `--mutation-score-target N` — minimum mutation score (% killed) to accept. Default `70`. Below the threshold, the skill dispatches a reinforcement agent.
- `--skip-mutation` — skip Phase 3 entirely. Useful when the repo is huge and mutation testing would take hours; prefer narrowing scope with `--mutation-scope` before skipping. Default: mutation enabled.
- `--mutation-scope <glob>` — restrict mutation testing to a subset of the changed files. Default: all changed files except generated / vendor / dist.

### 0.4 Trivial-task shortcut

If the caller passes a `feat dir:` and the task header is available, check the `**Trivial:**` flag. Use the `FEAT_DIR` resolved in §0.2 — **not** a hardcoded `docs/browzer/` path:

```bash
# Use the FEAT_DIR value resolved in §0.2 — substitute the actual path, not a placeholder.
find <FEAT_DIR> -maxdepth 1 -name 'TASK_*.md' | xargs ls -t 2>/dev/null | head -1 \
  | xargs grep -m1 "^\*\*Trivial:\*\*" 2>/dev/null
```

**If `Trivial: true`**: skip Phases 2 and 3 entirely. Jump directly to a slim Phase 4:

```bash
pnpm turbo lint typecheck test --filter=<pkg>
```

Derive `<pkg>` from the changed files' `package.json` owner. Write a minimal VERIFICATION report (set `blastRadius` and `mutationTesting` both to `{ "status": "skipped", "reason": "trivial task" }`), then emit the trivial confirmation line (see Phase 6).

**If `Trivial: false` (or flag absent)**: proceed with the full flow below.

### 0.5 State in chat

```
verification-before-completion: <N> files in scope · mutation target 70% · feat dir <path>
```

One line before any work.

---

## Phase 1 — Detect test setup

Run the shared detector:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs" --repo . > /tmp/verify-setup.json 2>&1 \
  || node "$(find ~/.claude/plugins -type f -name 'detect-test-setup.mjs' 2>/dev/null | head -1)" --repo . > /tmp/verify-setup.json
```

Parse `hasTestSetup`, `runners[0].name`, `testCommand`.

- `hasTestSetup: true` → full flow.
- `hasTestSetup: false` → skip Phases 2 and 3; run Phase 4 (quality gates only) with whatever lint/typecheck/build the repo declares; emit the skip note in the confirmation line. This is the correct behaviour for infrastructure repos, doc-only repos, or repos genuinely untested.

---

## Phase 2 — Blast-radius regression coverage

For each file in scope, list the consumers that might regress:

```bash
# Reverse deps — who imports this file?
browzer deps "<path>" --reverse --json --save /tmp/verify-reverse-<slug>.json

# Semantic cross-refs — files that mention the changed symbols but aren't direct importers
browzer explore "<primary exported symbol>" --json --save /tmp/verify-explore-<slug>.json
```

Extract:

- **Direct importers** (`importedBy` list). Each one is a candidate for regression tests.
- **Semantic neighbours** — files with high-score `explore` hits that aren't in `importedBy`. Usually docs; filter those out (`update-docs` handles them).

### 2.1 For each consumer: test coverage check

For every direct importer discovered above, check whether a test file exists that exercises it:

```bash
# Heuristics, in order:
#   1. Sibling <name>.test.<ext> / <name>.spec.<ext>
#   2. __tests__/<name>.test.<ext> under the same dir tree
#   3. tests/ dir mapped by convention (e.g. Python `tests/test_<name>.py`)
#   4. ctrl-F the consumer's path or basename in existing test files
```

Use browzer to answer (4) cheaply:

```bash
browzer explore "<consumer basename>" --json --save /tmp/verify-consumer-<slug>.json
# Look for hits whose path contains 'test' / '__tests__' / 'spec'
```

Classify each consumer:

| Classification      | Action                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `has-tests`         | Run those tests (scoped to the consumer's test file). If they pass, record `covered`. |
| `missing-tests`     | Dispatch `Skill(skill: "write-tests", args: "files: <path>; mode: green")` to author them, then run. |
| `untestable-now`    | Consumer is a config / types-only / binary asset. Record `not-applicable`. |

### 2.2 Delegation, not inline writing

This skill does NOT write tests itself — it delegates to `write-tests`. That keeps the mutation-resistance discipline in one place and avoids drift. Accept the `WRITE_TESTS_<ts>.json` report back, merge its metrics into this skill's report, continue.

If `write-tests` itself skips (no test setup), fall through — Phase 3 also skips, and Phase 4 runs.

### 2.3 Scope cap

If more than **15 consumers** need coverage, STOP and ask the operator:

> blast radius is large — 22 consumers lack regression tests. Options:
> (a) widen scope and write tests for all 22 now (~N minutes),
> (b) write tests for the top-5 by `importedBy` score and defer the rest to a follow-up task,
> (c) accept the risk and proceed with the subset already covered. Which?

Do not silently skip. A too-wide blast radius is usually a signal the change should have been split.

---

## Phase 3 — Mutation testing

Mutation testing proves the tests in scope actually catch bugs. Without it, a high line-coverage number can still mean "the tests ran the code but asserted nothing useful".

### 3.1 Detect a mutation runner

Walk a priority list, stopping at the first available:

| Detected stack              | Runner                    | Install / invoke                                                |
| --------------------------- | ------------------------- | --------------------------------------------------------------- |
| JS/TS + `node_modules/`     | **Stryker**               | `npx stryker run` (no install needed via `npx`; honors `stryker.conf.{json,mjs,js}`) |
| Python + `pyproject.toml`   | **mutmut**                | `pip install mutmut` if missing; `mutmut run`                    |
| Python + `requirements.txt` | **mutmut** (alternative)  | Same                                                             |
| Go + `go.mod`               | **go-mutesting**          | `go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest` then `go-mutesting ./...` |
| Rust + `Cargo.toml`         | **cargo-mutants**         | `cargo install cargo-mutants` if missing; `cargo mutants --in-place` |
| Ruby + `Gemfile`            | **mutant**                | `bundle add mutant-rspec` then `bundle exec mutant run`          |
| Anything else, or install forbidden | **Conceptual fallback** (§3.3) | N/A                                                              |

**Ask before installing.** Mutation runners are heavy. If the runner isn't already on the `PATH` AND no `devDependency` exists for it, ask the operator:

> mutation testing requires installing `stryker-mutator` as a dev dependency (~X MB). Install now, or skip mutation for this run? **[install / skip]**

If the operator skips, fall through to §3.3.

### 3.2 Run the real mutation tool

Scope to the **files in this skill's input** (plus any new consumers covered in Phase 2) — not the whole repo. A full-repo mutation run on a monorepo can take hours; scope aggressively:

```bash
# Stryker (stryker.conf.mjs mutate field):
STRYKER_MUTATE='["apps/api/src/routes/auth.ts","apps/api/src/middleware/rbac.ts"]' npx stryker run

# mutmut:
mutmut run --paths-to-mutate='apps/api/src/routes/auth.ts'

# go-mutesting:
go-mutesting apps/api/auth/...

# cargo-mutants:
cargo mutants --in-place --file apps/api/src/routes/auth.rs
```

Capture the runner's JSON / text report. Extract the mutation score (killed / total × 100).

### 3.3 Conceptual fallback (no runner available)

When a real runner can't run, dispatch a mutation-reasoning agent:

```
Agent(
  subagent_type: "general-purpose",
  description: "Conceptual mutation check: <files>",
  prompt: """
    You are a mutation-testing reasoner.

    For each source file in this list:
      <files>

    1. Read the file.
    2. Read every test file that covers it (discover via browzer explore).
    3. Propose 10 plausible mutations per file, drawn from these operators:
        - arithmetic (+ ↔ - ↔ * ↔ /)
        - relational (< ↔ <=, > ↔ >=, == ↔ !=)
        - logical (&& ↔ ||, !x ↔ x)
        - conditional inversion
        - return value (true → false, x → null)
        - literal replacement
        - early-exit removed
        - loop off-by-one
        - assignment replacement
        - unary operator replacement
    4. For each mutation, say whether the existing tests would CATCH it
       (they'd fail) or LET IT THROUGH (they'd still pass).
    5. Return ONLY this JSON:

       {
         "file": "<path>",
         "mutations": [
           {
             "operator": "<operator name>",
             "location": "<path:line>",
             "description": "<one-line>",
             "caught": true | false,
             "catching_test": "<test path + case name, if caught>",
             "reason_if_not_caught": "<one-line, if not caught>"
           }
         ],
         "score": <percentage caught>
       }

    Budget: 5 minutes. Do not modify any files. Do not run any tests.
  """
)
```

Parse the returned JSON into the same shape as the real-runner output. Treat the resulting `score` as lower-confidence (record `source: "conceptual"` in the report).

### 3.4 Threshold gate

- Score ≥ target → record pass, proceed.
- Score < target → dispatch a reinforcement agent:

```
Agent(
  subagent_type: "general-purpose",
  description: "Reinforce tests to kill surviving mutants",
  prompt: """
    Your job is to strengthen tests so more mutations get caught.

    For each surviving mutation below, write or augment a test case that
    would fail under it. Follow the mutation-resistance principles in
    the `write-tests` skill's references/mutation-principles.md — do NOT
    assert on mocks, do NOT add test-only methods to production, do NOT
    introduce partial mocks.

    Mutations still alive:
      <list from §3.2/§3.3 where caught=false>

    Existing test files to augment:
      <discovered test files for the affected source>

    Test runner: <runner command from detector>

    After writing, run the runner to verify all existing tests still pass.
    Return one line: "reinforced <N> tests across <F> files"; nothing more.
  """
)
```

After the reinforcement agent returns, **re-run the mutation tool** (§3.2 or §3.3) to see the new score. One retry is allowed. If the second run still misses the target, surface a warning in the confirmation line — do NOT block `commit`. The operator decides whether to accept the coverage gap.

---

## Phase 4 — Final quality gates

Regardless of whether Phases 2 and 3 ran, re-run the repo's declared gates one more time — broad scope, not per-file:

```bash
# Discover from /tmp/verify-setup.json signals.scripts + runners[0]:
<lint>        # e.g. pnpm turbo lint --filter='...[origin/main]'
<typecheck>   # e.g. pnpm turbo typecheck
<test>        # e.g. pnpm turbo test
<build>       # only if the change touched build inputs (see §Build guard)
```

### Build guard

Skip the build command unless one of these is true:

- A dependency was added/removed/bumped (`package.json` / `go.mod` / `Cargo.toml` / `pyproject.toml` changed).
- A build config file changed (`tsconfig.json`, `tsup.config.ts`, `vite.config.ts`, `turbo.json`, `Dockerfile`, etc.).
- The task spec's Verification plan named build explicitly.

Otherwise building is pure duplication — `execute-task` already ran it during its Phase 4 baseline and Phase 7 post-change check.

Record results. Any regression against the baseline captured by `execute-task` (available in `HANDOFF_NN.json`) is a verification failure:

```
verification-before-completion: failed — regression detected (tests: 47 → 45 passing)
hint: investigate <test-names>; re-run after fixing, then proceed to update-docs
```

---

## Phase 5 — Write the report

Create `<FEAT_DIR>/.meta/VERIFICATION_<timestamp>.json`:

```json
{
  "skill": "verification-before-completion",
  "timestamp": "20260423T130000Z",
  "featDir": "docs/browzer/feat-20260423-rbac-tighten/",
  "filesInScope": ["apps/api/src/routes/auth.ts", "apps/api/src/middleware/rbac.ts"],
  "testSetup": { "hasTestSetup": true, "runner": "vitest", "language": "typescript" },
  "blastRadius": {
    "consumersDiscovered": 9,
    "consumersCovered": 7,
    "consumersAugmented": 2,
    "consumersUntestable": 0,
    "writeTestsReport": ".meta/WRITE_TESTS_20260423T130500Z.json"
  },
  "mutationTesting": {
    "runner": "stryker",
    "source": "tool",
    "target": 70,
    "score": 82,
    "killed": 41,
    "survived": 9,
    "timeout": 0,
    "reinforcementDispatched": false,
    "reinforcementResultScore": null
  },
  "qualityGates": {
    "lint": { "status": "pass", "baseline": "pass" },
    "typecheck": { "status": "pass", "baseline": "pass" },
    "tests": { "status": "pass", "baseline": "47 pass", "postChange": "51 pass", "delta": "+4" },
    "build": { "status": "skipped", "reason": "no build inputs touched" }
  },
  "regressions": [],
  "warnings": []
}
```

---

## Phase 6 — One-line confirmation

Full flow:

```
verification-before-completion: blast radius <C> consumers (<K> covered, <A> augmented); mutation <S>% ≥ target <T>%; gates green; report at .meta/VERIFICATION_<ts>.json
```

Example:

```
verification-before-completion: blast radius 9 consumers (7 covered, 2 augmented); mutation 82% ≥ target 70%; gates green; report at .meta/VERIFICATION_20260423T130000Z.json
```

Trivial task (Phase 2 + 3 skipped):

```
verification-before-completion: trivial task — blast radius + mutation skipped; lint/typecheck/test green (filter: <pkg>); report at .meta/VERIFICATION_<ts>.json
```

No test setup (Phase 1 skip):

```
verification-before-completion: no test setup — blast radius + mutation skipped; lint/typecheck/build green; report at .meta/VERIFICATION_<ts>.json
```

Mutation below target after reinforcement:

```
verification-before-completion: blast radius 9 consumers (7 covered, 2 augmented); mutation 62% < target 70% (reinforced once); gates green; report at .meta/VERIFICATION_<ts>.json; ⚠ mutation score below target, operator to decide
```

Failure:

```
verification-before-completion: failed — <one-line cause>
hint: <single next step>
```

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — the canonical path. Runs between `execute-task`/`write-tests` and `update-docs`. The orchestrator passes `files:` from `HANDOFF_NN.json`.
- **Direct via `/verification-before-completion`** — operator wants to double-check a change they just landed. Interactive; derives `files:` from `git diff` against `main`.
- **Skipped inline** — when the test detector says no setup exists. Phase 4 quality gates still run (lint/typecheck are cheap and catch real regressions).

---

## Non-negotiables

- **Output language: English** for reports, confirmation lines, agent prompts.
- **No inline test writing** — always delegate to `write-tests`. Keeps mutation-resistance discipline in one place.
- **No blocking on mutation target miss** — surface as a warning, let the operator decide. Blocking `commit` on mutation score is a policy decision, not a skill decision. (An operator who wants hard blocking sets a pre-commit hook; this skill informs.)
- **No installing heavy dev dependencies without consent.** Stryker / mutmut / cargo-mutants are big — ask before adding them to the repo.
- **No mutation run against an infra-less test suite.** If tests require Docker and Docker isn't up, skip mutation with `warnings: ["mutation skipped — infra not available"]` rather than producing a confidently-wrong number.
- **Does not re-run the formatter.** The plugin's `auto-format.mjs` hook runs in-loop after every edit; re-running here is duplication.

---

## Related skills and references

- `execute-task` — previous phase; produces the diff this skill verifies.
- `write-tests` — the skill this delegates to when adding regression tests for uncovered consumers.
- `update-docs` — next phase; runs after this skill confirms the change is safe.
- `orchestrate-task-delivery` — sequences the full workflow.
- `scripts/detect-test-setup.mjs` — shared test-setup detector.
- `references/mutation-runners.md` — per-language install + invocation recipes, config snippets, known pitfalls.
- `superpowers:testing-strategies` — conceptual parent (test-pyramid + mutation discipline). Referenced here for lineage; not invoked at runtime.
