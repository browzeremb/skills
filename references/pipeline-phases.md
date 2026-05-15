# Pipeline phases — canonical order + concurrency notes

> **Cross-skill reference**. Lists the phases of the markdown-chains
> pipeline in canonical order, with brief notes on when each runs and
> how concurrency (`async-vs-await`) is handled at the phase boundary.

The phase order is enforced by `orchestrate-task-delivery`'s state
machine (see `orchestrate-task-delivery/references/state-machine.md`).
Skills MAY be invoked standalone — the state machine just picks them in
this order when run end-to-end.

The chain is **tier-aware**: a haiku-classifier probe runs once at
`orchestrate-task-delivery` Step 0.5, picks `tier ∈ {express, standard,
full}`, and persists the choice to `staging/CONFIG.md`. Subsequent
phases consult `CONFIG.tier` and either dispatch, skip, or run inline
per the canonical
`orchestrate-task-delivery/references/tier-dispatch-table.md`. Operator
override: `--tier=express|standard|full` at orchestrator entry, or
`--retier` to rerun the probe.

> **Single-owner doc patches.** `finalize-feature` Phase A is the *only*
> place that edits host documentation. Coder subagents under
> `execute-task` and fixer subagents under `receiving-code-review` MUST
> NOT edit `*.md` / `*.mdx` files. Concentrating doc work here is the
> deliberate response to the production-observed pattern of the same
> doc family being patched three or four times across phases. The chain
> runs doc-patching **once**, AFTER `feature-acceptance`, when the
> feature has reached its final symbol surface. A skip rule (no
> exported symbols changed) fires inside `finalize-feature` Phase A0,
> producing `acceptance/DOC_PATCHES.md` with `skipped: true` and
> proceeding straight to README rendering.

> **Tests authored inline by execute-task.** Tests live in the host
> codebase, not in a separate phase artefact. The coder dispatched by
> `execute-task` writes both the implementation AND the tests it
> specifies (`TASK_NN.testSpecs[]`) in the same change, then runs a
> hard-fail local quality gate (`lint + typecheck + test`, host-detected)
> before being allowed to mark `TASK_NN.completed.md`. There is no
> standalone `write-tests` phase. Mutation testing is removed from the
> workflow entirely — the regression-tester lane (Opus, non-collapsible)
> covers baseline-failure detection against `main` via git-stash; the qa
> lane covers semantic-review of the diff; the post-fix `regression-guard`
> covers regressions over the aggregate diff.

| # | Phase | Skill | Output artefact | Async-vs-await | Tier dispatch |
|---|---|---|---|---|---|
| 0 | (Init) | orchestrator inline | `CONFIG.md` (incl. `tier`, `executionStrategy`, `acceptanceMode`) | await — synchronous write | all tiers |
| 0.5 | (Probe tier) | orchestrator + `probe-tier.mjs` | `CONFIG.tier` populated | await — single haiku dispatch | all tiers (skipped on `--tier=` override or resume) |
| 1 | Brainstorming (optional) | `brainstorming` | `planning/BRIEF.md` | await — operator-interactive | all tiers (gated by intent heuristic) |
| 2 | PRD | `generate-prd` (via `Agent(browzer:pm)`) | `planning/PRD.md` | await | **express**: skipped — orchestrator writes a `## PRD-compact` section into `planning/BRIEF.md` inline. **standard**: sonnet + compact template. **full**: opus + full template. |
| 3 | Scope feature | `scope-feature` (via `Agent(browzer:scoper)`) | `planning/EXPLORATION.md` | await | **express**: skipped — orchestrator runs `browzer deps --reverse` + `Skill(browzer:find-skills, programmatic)` inline. **standard**: haiku medium effort, max 30 files. **full**: haiku high effort, no cap. |
| 4 | Task plan | `generate-task` (via `Agent(browzer:po)`) | `tasks/TASK_NN.md` (× N); `tasks/TASK_GRAPH.md` only when `executionStrategy != "serial"` | await | **express**: skipped — orchestrator writes `tasks/TASK_01.md` inline (closed prompt assembled from probe output + `browzer deps --reverse` + find-skills). **standard**: sonnet + cap 5 tasks. **full**: per-COMPLEXITY signal, no cap. |
| 5 | Execute | `execute-task` (loops per task) | `tasks/TASK_NN.{completed,failed}.md` (incl. `qualityGate` + `testsAdded[]` frontmatter) | depends on `CONFIG.executionStrategy`: `serial` → await; `parallel`, `parallel-worktrees`, `agent-teams` → async parallel dispatch | all tiers — coder writes tests inline and the hard-fail local quality gate (lint+typecheck+test) is mandatory before the atomic rename to `.completed.md`. Full tier additionally runs `build` on packages whose public API changed. |
| 6 | Code review | `code-review` | `review-lanes/CODE_REVIEW.<lane>.md` (× N), `review/CODE_REVIEW.md` | lanes dispatched async parallel; aggregator awaits all lanes | all tiers — 4 mandatory Opus lanes (senior-engineer, software-architect, qa, regression-tester) + cheap `pr-coherence` haiku lane + N dynamic specialists. **regression-tester lane** detects baseline failures against `main` via git-stash; **qa lane** runs the butterfly probe on `reverseDeps`; **mutation testing is NOT part of the lane** (removed from the workflow entirely). |
| 7 | Receiving review | `receiving-code-review` | `fixes/F-NNN.{completed,tech_debt}.md`, `fixes/FIXES.md`, in-place patch of `review/CODE_REVIEW.md.frontmatter.findings[].fixStatus` | per-finding dispatch parallel for file-disjoint clusters; contested-file findings serialized; aggregator awaits all fixers | all tiers — 7-step ladder unchanged. Skipped via state-machine when `review/CODE_REVIEW.md.findings[]` is empty. |
| 7.5 | Regression guard | `regression-guard` | `review/GATE_REPORT.md`; may append HIGH findings into `review/CODE_REVIEW.md` and re-route back to `receiving-code-review` | await — single dispatch; in-skill the gate commands run sequentially | all tiers — re-runs the host quality gate over the aggregate post-fix diff. Max 3 rounds total (initial + 2 reruns). **State-machine bypass** when `fixes/` is empty (no fixes to validate). |
| 8 | Feature acceptance | `feature-acceptance` | `acceptance/ACCEPTANCE.md` | await; if mode is `autonomous-with-stack-boot`, the boot procedure is itself async-bounded (max 120s); Phase 3.5 re-validates shell-runnable ACs against the post-fix artefact | **express**: `mode=smoke` — verify AC touched in diff; no stack boot. **standard**: `mode=hybrid` — boot only touched apps. **full**: `mode=autonomous-with-stack-boot` when capabilities permit. |
| 9 | Finalize | `finalize-feature` | Phase A: `acceptance/DOC_PATCHES.md` (inline doc-patching, no subagent; skipped when no exported-symbol drift). Phase B: `README.md` (self-contained committed summary). | await (Phase A → B sequential within the skill) | all tiers — Phase A skip rule unchanged; Phase B always runs. |
| 10 | Commit | `commit` | git commit | await (synchronous git commit; trailer `Feature: <featureId>` enables post-cleanup DONE detection) | all tiers |

