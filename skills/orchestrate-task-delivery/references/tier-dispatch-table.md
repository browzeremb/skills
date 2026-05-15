# Tier dispatch table — canonical source

> **Skill-local reference**. This file is the single source of truth
> mapping `{tier → phase → action}`. Consumed by `detect-phase.mjs` at
> runtime; cross-validated against the JS branches in `detect-phase.mjs`
> by `scripts/audit/tier-dispatch-table-drift.mjs` on every push.

Three tiers, persisted at `staging/CONFIG.md.tier`. The probe at
`orchestrate-task-delivery` Step 0.5 picks one of:

- `express` — trivial change, ≤3 files, low blast radius, single
  domain, clear ask. Planning phases skipped entirely; orchestrator
  inline-writes `TASK_01.md` and a compact PRD section into `BRIEF.md`.
- `standard` — small-to-medium feature. PRD/scope/tasks run with
  compact templates and effort caps.
- `full` — large refactor / cross-cutting concern / critical-path
  change. Full planning depth.

The probe's selection rubric and signal weighting live in the
`orchestrate-task-delivery/SKILL.md §Step 0.5` body.

---

## Per-phase actions

Action vocabulary:

- `dispatch(<skill>, <model>?, <effort>?, <extra>...)` — orchestrator
  dispatches the named skill (or subagent) with the listed args. The
  dispatched skill reads `CONFIG.tier` from `staging/CONFIG.md` itself
  to branch its body on `## Tier-aware mode`.
- `skip` — state machine advances the pointer past this phase without
  any artefact. Trace records the skip with the per-tier rationale.
- `inline(<artefact>)` — orchestrator writes the artefact directly
  (no agent dispatch). Combines: probe output + `browzer deps --reverse`
  on candidate files + `Skill(browzer:find-skills, programmatic)` for
  the relevant domain hints.
- `run` — skill always runs (tier-independent).

| Phase | express | standard | full |
|---|---|---|---|
| `brainstorming` (Phase 1) | `skip` (always) | `dispatch(browzer:brainstorming)` if intent-detection heuristic triggers; else `skip` | same as standard |
| `generate-prd` (Phase 2) | `inline(planning/BRIEF.md §PRD-compact)` — orchestrator appends a `## PRD-compact` heading to BRIEF.md carrying `originalRequest`, `functionalRequirements`, `acceptanceCriteria` verbatim from the probe output | `dispatch(browzer:pm, model=sonnet, effort=medium, template=compact)` — 3 required + 1 optional section, target 200–400 lines, USER_STORIES inlined, no per-section NFR reconfirmation | `dispatch(browzer:pm, model=opus, effort=high, template=full)` — 3 required + 5 optional sections, target 800–1000 lines |
| `scope-feature` (Phase 3) | `skip` — orchestrator runs `browzer deps --reverse <candidate-file>` per probe candidateFiles[], plus `Skill(browzer:find-skills, programmatic)` against the candidate-file domains; results are inlined into the inline TASK_01 directly | `dispatch(browzer:scoper, model=haiku, effort=medium)` — max 30 files in scope | `dispatch(browzer:scoper, model=haiku, effort=high)` — no file cap |
| `generate-task` (Phase 4) | `inline(tasks/TASK_01.md)` — orchestrator writes the single TASK file directly, satisfying the closure principle: full TASK_NN.md frontmatter (`acceptanceCriteria[]` verbatim from probe.expectedAC, `functionalRequirements[]` verbatim, `scope.files[].blastRadius` from `browzer deps --reverse`, `skillsFound[]` from find-skills programmatic mode, `testSpecs[]`, `prdSha: null`, `invariants[]` from the canonical preamble) | `dispatch(browzer:po, model=sonnet, effort=medium, cap=5)` — absolute max 5 tasks; instruction "consolidate small tasks" | `dispatch(browzer:po, model + effort per COMPLEXITY signal)` — no cap |
| `execute-task` (Phase 5) | `dispatch(browzer:coder)` — coder writes tests inline alongside implementation; hard-fail quality gate (`lint + typecheck + test`) BEFORE atomic rename to `.completed.md` | same | same plus `build` for any package whose public API changed (detected via export drift in the changed-symbol list) |
| `code-review` (Phase 6) | `run` — 4 mandatory Opus lanes (senior-engineer, software-architect, qa, regression-tester) + cheap `pr-coherence` haiku lane + N dynamic specialists. regression-tester lane scopes to baseline-failure detection against `main` via git-stash (no mutation testing) | same | same |
| `receiving-code-review` (Phase 7) | `run` — 7-step ladder unchanged | same | same |
| `regression-guard` (Phase 7.5) | `run` — host quality gate (lint + typecheck + test) over the aggregate post-fix diff. Failures emit HIGH findings into `review/CODE_REVIEW.md` and loop back to receiving-code-review for round 2/3. Max 3 rounds total before HALT. State-machine bypass when `fixes/` is empty. | same | same |
| `feature-acceptance` (Phase 8) | `dispatch(browzer:feature-acceptance, mode=smoke)` — verify AC from `TASK_01.acceptanceCriteria` touched in diff; no stack boot | `dispatch(browzer:feature-acceptance, mode=hybrid)` — boot only apps with files in any `TASK_*.scope.files[]` | `dispatch(browzer:feature-acceptance, mode=autonomous-with-stack-boot)` when capabilities permit; else falls back to hybrid |
| `finalize-feature` Phase A (doc patching) | `run` — Phase A0 skip rule (no exported-symbol drift) applies as before | same | same |
| `finalize-feature` Phase B (README) | `run` | same | same |
| `commit` (Phase 10) | `run` | same | same |

