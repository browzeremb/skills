# Mutation Runner Recipes

Per-language guide for invoking mutation testing from `verification-before-completion`. Load when you actually need to run a runner — this file is long and not needed for the general flow.

## Table of contents

1. [Stryker — JS/TS](#stryker--jsts)
2. [mutmut — Python](#mutmut--python)
3. [go-mutesting — Go](#go-mutesting--go)
4. [cargo-mutants — Rust](#cargo-mutants--rust)
5. [mutant — Ruby](#mutant--ruby)
6. [Shared pitfalls](#shared-pitfalls)
7. [Parsing runner output](#parsing-runner-output)

---

## Stryker — JS/TS

### Install check

```bash
# Is it already a devDependency?
node -e "const p=require('./package.json'); const d={...p.devDependencies||{},...p.dependencies||{}}; console.log(d['@stryker-mutator/core']||d['stryker-mutator']||'missing')"

# Is a runner on the path via pnpm/npm?
command -v stryker >/dev/null && echo 'local' || echo 'ask-to-install'
```

### Install (ask operator first)

```bash
# pnpm
pnpm add -D -w @stryker-mutator/core @stryker-mutator/vitest-runner

# npm
npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner

# For Jest instead of Vitest:
#   @stryker-mutator/jest-runner
```

### Minimal config (`stryker.config.mjs`)

```js
export default {
  testRunner: 'vitest',
  mutate: [
    // Let the caller override via env; default to nothing so it's explicit
    ...(process.env.STRYKER_MUTATE ? JSON.parse(process.env.STRYKER_MUTATE) : []),
  ],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '.stryker-tmp/mutation-report.json' },
  coverageAnalysis: 'perTest',
  thresholds: { high: 80, low: 60, break: 0 },
  timeoutMS: 60000,
  concurrency: 4,
};
```

Run:

```bash
STRYKER_MUTATE='["apps/api/src/routes/auth.ts","apps/api/src/middleware/rbac.ts"]' npx stryker run
```

### Output shape (JSON)

The JSON reporter writes `.stryker-tmp/mutation-report.json`. Key fields:

```json
{
  "files": {
    "apps/api/src/routes/auth.ts": {
      "mutants": [
        {
          "id": "1",
          "mutatorName": "ConditionalExpression",
          "status": "Killed" | "Survived" | "Timeout" | "NoCoverage" | "CompileError" | "RuntimeError"
        }
      ]
    }
  },
  "systemUnderTestMetrics": {
    "metrics": {
      "mutationScore": 82.35,
      "killed": 41,
      "survived": 9,
      "timeout": 0,
      "noCoverage": 0,
      "runtimeErrors": 0,
      "compileErrors": 0
    }
  }
}
```

### Known pitfalls

- **Vitest + ESM-only packages**: Stryker's vitest runner sometimes fails to resolve pure-ESM packages (`node-fetch` v3+, some pnpm-hoisted deps). Workaround: pin to the test-runner fork or add `stryker.vitest.configFile` pointing at a simplified config.
- **Turborepo + monorepo**: Stryker is single-package by default. Run per-package (`pnpm --filter @browzer/api stryker run`) — running at the monorepo root mutates test files too.
- **`coverageAnalysis: "perTest"` requires the runner to report per-test coverage.** Vitest v1+ supports it; Jest does too via `@stryker-mutator/jest-runner`. If coverage is "all", each mutant runs every test — 10× slower but works anywhere.

---

## mutmut — Python

### Install check

```bash
pip show mutmut >/dev/null 2>&1 && echo 'installed' || echo 'ask-to-install'
```

### Install

```bash
pip install mutmut
# Or for poetry-managed projects:
poetry add --dev mutmut
```

### Invocation

```bash
# Config lives in pyproject.toml or setup.cfg
mutmut run --paths-to-mutate=apps/api/src/routes/auth.py
mutmut results
mutmut junitxml > /tmp/mutmut-results.xml
```

### Config (`pyproject.toml`)

```toml
[tool.mutmut]
paths_to_mutate = ["src/"]
tests_dir = "tests/"
backup = false
runner = "python -m pytest -x -q"
```

### Output

`mutmut results` prints:

```
Legend for output:
🎉 Killed mutants.
⏰ Timeout.
🤔 Suspicious.
🙁 Survived.
🔇 Skipped.

file: src/auth.py
killed: 38
survived: 6
total: 44
mutation_score: 86.4%
```

Parse by grepping `mutation_score:`. Or use the JUnit XML for machine-readable output.

### Known pitfalls

- **mutmut uses AST patching, which breaks Python 3.12 in some versions.** Check compatibility first.
- **Default timeout is generous** — real tests that always pass will hide timeouts as "Killed". Lower `--run-command-timeout` to ~30s on fast suites.
- **`--paths-to-mutate` is a FLAG, not a positional.** Getting this wrong runs mutation on the whole repo and takes forever.

---

## go-mutesting — Go

### Install check

```bash
command -v go-mutesting >/dev/null && echo 'installed' || echo 'ask-to-install'
```

### Install

```bash
go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest
```

### Invocation

```bash
# One package at a time; accepts a package path relative to the module
go-mutesting apps/api/auth/...
```

### Output

Prints per-mutant status to stdout:

```
PASS apps/api/auth/auth.go.12:14 - mutation 1 (ms-0 arithmetic/+)
FAIL apps/api/auth/auth.go.15:10 - mutation 2 (ms-1 branch/if)
...
The mutation score is 0.823 (41 passed, 9 failed, 0 duplicated, 0 skipped, total is 50)
```

`PASS` means the test suite caught the mutation (killed it — same semantics as Stryker). `FAIL` means the mutation survived.

Parse by grepping the last line for `mutation score is`.

### Known pitfalls

- **Doesn't respect `t.Parallel()` well** — tests that share state across goroutines can flake the mutation run.
- **Only mutates one package at a time** — loop over packages in a shell for multi-package scope.
- **Slow on large code bases**. Scope tight.

---

## cargo-mutants — Rust

### Install check

```bash
command -v cargo-mutants >/dev/null && echo 'installed' || echo 'ask-to-install'
```

### Install

```bash
cargo install cargo-mutants
```

### Invocation

```bash
cargo mutants --in-place --file apps/api/src/routes/auth.rs --json > /tmp/mutants.json
```

`--in-place` keeps one worktree (faster, minor risk — accepted for scoped runs).

### Output

JSON shape:

```json
[
  { "path": "src/auth.rs", "line": 15, "operator": "if_true", "status": "caught" },
  ...
]
```

Compute score as `caught / (caught + missed + timeout) × 100`.

### Known pitfalls

- **Default builds release mode** — can be slow. Pass `--test-args "--release"` only if the test suite already uses release mode.
- **Won't mutate private `fn` unless `pub` or tested via `mod tests`.** Tests in the same module are fine.

---

## mutant — Ruby

### Install check

```bash
bundle list mutant 2>/dev/null && echo 'installed' || echo 'ask-to-install'
```

### Install

```bash
bundle add mutant-rspec --group test
```

### Invocation

```bash
bundle exec mutant run -I lib -r app -- 'App::Auth'
```

### Output

Prints per-mutant + final score:

```
Subjects: 1
Mutations: 24
Killed: 20
Alive: 4
Mutation score: 83.33%
```

Parse by grepping `Mutation score:`.

### Known pitfalls

- **License model changed** — mutant now offers a commercial tier. The free CE version may omit operators compared to docs. Check the installed version's README.
- **Strict type usage required** — `bundle exec` is mandatory; plain `mutant` won't resolve gems.

---

## Shared pitfalls

### Scope control

Running mutation on the full repo is almost always wrong — it mutates tests, fixtures, and generated code. Always scope to the changed source files. The file list from the current task step's `.task.execution.files.modified + .created` in `workflow.json` is the right input.

### Flaky tests

Mutation testing exposes flaky tests brutally — a test that sometimes passes without the mutation and sometimes fails with it reports "caught" with wild variance. If the mutation score bounces between runs, fix the flaky test before trusting the number.

### Test timeout vs. mutation caught

Every runner has a timeout. A test that hangs under a mutation (e.g. infinite loop from a removed `if` break) gets marked "timeout" — which most tools count as caught (the mutation did break behaviour). But long timeouts also cost wall-clock time. Set the per-mutant timeout conservatively (30s–60s).

### Coverage vs. mutation score

High mutation score ≥ meaningful coverage. High line coverage + low mutation score = theatre. When they disagree, trust mutation. When mutation is low-confidence (the conceptual fallback in §3.3), prefer the tool version if at all possible.

---

## Parsing runner output

For each runner, write a tiny parser that produces this uniform shape for the `mutationTesting` section of `VERIFICATION_<ts>.json`:

```json
{
  "runner": "<name>",
  "source": "tool" | "conceptual",
  "target": <number>,
  "score": <number>,
  "killed": <number>,
  "survived": <number>,
  "timeout": <number>,
  "reinforcementDispatched": <bool>,
  "reinforcementResultScore": <number|null>
}
```

Parsers can be inline shell + `grep`/`jq` for tool output, or one-shot `node -e` / `python -c` scripts. Don't over-engineer — parsing is adjacent to the runner invocation, not a separate concern.

---

## When to escalate to the operator

- A runner install is blocked by policy / CI constraints → skip, fall through to conceptual.
- Mutation score drops >20 points after a change → this is a RED flag (either the change broke test strength or the change broke the runner's config). Surface loudly, don't silently continue.
- The runner reports compile errors on MUTATED code that weren't there on baseline → the runner is broken, not the code. Retry once; if still broken, skip and warn.


## UI-only scope carve-out (added F5, 2026-04-24)

`code-review`'s mutation-testing gate may auto-skip when ALL of the following hold:

- `CHANGED_FILE_COUNT <= 10`
- Every changed file lives under `apps/web/` or `apps/*/components/` (i.e. presentation-only paths with no business-logic invariants).

When skipped under this carve-out, the workflow.json must record:

```json
{ "mutationTesting": { "skipped": true, "reason": "ui-only-scope-carve-out",
  "scope": "<comma-separated file list>" } }
```

The skill MUST NOT silently emit `tool: "qualitative-read (Stryker not executed)"` — that value is a regression and indicates the gate was bypassed without operator consent.
