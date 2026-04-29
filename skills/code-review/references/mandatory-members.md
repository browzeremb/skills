# Code Review — Mandatory Member Briefs

The four mandatory members of every `code-review` dispatch, regardless of tier (basic / recommended / custom). All four ALWAYS run. Briefs below describe scope, execution, and the exact `codeReview` payload fields each role populates.

Every mandatory agent receives the same context bundle — the orchestrator pre-computes it once before dispatch:

- The diff (`git diff $BASE_REF...HEAD -- <scope files>`).
- `browzer deps <file>` (forward) per changed file → `/tmp/cr-deps-<slug>.json`.
- `browzer deps <file> --reverse` (blast radius) per changed file → `/tmp/cr-rdeps-<slug>.json`.
- `browzer mentions <file>` per changed file → `/tmp/cr-mentions-<slug>.json`.
- A standing licence to run `browzer explore "<symbol or behaviour>"` for prior-art / duplication lookups.

Without the deps + mentions snapshot, butterfly-effect bugs (constant change in file A breaks file B four imports away) are invisible. Agents that file findings without consulting the bundle when the bundle was relevant fail the Step-0 audit.

---

## Senior Engineer

**Role**: code quality + craft reviewer.

**Owns**:

- **Cyclomatic complexity** per changed file (configurable threshold, default 10):
  - JS/TS: `npx complexity-report <file>` or `eslint --rule 'complexity: [error, 10]'`
  - Python: `radon cc <file>`
  - Go: `gocyclo <file>`
  - Rust: `cargo clippy -- -W clippy::cognitive_complexity`

  Records `codeReview.cyclomaticAudit[]`:

  ```jsonc
  { "file": "apps/api/src/routes/foo.ts", "maxComplexity": 12, "threshold": 10, "verdict": "warn" }
  ```

  Verdicts: `ok` | `warn` | `fail`.

- **DRY / duplication.** When the same pattern (cast, validation wrapper, fetch wrapper, header parsing, error handler, session shape) appears across **3+ files in the diff** OR is detected via `browzer explore` elsewhere in the repo, emit `codeReview.duplicationFindings[]: { pattern, files, suggestedExtraction }` AND a regular finding (severity: low / medium depending on impact). Three nearly-identical lines is one missed abstraction.

- **Clean code & best practices** — naming, function length, single responsibility, magic numbers, dead code, log-vs-throw discipline, error-handling shape, return-type honesty, comment-rot.

- **AC-calibration audit.** Scan PRD `acceptanceCriteria[]` + `nonFunctionalRequirements[]` for numeric thresholds via `<=\s*\d+\s*(s|ms|seconds|minutes|m)\b` (and symmetric). Grep the diff for related constants (`*_TIMEOUT_MS`, `*_BUDGET_*`, `MAX_*_MS`, hardcoded literals). When a code constant is mismatched against the AC by **>2×** in either direction, emit `severity: medium, category: ac-calibration`.

**Categories**: `cyclomatic` | `duplication` | `clean-code` | `style` | `ac-calibration` | `invariant-violation`.

**Severity mapping**:
- Invariant violation → **high**.
- Cyclomatic > 2× threshold → **high**.
- Cyclomatic between threshold and 2× → **medium**.
- DRY / duplication with active divergence in the diff → **medium**.
- Style / naming / comment issues → **low**.

---

## Software Architect

**Role**: system design + non-functional concerns reviewer.

**Owns**:

- **Race conditions / TOCTOU** — concurrent writes, validate-then-create ordering, missing locks, stale reads, double-spend windows, idempotency-key gaps. Walk the reverse-deps to detect callers that assumed a check happened atomically.
- **Clean architecture** — layer boundaries, dependency direction (UI → app → domain → infra, not backwards), leaky abstractions, accidental cross-cutting coupling, missing seams (interfaces, ports/adapters where the change argues for one).
- **Caching** — cache-key correctness, invalidation strategy, stampede risk, TTL sanity, cache-aside vs write-through fit, observable read-amplification regressions.
- **Performance** — N+1, unbounded loops over external state, sync I/O on hot paths, allocation in tight loops, missing pagination, p99 implications of the change.

When a finding hinges on an architectural pattern, cite a specific file:line, name the failing pattern (TOCTOU, layer-violation, cache-stampede, etc.), and propose a concrete experiment or fix sketch — speculation does not earn a finding.

**Categories**: `race-condition` | `architecture` | `caching` | `performance`.

**Severity mapping**:
- Race condition with money or data-integrity stakes → **high**.
- Missing cache invalidation that produces stale tenant-visible data → **high**.
- Layer violations affecting testability or maintainability → **medium**.
- Performance regressions ≥ 2× without justification → **medium**.
- Speculative perf concerns without evidence → **not a finding**; either find evidence or drop it.

---

## QA

**Role**: regression hunting + edge cases + butterfly-effect risk reviewer.

**Owns**:

- **Regressions (review, not run)** — does the diff remove pre-existing tests, change a public-surface behaviour without updating callers, or modify a serialization shape that downstream consumers will silently misread? Read both sides of every changed boundary.
- **Edge cases** — empty / null / undefined / boundary / negative / very-long / concurrent / failure-mode inputs against every modified branch.
- **Butterfly-effect** — for each changed constant, type, or shared helper, walk the reverse-deps list AND the mentions list and flag callers/docs whose assumptions the change quietly invalidates. Example: `MAX_RETRY = 3 → 5` looks safe until reverse-deps shows a backoff calculator that assumed `MAX_RETRY ≤ 4`. Emit `category: butterfly-effect` with the file pair AND the broken assumption stated explicitly.
- **Cross-tenant / cross-org leak risk** — any code path that swaps or aggregates tenant state without re-scoping is a high-severity finding.

QA reads the regression-tester's `regressionRun` output once it lands and may file additional findings if the failure pattern hints at a deeper test gap.

**Categories**: `regression` | `edge-case` | `butterfly-effect` | `tenancy-leak` | `missing-coverage`.

**Severity mapping**:
- Silent behaviour drift on a public surface → **high**.
- Butterfly-effect with active blast-radius (the dependent file is in the same diff or in active feature work) → **high**.
- Removed tests with no replacement → **high**.
- Missing edge-case on a low-risk path → **low**.

---

## Regression Tester

**Role**: empirical verification — runs scoped tests, does NOT review.

**Execution**:

1. **Compute the test-blast-radius set** = changed files ∪ reverse-deps of changed files. Limit to files within test discoverability (no `node_modules`, no generated dirs).
2. **Run the repo's test command scoped to the radius** — invoke the actual runner targeting the test files that cover the radius:
   - JS/TS: `pnpm vitest run <test-paths>` or `pnpm jest <test-paths>`
   - Python: `pytest <test-paths>`
   - Go: `go test ./<pkgs>/...`
   - Rust: `cargo test -p <crate>`
   Do NOT run the whole suite blindly; the baseline gate already covered repo-wide health in Phase 1.
3. **Record per-radius-file pass/fail** in `codeReview.regressionRun`:

   ```jsonc
   "regressionRun": {
     "tool": "vitest" | "pytest" | "go test" | "cargo test" | "jest" | "...",
     "scope": "blast-radius",
     "filesInRadius": <int>,
     "testFilesExecuted": <int>,
     "passed": <int>,
     "failed": <int>,
     "duration": "<wall-clock>",
     "failures": [
       { "testFile": "<path>", "testName": "<id>", "error": "<one-line>" }
     ]
   }
   ```

4. **File ONE finding per failure** with `severity: high, category: regression`. Quote the failing test's identifier in `description`. Do NOT swallow failures into a summary.
5. **Read-only.** This agent does NOT alter tests or code. If a test should be added/changed, file a finding for QA's lane (or senior-engineer's) — `write-tests` handles authoring AFTER `receiving-code-review` closes findings.
6. **No-test-setup carve-out.** When `write-tests`' detector returns `hasTestSetup: false` (or when the runner is missing entirely), record `regressionRun: { skipped: true, reason: "no-test-setup" }` and proceed without filing findings. The orchestrator's `write-tests` phase later bootstraps coverage.

**Categories**: `regression` (only).

**Severity mapping**: every failing test in the blast radius is **high**. No setup → no finding (recorded skip).

---

## Cross-role test-setup security rule (owned by QA, surfaced to Senior + Security)

Any test setup that loads real environment variables can leak third-party API calls into integration test runs — sending real emails, charging real cards, calling paid APIs against the operator's account, hitting rate limits on shared keys. The leak is silent (tests still pass) and only surfaces when the third-party quota is exhausted or the bill arrives.

**Rule.** Any test-setup file that loads env vars from a real `.env*` source (via `dotenv`, vitest `setupFiles`, jest `globalSetup`, pytest `conftest.py`, etc.) MUST do ONE of the following for every third-party API key it surfaces:

1. **Hard-pin to a non-functional sentinel** before tests run:
   ```ts
   process.env.RESEND_API_KEY = "re_test_DO_NOT_DISPATCH"
   process.env.STRIPE_SECRET_KEY = "sk_test_INVALID_FOR_TESTS"
   ```
2. **Mock the SDK at module level** so no network call leaves the process:
   ```ts
   vi.mock("resend", () => ({ Resend: vi.fn(() => ({ emails: { send: vi.fn().mockResolvedValue({ id: "mocked" }) } })) }))
   ```

What is NOT acceptable: relying on `.env.test` to contain test keys, relying on the developer to "remember" to override, or running tests against the operator's personal API account because "the quota is generous".

**Detection (QA's job during code-review).** Grep the diff for these patterns and flag a `high`-severity finding under `category: security` if a third-party SDK is surfaced WITHOUT a sentinel-pin or module-level mock alongside:

- `setupFiles` / `globalSetup` paths importing `dotenv`, `dotenv-flow`, `@dotenvx/dotenvx`.
- Direct `process.env.*` assignment from real keys without a guard.
- `import { Resend | Stripe | OpenAI | Anthropic | Twilio | SendGrid | Postmark } from "<package>"` inside a test or test-setup file with no surrounding `vi.mock` / `jest.mock`.

Senior Engineer surfaces the same finding under `category: invariant-violation` if the leak crosses a tenant boundary. The optional `security` recommended-member elevates severity to `high` regardless of category when the leaked SDK has financial side-effects (Stripe, billing, email-with-cost).
