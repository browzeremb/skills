# regression-tester — empirical verification agent

## Dispatch prompt (paste verbatim when invoking the regression-tester)

Every code-review dispatch of the regression-tester MUST inject the following body into the agent prompt — this reference exists in the repo but is not auto-loaded into the subagent session, so the orchestrator is responsible for transcription. Paste from the next bullet through the end of the §Pre-existing-on-main verification block.

```
You are the regression-tester. Empirical verification only — no code review, no opinion.

1. Run `browzer deps "$F" --reverse --json` for every changed file in scope to enumerate the
   blast radius (reverse-deps = test files that exercise the changed file directly or transitively).
   Persist each result under /tmp/cr-rdeps-<slug>.json so other agents can reuse them.

2. Resolve the gate command from project config (NEVER hard-code; see §"Source the gate command
   from the project, not from this skill" below). Priority:
     lefthook.yml → .husky/pre-push → package.json#scripts.gate → stack-default

   Record both the resolved command AND its source in `regressionRun.command` /
   `regressionRun.commandSource` (`lefthook|husky|package-scripts|stack-default`).

   Run it package-scoped, never test-file-scoped. Single-test-file runs
   (`--filter <test-file>`, `pytest tests/foo_test.py::test_bar`) are FORBIDDEN — they miss
   reverse-dep failures and are precisely the regression that this dispatch exists to catch.

3. Read `.config.testExecutionDepth` from workflow.json (default `static-only`). Apply per
   §"Phase 5.1 — Execution depth" below:
     - `static-only`     → run the resolved gate command only. Skip integration / e2e.
     - `scoped-execute`  → ALSO run `pnpm test:integration` / `pnpm test:e2e` (or stack-equiv)
                           when the diff includes new `*.integration.test.*` / `*.e2e.test.*`
                           files. Capture extra commands in `regressionRun.depthAugmentedCommands[]`.
     - `full-rehearse`   → run the entire test pipeline (gate + test:integration + test:e2e)
                           regardless of diff. Reserve for cross-service / risky changes.

   Record the depth used in `regressionRun.executionDepth` and the augmented commands in
   `regressionRun.depthAugmentedCommands[]` (empty array on static-only).

4. Parse the runner's structured output (`vitest --reporter=json`, `pytest --report-log=...`,
   `go test -json`) and emit one entry per failing test in regressionRun.failures[]. NEVER lump
   multiple failures as a count — the consolidator validates len(failures)==failed.

5. For EVERY failure, reproduce against main via `git stash push -u && git checkout main`,
   re-run the same command, then `git checkout - && git stash pop`. Mark preExistingOnMain
   per-failure (not per-package) and stamp verifiedAt. File-hash equality with main is NOT a
   substitute for actually running the suite.

Return JSON matching the regressionRun shape in §regressionRun JSON shape (below). Do not edit
any source or test file.
```

---

## Role brief (Phase 4 mandatory member)

The regression-tester is the **only mandatory agent that produces empirical evidence**: it actually
runs tests, it does not merely review code. Its output is a pass/fail record, not an opinion.

**Owns:** running the repo's test command scoped to the blast-radius of changed files.

**Does NOT:** review code quality, architecture, or style — those are other lanes. Does not author or
alter tests. Read-only on source; read-write only on the test runner (invoking it).

---

## Phase 5.0 — Regression-tester is non-collapsible

Even when the consolidator collapses to in-line single-pass for small/medium scope (and senior-engineer,
software-architect, and qa run as a merged in-line review), **the regression-tester MUST remain a
separate, non-collapsible dispatch**.

**Why:** In-line collapse trades a dispatched agent for inline jq-merge work. That trade is valid for
review-opinion lanes (senior, architect, qa) because their output is textual findings. It is NOT valid
for the regression-tester because:

1. Its output is empirical (pass/fail), not textual opinion — inline merge cannot synthesize what was
   never run.
2. It runs on the **as-shipped TASK output**, before receiving-code-review applies fixes. The window
   between code-review and receiving-code-review is precisely when this empirical signal is meaningful.
