# Verification methods, NFR categories, success-metric gates

Operational reference for `feature-acceptance` Phase 2 sub-steps 2.3
through 2.7. Factored out of `SKILL.md` to keep the body under the
per-skill line cap.

> **Mode applicability.** These methods apply in `autonomous` and
> `hybrid` modes for items Phase 0 marked `runnable-here: true`. Items
> NOT runnable here (and every item in `manual` mode) are emitted as
> copy-pasteable runbook blocks per
> `references/manual-instructions.md` and routed to
> `operatorActionsRequested[]` instead of being verified inline.

## §2.3 — Verification methods (per AC)

### Resolution order

For each AC, resolve the verification method in this order:

1. **Structured `verification:` block** present in
   `PRD.md.frontmatter.acceptanceCriteria[i].verification` → use it
   verbatim. This is the contract path. The block is the AC's executable
   shape; never re-infer when the block exists.
2. **Text-inference fallback** when `verification:` is absent → apply
   the legacy heuristics below (Testable / Inspectable / Metric-gated).
   Mark `methodResolvedVia: "text-inference"` in `perAcVerdict[i]` so
   the post-write audit can surface PRDs that should have carried
   structured blocks.

### Structured-block consumer rules (PRIORITY path)

When `verification:` is present:

- `kind: shell-runnable` AND `requires[]` are all in Phase 0's `caps`
  map AND `failure-mode: pre-commit`:
  - Execute each `commands[i].run` via Bash with `timeout` enforced.
  - Match `commands[i].expect`:
    - `exit-code:N` → exit code MUST equal N.
    - `contains:"<string>"` → stdout MUST contain literal string.
    - `regex:"<pattern>"` → stdout MUST match the regex.
    - `stdout-empty` → trimmed stdout MUST be empty.
    - `stdout-nonempty` → trimmed stdout MUST have ≥1 character.
  - All `commands[]` must pass → `verdict: pass`. Any fail →
    `verdict: fail`. Timeout → `verdict: fail` with
    `evidence: "command timed out at <timeout>s"`.
- `kind: shell-runnable` AND any `requires[]` is NOT in `caps`:
  - `verdict: deferred`; route to `operatorActionsRequested[]` with
    `timeline: requires-external-cluster` per
    `${CLAUDE_SKILL_DIR}/SKILL.md §Phase 1 operatorAction classification`.
- `kind: http-probe` → identical flow to `shell-runnable` but commands
  expect curl/http verbs. Phase 0 `autonomous-with-stack-boot` must have
  the target service up.
- `kind: browser-probe`:
  - If Phase 0 detected MCP browser tool (`mcp__chrome-devtools__*`,
    `mcp__playwright__*`, `mcp__claude-in-chrome__*`) OR `agent-browser`
    skill installed → dispatch a single `Agent` (sonnet) per AC with the
    browser tool, exercise `commands[]`, match `expect`. Record
    `methodResolvedVia: "browser-mcp"` + which MCP was used.
  - Else → hybrid runbook line referencing the AC's verbatim text and
    the `commands[]` for manual execution.
- `kind: metric-query`:
  - When the metric backend is live (Langfuse host reachable, Grafana
    URL reachable, Postgres readable), execute the query and compare.
  - Else `verdict: deferred` with `timeline: requires-time-window` when
    the metric is rolling (e.g. "30-day p95") and the deliverable
    landed today — defer with the timeline noted.
- `kind: manual` → ALWAYS `verdict: deferred` + `timeline:
  requires-human-judgment`. Never auto-flip to pass on synthetic
  equivalents. The §2.5.1 anti-soft-override regex applies even to
  rationales that look like code-equivalent matches.
- `kind: requires-cluster` → ALWAYS `verdict: deferred` + `timeline:
  requires-external-cluster`. Record verbatim what the operator must
  do post-merge.

`verification.metric.bindsTo` (when present) links the AC's pass/fail
to a `successMetrics[]` row. The §2.5 / §2.5.1 success-metric gate
then anchors on this AC's outcome instead of inferring from prose.

### Text-inference fallback (legacy heuristics)

- **Testable** → scoped test run via the host's test runner (probe
  package.json scripts / Makefile / cargo / pytest / go test for the
  appropriate filter). Parse pass/fail + test names.
- **Inspectable** → dispatch an `Agent` (sonnet) to examine code;
  require file paths + line ranges.
- **Metric-gated** → HTTP probe / Prometheus query / latency bench;
  compare to NFR/metric target.

Record: `{ id, status: "verified|unverified|failed", evidence, method:
"test|inspect|metric", methodResolvedVia: "structured-block|text-inference" }`.

## §2.4 — NFR check categories

| Category | Check |
| --- | --- |
| `perf` | Host's benchmark runner (probe for `bench` / `benchmark` / `perf` aliases in package.json / Makefile, or use `k6 run` / `go test -bench` / `pytest-benchmark` as fallback); compare p50/p95 to target. |
| `security` | Host's vulnerability scanner (`pnpm audit` / `npm audit` / `cargo audit` / `pip-audit` depending on stack) + invariant checks (constant-time comparisons, tenant-scope predicates, etc.). |
| `a11y` | Axe-core or Playwright a11y probe against affected UI surface. |
| `observability` | Grep for instrumented call, probe endpoint, read trace. |
| `scalability` | Dispatch Agent to inspect tenant scoping + resource allocation. |

Record: `{ id, status: "verified|partial|failed", coversAcceptanceSignal:
"pass|warn|block", evidence, measured, target }`.

## §2.5 — Success metrics

For each metric in `prd.successMetrics[]`: probe/query/CI artefact,
compare to target, record as `{ id, measured, target, status:
"met|unmet", resolved: <bool>, rationale: "<verbatim>" }`.

**Run the §2.5.1 anti-soft-override regex BEFORE flipping any
`resolved: true`** — see `references/live-verify.md §Phase 2.5.1`.
Metrics whose description / target match the regex
(`dashboard|browser|UI|/ask|/sync|live|post-merge|operator
action|...`) are reserved for the operator: in autonomous mode they
MUST stay `resolved: false` with status `unmet` and an
`operatorActionsRequested[]` entry, **regardless of how cleanly a
synthetic-equivalent test ran**. Free-text rationales like
"test-equivalent", "synthetic equivalent", "covered by unit test" are
auto-rejected.

## §2.6 — Operator-action gate

See `references/live-verify.md §Phase 2.6` for the full
anti-soft-override regex and action steps. This gate runs AFTER
Phase 1.5 — ACs verified by the live-verify probe bypass it.

See `references/live-verify.md §Phase 2.6.1` for AC-target relaxation
protocol.

## §2.7 — Manual + hybrid checklist

See `references/live-verify.md §Phase 2.7` for the checklist template.