---

## When to prefer async over await

The default at every phase boundary is **await**: the orchestrator
blocks for the dispatched skill to land its artefact before re-running
`detect-phase`. This is correct for `serial` execution and for any
phase whose output the next phase reads directly.

**Async** is used only WITHIN a phase, never AT a phase boundary:

- `execute-task` with `executionStrategy: parallel` dispatches multiple
  `browzer:coder` subagents in parallel, then awaits all before
  declaring the phase complete.
- `code-review` dispatches all reviewer lanes (4 mandatory + pr-coherence
  haiku + N specialists) in parallel, then awaits all before running
  the aggregator.
- `receiving-code-review` dispatches non-contested-file fixers in
  parallel within each severity tier, serializing contested-file fixers.
  The aggregator (`aggregate-fixes.mjs`) runs once, after every fixer
  reports.

The orchestrator's state machine ONLY sees the await result — async
internals are transparent to the boundary.

---

## Single-writer aggregation pattern

Phases with parallel writers MUST follow this pattern: parallel agents
write isolated paths (one file per agent); an aggregator runs **exactly
once** after the batch has completed (skill body explicitly waits),
reads all isolated files, and writes the consolidated artefact downstream
skills read.

| Phase | Parallel writers | Aggregator | Consolidated output | Downstream consumer |
|---|---|---|---|---|
| code-review | `review-lanes/CODE_REVIEW.<lane>.md` (1 per lane) | `aggregate-findings.mjs` | `review/CODE_REVIEW.md` | receiving-code-review, regression-guard, finalize, judge |
| receiving-code-review | `fixes/F-NNN.{completed,tech_debt}.md` (1 per finding) | `aggregate-fixes.mjs` | `fixes/FIXES.md` + in-place patch of `review/CODE_REVIEW.md.frontmatter.findings[].fixStatus` | regression-guard, finalize, judge |

Aggregators are deterministic and idempotent — rerunning on the same
inputs produces the same output.

---

## Phase-skip rules

| Skip when | Skipped phase |
|---|---|
| `CONFIG.tier == express` | `generate-prd`, `scope-feature`, `generate-task` (orchestrator inline-writes their outputs) |
| Operator's request is rich enough (persona + success + scope all explicit) | `brainstorming` (Phase 1) — direct to next-phase |
| `review/CODE_REVIEW.md.frontmatter.findings[]` is empty | `receiving-code-review` and `regression-guard` — direct to `feature-acceptance` |
| `staging/fixes/` is empty (no fixers ran) | `regression-guard` — per-task quality gates already validated the diff |
| Every upstream `### Symbols changed` is `(none)` OR all symbols are `scope: internal` | `finalize-feature` Phase A (doc-patching) skipped inline; Phase B (README) still runs |

Skipped phases either emit their artefact (with `skipped: true`
frontmatter and a one-line rationale) OR the state machine routes
around them by glob (regression-guard bypass, express-tier skips). The
state machine documents both routing styles.

---

## HALT conditions

The orchestrator HALTs (exits 0, awaits operator) when:

- Any `tasks/TASK_*.failed.md` exists (Phase 5 entry guard).
- Any `fixes/F-*.tech_debt.md` carries `severity: high` without an
  operator-supplied `.browzer/accepted-tech-debt.json` override (Phase 7
  entry guard).
- `review/GATE_REPORT.md` still failing after the third regression-guard
  round (Phase 7.5 entry guard). Operator chooses `--override-gate`
  (recorded in `ACCEPTANCE.md.frontmatter.gateOverride`) or fixes
  manually and re-invokes.
- `acceptance/ACCEPTANCE.md.frontmatter.verdict == rejected` (Phase 8
  exit guard).

A HALT is NOT an error — it's a deliberate hand-off to the operator.
The orchestrator resumes when re-invoked with the same `<featureId>`
after the operator addresses the underlying issue.
