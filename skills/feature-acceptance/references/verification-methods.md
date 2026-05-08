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

- **Testable** → scoped `pnpm test --filter=<pkg>`. Parse pass/fail +
  test names.
- **Inspectable** → dispatch an `Agent` (sonnet) to examine code;
  require file paths + line ranges.
- **Metric-gated** → HTTP probe / Prometheus query / latency bench;
  compare to NFR/metric target.

Record: `{ id, status: "verified|unverified|failed", evidence, method:
"test|inspect|metric" }`.

## §2.4 — NFR check categories

| Category | Check |
| --- | --- |
| `perf` | `pnpm bench` or `k6 run`; compare p50/p95 to target. |
| `security` | `pnpm audit` + invariant checks (`timingSafeEqual`, `getWorkspace(id,orgId)` scoping). |
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