---

## Machine-readable schema

`detect-phase.mjs` parses the table above using the heading shape `|
<phase> | <express> | <standard> | <full> |`. The table is intentionally
constrained — each cell holds exactly one action token (`dispatch`,
`skip`, `inline`, or `run`) plus optional parameters in parentheses.

Drift between this file and the JS branches in `detect-phase.mjs` is a
hard pre-push gate: `scripts/audit/tier-dispatch-table-drift.mjs`
parses both and compares cell-by-cell.

---

## In-flight escalation

Two automatic upgrade triggers; no automatic downgrade.

- **Trigger A — execute-task scope growth.** When an execute-task
  dispatch reports `scope.files[]` grew past 5 files OR a path matched
  `references/sensitive-paths.md` entries not in the original probe
  output, `execute-task` writes `staging/.tier-upgrade-requested` with
  the reason. Next `detect-phase` cycle rewrites
  `CONFIG.tier=standard` (or `full` if growth was severe), records the
  upgrade in `DELEGATION_TRACE.md`, and proceeds. The already-completed
  `TASK_01` becomes the first of N.
- **Trigger B — code-review high-finding burst.** When
  `review/CODE_REVIEW.md.frontmatter.severityCounts.high >= 3` in
  `tier=express`, `receiving-code-review` HALTs with message
  `tier=express insufficient for fix-load; operator must --retier standard`.
  Operator decides.

Downgrades are operator-explicit (`--tier=express` or `--retier`) only.
The rationale: silent quality reduction is a worse failure mode than
the cost of running too thorough.

---

## Zero-config / resume behaviour

- Features whose `CONFIG.md` omits a `tier` field (e.g. features that
  landed on the subfolder layout but pre-date the probe) default to
  `tier=full` to preserve current behaviour.
- Re-invoking the orchestrator on a feat with a populated `CONFIG.tier`
  honours the persisted value; the probe is **not** re-run unless the
  operator passes `--retier`.
- Mid-workflow direct-skill invocations (e.g. `/execute-task <feat>`)
  read `CONFIG.tier` themselves; no `--tier=` flag is threaded through
  the dispatch surface.