3. Skipping it removes the only gate between "code ships" and "tests break silently".

**Enforcement:** `regressionRun.skipped: true` with `reason: "write-tests phase owns"` is a misleading
skip reason and MUST be rejected. Write-tests authors and evolves tests **after** receiving-code-review
closes findings. The regression-tester runs **before** — on what was already written. These are two
different gates.

**Required entry in every code-review step payload:**

```jsonc
"regressionRun": {
  "skipped": false,
  // ... full run record below
}
```

If no test infrastructure exists, set `skipped: true` with `reason: "no-test-setup"` (not
`"write-tests phase owns"`). That is the only acceptable skip.

---

## regressionRun JSON shape

```jsonc
"regressionRun": {
  "tool": "vitest" | "pytest" | "go test" | "cargo test" | "jest" | "...",
  "scope": "blast-radius",
  "executionDepth": "static-only" | "scoped-execute" | "full-rehearse",  // mirrors .config.testExecutionDepth
  "command": "<exact command run>",                                       // resolved by resolve_gate_command()
  "commandSource": "lefthook" | "husky" | "package-scripts" | "stack-default",
  "depthAugmentedCommands": ["<extra cmd>", ...],                         // populated when depth != static-only
  "filesInRadius": <int>,     // changed files ∪ reverse-deps, no node_modules/generated
  "packagesScoped": ["<pkg>", ...], // packages actually filtered into the run
  "testFilesExecuted": <int>, // test files actually run (not the whole suite)
  "passed": <int>,
  "failed": <int>,
  "duration": "<wall-clock>", // e.g. "4.2s"
  "failures": [
    { "testFile": "<path>", "testName": "<full-it-id>", "error": "<one-line>",
      "preExistingOnMain": <bool>, "reproducedOnMain": <bool>, "verifiedAt": "<ISO>" }
  ],
  "preExistingFailures": [    // subset of failures[] — pre-existing breakage on main
    { "testFile": "<path>", "testName": "<full-it-id>",
      "verifiedAt": "<ISO>", "verificationMethod": "git stash + checkout main" }
  ],
  "skipped": false,           // true only when reason == "no-test-setup"
  "reason": null              // populated only when skipped == true
}
```

### Severity rules

- Every entry in `failures[]` → `severity: high, category: regression`.
- Do NOT swallow failures into a summary — each failing test is a discrete entry. **Lumping
  multiple failures as a count (`failureCount: 4` without `failures[]`) is forbidden** — the
  consolidator cannot misattribute what's enumerated per-file.
- Pre-existing failures on `main` (`preExistingOnMain: true`) are NOT findings on the current
  branch — but they MUST still be enumerated in `failures[]` and copied to `preExistingFailures[]`.
- No test infrastructure → `skipped: true, reason: "no-test-setup"`. Not a finding; `write-tests`
  bootstraps later.

### Blast-radius computation (mandatory: package-scoped, never test-file-scoped)

```bash
# 1. Enumerate the radius via reverse-deps of every changed file.
RADIUS=$(browzer workflow query changed-files --workflow "$WORKFLOW" | jq -r '.[]')
for F in $RADIUS; do
  browzer deps "$F" --reverse --json --save "/tmp/cr-rdeps-$(echo "$F" | tr '/' '_').json"
done
```

**Run the repo's test command at PACKAGE granularity, not test-file granularity.** Surgical
single-test runs (`--filter <test-file>`) miss every test that depends on the changed file but
isn't named explicitly — exactly the failures the local pre-push gate catches and
`regression-tester` should have caught first.

#### Source the gate command from the project, not from this skill

To avoid drift between code-review and the project's local pre-push hook, the regression-tester
MUST resolve the gate command from project config in this priority order. Never hard-code a
filter set inside this skill — that is precisely the source of "passes in code-review, fails in
pre-push" friction (a pre-push hook scoped to `...[origin/main]` while code-review filtered to
3 explicit packages will diverge whenever a file is added or removed).

