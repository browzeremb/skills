# Pipeline phases — canonical order + concurrency notes

> **Cross-skill reference**. Lists the 12 phases of the markdown-chains
> pipeline in canonical order, with brief notes on when each runs and
> how concurrency (`async-vs-await`) is handled at the phase boundary.

The phase order is enforced by `orchestrate-task-delivery`'s state
machine (`packages/skills/skills/orchestrate-task-delivery/references/state-machine.md`).
Skills MAY be invoked standalone — the state machine just picks them in
this order when run end-to-end.

> **Single-owner doc patches.** `update-docs` is the *only* phase that
> edits documentation. Coder subagents under `execute-task` and fixer
> subagents under `receiving-code-review` MUST NOT edit `*.md` / `*.mdx`
> files. Concentrating doc work here is the deliberate response to the
> production-observed pattern of the same doc family being patched three
> or four times across phases. The chain runs `update-docs` **once**,
> AFTER `feature-acceptance`, when the feature has reached its final
> symbol surface; the legacy "primary + drift-catch" dual-pass was
> collapsed to a single post-acceptance pass (RETRO §15 #4 +
> JUDGMENT §3.15 P2). The skip rule (no exported symbols changed) fires
> in `detect-phase` BEFORE the Phase A explorer dispatches, eliminating
> the over-save-to-/tmp-receipt class.

> **Write-tests before code-review.** Tests are authored after execute
> and BEFORE the code-review lanes spawn, so the qa lane receives
> `TESTS.md` (mutation coverage + surviving-mutant evidence) in its
> brief. The senior-engineer + architect lanes weigh against the test
> surface rather than reviewing code in isolation. RETRO §15 #2 +
> JUDGMENT §3.15 documented the bias toward catching live-verification
> escapes when mutation evidence is on hand at review time.

| # | Phase | Skill | Output artefact | Async-vs-await |
|---|---|---|---|---|
| 0 | (Init) | orchestrator inline | `CONFIG.md` | await — synchronous write |
| 1 | Brainstorming (optional) | `brainstorming` | `BRIEF.md` | await — operator-interactive |
| 2 | PRD | `generate-prd` (via `Agent(browzer:pm)`) | `PRD.md` | await |
| 3 | Scope feature | `scope-feature` (via `Agent(browzer:scoper)`) | `EXPLORATION.md`, `EXPLORATION_BLAST.mmd` | await |
| 4 | Task plan | `generate-task` (via `Agent(browzer:po)`) | `TASK_NN.md`, `TASK_GRAPH.md` | await |
| 5 | Execute | `execute-task` (loops per task) | `TASK_NN.{completed,failed}.md` | depends on `CONFIG.executionStrategy`: `serial` → await; `parallel`, `parallel-worktrees`, `agent-teams` → async parallel dispatch |
| 6 | Write tests | `write-tests` | `TESTS.md` | await (single dispatch); runs BEFORE code-review so qa lane gets mutation evidence |
| 7 | Code review | `code-review` | `CODE_REVIEW.<lane>.md` (× N), `CODE_REVIEW.md` | lanes dispatched async parallel; aggregator awaits all lanes |
| 8 | Receiving review | `receiving-code-review` | `FIX_F-NNN.{completed,tech_debt}.md`, `RECEIVING_CODE_REVIEW.md` | per-finding dispatch parallel for file-disjoint clusters; contested-file findings serialized (file-overlap map) |
| 9 | Feature acceptance | `feature-acceptance` | `ACCEPTANCE.md` | await; if mode is `autonomous-with-stack-boot`, the boot procedure is itself async-bounded (max 120s); Phase 3.5 re-validates shell-runnable ACs against the post-fix artefact |
| 10 | Update docs (single pass) | `update-docs` | `DOC_PATCHES.md` | await (Phase A → B sequential within the skill); SKIPPED when no exported symbols changed |
| 11 | Finalize | `finalize-feature` | `README.md` | await (single script render; self-audit gate refuses intra-feat hyperlinks and empty original-request blocks) |
| 12 | Commit | `commit` | git commit | await (synchronous git commit; trailer `Feature: <featureId>` enables post-cleanup DONE detection) |

---

## When to prefer async over await

The default at every phase boundary is **await**: the orchestrator
blocks for the dispatched skill to land its artefact before re-running
`detect-phase`. This is correct for `serial` execution and for any
phase whose output the next phase reads directly.

**Async** is used only WITHIN a phase, never AT a phase boundary:

- `execute-task` with `executionStrategy: parallel` dispatches multiple `browzer:coder` subagents in parallel, then awaits all before declaring the phase complete.
- `code-review` dispatches all reviewer lanes (4 mandatory + N specialists) in parallel, then awaits all before running the aggregator.
- `receiving-code-review` dispatches non-contested-file fixers in parallel within each severity tier, serializing contested-file fixers.

The orchestrator's state machine ONLY sees the await result — async
internals are transparent to the boundary.

---

## Phase-skip rules

| Skip when | Skipped phase |
|---|---|
| Operator's request is rich enough (persona + success + scope all explicit) | `brainstorming` (Phase 1) — direct to `generate-prd` |
| Host has no detectable test runner | `write-tests` (Phase 6) sets `skipped: true` in TESTS.md frontmatter; `feature-acceptance` records the gap |
| `CODE_REVIEW.md.frontmatter.totalFindings == 0` | `receiving-code-review` (Phase 8) — direct to `feature-acceptance` |
| Every upstream `### Symbols changed` is `(none)` OR all symbols are `scope: internal` | `update-docs` (Phase 10) skipped entirely by `detect-phase` (no Phase A explorer dispatch) |

Skipped phases STILL emit their artefact (with `skipped: true`
frontmatter and a one-line rationale) — the state machine relies on
file presence for routing.

---

## HALT conditions

The orchestrator HALTs (exits 0, awaits operator) when:

- Any `TASK_*.failed.md` exists (Phase 6 entry guard).
- Any `FIX_F-*.tech_debt.md` carries `severity: high` without an operator-supplied `.browzer/accepted-tech-debt.json` override (Phase 8 entry guard).
- `ACCEPTANCE.md.frontmatter.verdict == rejected` (Phase 11 exit guard).

A HALT is NOT an error — it's a deliberate hand-off to the operator.
The orchestrator resumes when re-invoked with the same `<featureId>`
after the operator addresses the underlying issue.