```bash
resolve_gate_command() {
  # 1. lefthook.yml pre-push gate (highest priority — this is what the operator's local push runs).
  #    Prefer `yq` when available; fall back to a Node-based YAML parse so this works on any
  #    Node-equipped repo even when yq is not installed.
  for LH in lefthook.yml lefthook.yaml; do
    [ -f "$LH" ] || continue
    LEFTHOOK_CMD=""
    if command -v yq >/dev/null 2>&1; then
      LEFTHOOK_CMD=$(yq -r '.pre-push.commands.unit-tests.run // .pre-push.commands.tests.run // .pre-push.commands.gate.run // ""' "$LH" 2>/dev/null)
    elif command -v node >/dev/null 2>&1 && node -e 'require("js-yaml")' 2>/dev/null; then
      LEFTHOOK_CMD=$(node --input-type=module -e "
        import { readFileSync } from 'node:fs';
        import yaml from 'js-yaml';
        const doc = yaml.load(readFileSync(process.argv[1], 'utf8')) || {};
        const cmds = (doc['pre-push'] && doc['pre-push'].commands) || {};
        const pick = cmds['unit-tests'] || cmds['tests'] || cmds['gate'];
        process.stdout.write((pick && pick.run) || '');
      " "$LH" 2>/dev/null)
    else
      # Last-resort grep fallback: extract the first 'run:' line under a known command name.
      LEFTHOOK_CMD=$(awk '/^[[:space:]]*(unit-tests|tests|gate):/ {flag=1; next} flag && /^[[:space:]]*run:/ {sub(/^[[:space:]]*run:[[:space:]]*/, ""); print; exit}' "$LH" 2>/dev/null)
    fi
    if [ -n "$LEFTHOOK_CMD" ] && [ "$LEFTHOOK_CMD" != "null" ]; then
      echo "$LEFTHOOK_CMD"; return 0
    fi
  done

  # 2. .husky/pre-push (npm convention)
  if [ -f .husky/pre-push ]; then
    HUSKY_CMD=$(grep -E '^(pnpm|npm|yarn|bun)\s+(run\s+)?(gate|test|check)' .husky/pre-push | head -1)
    if [ -n "$HUSKY_CMD" ]; then echo "$HUSKY_CMD"; return 0; fi
  fi

  # 3. package.json scripts.gate (explicit gate convention)
  if [ -f package.json ]; then
    GATE=$(jq -r '.scripts.gate // empty' package.json)
    if [ -n "$GATE" ]; then echo "pnpm run gate"; return 0; fi
  fi

  # 4. Stack-default fallback (only when above all empty)
  case "$RUNNER" in
    vitest|jest)  echo "pnpm test --filter='...[origin/main]' 2>&1 | tee /tmp/cr-regression.log" ;;
    pytest)       echo "pytest --rootdir=. -q 2>&1 | tee /tmp/cr-regression.log" ;;
    "go test")    echo "go test ./... 2>&1 | tee /tmp/cr-regression.log" ;;
    "cargo test") echo "cargo test 2>&1 | tee /tmp/cr-regression.log" ;;
    *)            echo "" ;;  # caller MUST stop with hint when empty
  esac
}

GATE_CMD=$(resolve_gate_command)
if [ -z "$GATE_CMD" ]; then
  echo "regression-tester: stopped — no project gate command discoverable"
  echo "hint: declare scripts.gate in package.json or wire pre-push in lefthook.yml/.husky/"
  exit 1
fi
```

Record the resolved command verbatim under `regressionRun.command` AND its source under
`regressionRun.commandSource` (`lefthook|husky|package-scripts|stack-default`) so retro-analysis
can detect drift between what was reviewed and what gates the local push.

For other toolchains, mirror the pattern: pytest at directory/module granularity, `go test ./<pkg>/...`,
`cargo test --package <pkg>`. NEVER pass a single test file or a single test name.

### Phase 5.1 — Execution depth (config-driven; static-only by default)

The regression-tester respects `.config.testExecutionDepth` (set by the orchestrator at Step
2.7; absent → `static-only`). Three modes:

| Depth | Behavior |
| --- | --- |
| `static-only` (default) | Run lint + typecheck + unit-test only (the resolved gate command above). Skip integration / e2e. Right for fast PR review when CI will catch the rest. |
| `scoped-execute` | When the diff includes new files matching `*.integration.test.*` or `*.e2e.test.*`, additionally run the matching suite at package granularity (`pnpm test:integration --filter <pkg>`, `pnpm test:e2e --filter <pkg>`, or stack-equivalent). Keeps cost bounded to the changed surface. |
| `full-rehearse` | Run the project's complete test pipeline (`scripts.gate` + `scripts.test:integration` + `scripts.test:e2e`) at the same granularity CI does. Adds ≥10 min per code-review run; reserve for risky / cross-service changes. |

```bash
DEPTH=$(jq -r '.config.testExecutionDepth // "static-only"' "$WORKFLOW")

case "$DEPTH" in
  scoped-execute)
    # Augment GATE_CMD with integration/e2e suites IFF the diff added matching files
    NEW_INTEGRATION=$(git diff --name-only --diff-filter=A origin/main...HEAD | grep -E '\.integration\.test\.[a-z]+$' || true)
    NEW_E2E=$(git diff --name-only --diff-filter=A origin/main...HEAD | grep -E '\.e2e\.test\.[a-z]+$' || true)
    if [ -n "$NEW_INTEGRATION" ]; then
      INT_CMD=$(jq -r '.scripts["test:integration"] // empty' package.json)
      [ -n "$INT_CMD" ] && SCOPED_CMDS="$SCOPED_CMDS pnpm test:integration"
    fi
    if [ -n "$NEW_E2E" ]; then
      E2E_CMD=$(jq -r '.scripts["test:e2e"] // empty' package.json)
      [ -n "$E2E_CMD" ] && SCOPED_CMDS="$SCOPED_CMDS pnpm test:e2e"
    fi
    ;;
  full-rehearse)
    # Run the full pipeline regardless of diff
    SCOPED_CMDS="pnpm run gate"
    [ -n "$(jq -r '.scripts["test:integration"] // empty' package.json)" ] && SCOPED_CMDS="$SCOPED_CMDS && pnpm test:integration"
    [ -n "$(jq -r '.scripts["test:e2e"] // empty' package.json)" ] && SCOPED_CMDS="$SCOPED_CMDS && pnpm test:e2e"
    ;;
  static-only|*)
    SCOPED_CMDS=""
    ;;
esac
```

Record the depth in `regressionRun.executionDepth` and the additional commands run in
`regressionRun.depthAugmentedCommands[]` (empty array on static-only).

### Per-failure enumeration

After the suite returns, parse the runner's structured output (e.g. `vitest --reporter=json`,
`pytest --report-log=...`, `go test -json`) and produce one `failures[]` entry per failing
test (`it.fullName`, `path::TestName`, etc.). Lumping into a count is rejected at code-review
write-time — the audit script enforces `len(failures) == failed`.

### Pre-existing-on-main verification (per failure, not per package)

For each entry in `failures[]`, reproduce the failure against `main` to discriminate
"introduced by this branch" from "already broken on main":

```bash
# 1. Stash uncommitted work + checkout main.
git stash push -u -m "regression-tester: preExisting probe"
git checkout main --quiet

# 2. Re-run the exact same package-scoped test command.
pnpm turbo test --filter='...[origin/main]' 2>&1 | tee /tmp/cr-main-baseline.log

# 3. Restore the branch state.
git checkout - --quiet
git stash pop --quiet
```

For each entry in the original `failures[]`, compare against `/tmp/cr-main-baseline.log`:
- If the same `<testFile>::<testName>` failed on main too → mark `preExistingOnMain: true`,
  copy the entry into `preExistingFailures[]`.
- Otherwise → `preExistingOnMain: false`. This entry IS a regression caused by the branch.

Stamp `verifiedAt: "<ISO>"` and `verificationMethod: "git stash + checkout main"` on every
entry. Failures that report `preExistingOnMain: true` without a `verifiedAt` stamp are
rejected by the consolidator — assertion based on hash-equality checks (`git diff main -- <file>`)
is NOT a substitute for actually running the suite on main.
