# State machine — canonical phase transitions

The orchestrator is **filesystem-driven**: it inspects what is present
in `docs/browzer/<feat>/staging/` (and the feat root for `README.md`),
derives the current state, consults `CONFIG.tier` for tier-specific
routing, and dispatches the next skill. This file is the source-of-truth
transition table.

The chain is **tier-aware**: `detect-phase.mjs` calls `applyTier()` to
consult the canonical `references/tier-dispatch-table.md` for each row.
The result is one of:

- `dispatch` — orchestrator invokes the named skill / subagent.
- `skip` — state machine advances the pointer (recurses to the next
  row) without writing any artefact.
- `inline-<artefact>` — orchestrator writes the artefact directly,
  satisfying the closure principle for the downstream skill.

---

## Transition table (post-tier-dispatch refactor)

Each row is `(detected state) → (next action, args)`. Rows are evaluated
**in order** — first match wins. `detect-phase.mjs` implements this
verbatim; cross-validated against `tier-dispatch-table.md` by
`scripts/audit/tier-dispatch-table-drift.mjs`.

`tier` below refers to `staging/CONFIG.md.tier`. When the file is
present but `tier` is unset, `applyTier()` defaults to `full` (preserves
behaviour for feats that landed on the subfolder layout but pre-date the
probe).

| # | Detected state | applyTier → action | Args passed |
|---|---|---|---|
| 1 | `docs/browzer/<feat>/` does NOT exist OR `staging/` subfolder missing | `INIT` (orchestrator inline) | `<feat>` — creates folder, six subfolders, `.gitignore`, `CONFIG.md` |
| 1.5 | `staging/CONFIG.md` present, `CONFIG.tier` unset, no operator override | `PROBE-TIER` (orchestrator inline; `Skill(orchestrate-task-delivery)` runs `scripts/probe-tier.mjs`) | `<feat>` |
| 2 | `planning/PRD.md` missing AND `planning/BRIEF.md` missing AND intent-detection heuristic says brainstorm | `dispatch(brainstorming)` (`skip` if tier=express AND probe.briefClarity = all-3-present) | `<feat>` |
| 3 | `planning/PRD.md` missing AND (`planning/BRIEF.md` exists OR heuristic skip) | tier=express → `INLINE-PRD-IN-BRIEF`; tier=standard/full → `dispatch(generate-prd)` | `<feat>` |
| 4 | `planning/PRD.md` exists (or tier=express short-circuit), `planning/EXPLORATION.md` missing | tier=express → `skip` (orchestrator runs `browzer deps --reverse` + find-skills inline); tier=standard/full → `dispatch(scope-feature)` | `<feat>` |
| 5 | (`planning/EXPLORATION.md` present OR tier=express skip), no `tasks/TASK_*.md` AND no `tasks/TASK_*.completed.md` | tier=express → `INLINE-TASK_01`; tier=standard/full → `dispatch(generate-task)` | `<feat>` |
| 6 | Any `tasks/TASK_*.failed.md` exists | **HALT** + nudge "re-run /execute-task on listed failures" | — |
| 7 | At least one `tasks/TASK_*.md` exists without a sibling `.completed.md` | `dispatch(execute-task)` | `<feat>` |
| 8 | All TASKs have `.completed.md`, `review/CODE_REVIEW.md` missing | `dispatch(code-review)` | `<feat>` |
| 9 | `review/CODE_REVIEW.md` present, `frontmatter.findings[]` empty, no `acceptance/ACCEPTANCE.md`, no `fixes/` content | `dispatch(feature-acceptance)` — skip receiving-code-review AND regression-guard | `<feat> <mode>` (mode from `CONFIG.acceptanceMode` ∪ tier table) |
| 10 | `review/CODE_REVIEW.md` present with findings, no `fixes/FIXES.md` | `dispatch(receiving-code-review)` | `<feat>` |
| 11 | Any `fixes/F-*.tech_debt.md` exists with `severity: high` AND no `.browzer/accepted-tech-debt.json` override | **HALT** + nudge "operator must triage high-severity tech-debt" | — |
| 12 | `fixes/FIXES.md` present, no `review/GATE_REPORT.md` | `dispatch(regression-guard)` | `<feat>` |
| 12a | `staging/.regression-guard-rerun` sentinel present AND `CONFIG.regressionGuardRound < 3` | `dispatch(receiving-code-review)` — round 2/3 fixers on the new HIGH findings appended by regression-guard | `<feat>` |
| 12b | `review/GATE_REPORT.md.frontmatter.gateResults.*` has any `fail` AND `CONFIG.regressionGuardRound == 3` (and no `gateOverride`) | **HALT** + nudge "regression-guard: exceeded max rounds; operator must inspect or pass `--override-gate`" | — |
| 13 | `review/GATE_REPORT.md` present, all `gateResults.*` are `pass` (or `gateOverride` accepted), no `acceptance/ACCEPTANCE.md` | `dispatch(feature-acceptance)` | `<feat> <mode>` |
| 14 | `acceptance/ACCEPTANCE.md.frontmatter.verdict == rejected` | **HALT** + nudge "operator must triage rejected verdict" | — |
| 15 | `acceptance/ACCEPTANCE.md.verdict == accepted`, `README.md` missing | `dispatch(finalize-feature)` (Phase A doc patching + Phase B README in one skill) | `<feat>` |
| 16 | `README.md` exists, `git diff --quiet docs/browzer/<feat>/` returns non-zero (uncommitted changes) | `dispatch(commit)` | `<feat>` |
| 17 | Everything consistent + git clean for `docs/browzer/<feat>/` | **DONE** — print summary | — |
| 18 | Post-commit recovery: `Feature: <featureId>` trailer present in `git log -- docs/browzer/<feat>/` (operator cleaned up the feat-root or removed README.md after commit) | **DONE-via-git-log** — print summary | — |

---

## `applyTier()` contract

```javascript
function nextPhase(stateFromFs, tier) {
  const table = parseTierDispatchTable();   // reads tier-dispatch-table.md
  const action = table[tier][stateFromFs.expectedPhase];
  switch (action.kind) {
    case 'dispatch': return { nextPhase: action.skill, args: [featureId, ...action.extra] };
    case 'skip':     return nextPhase(advancePointer(stateFromFs), tier);  // recurse
    case 'inline':   return { nextPhase: `INLINE-${action.artefact}`, args: [featureId] };
    case 'run':      return { nextPhase: action.skill, args: [featureId] };
  }
}
```

The recursion in the `skip` branch is bounded by the number of phases —
the state machine cannot loop on `skip` because each recursion advances
the filesystem-state pointer. The cycle guard (see below) is the final
safety net.

Trace entry for skipped phases:

```
2026-05-14T18:42:00Z orchestrator → tier=express → skip generate-prd (per tier-dispatch-table.md)
```

---

## Cycle guard

`detect-phase.mjs` reads the last `MAX_REPEAT = 3` entries from
`DELEGATION_TRACE.md` (when present). If the same `(detected-state →
next-action)` transition has fired 3 times consecutively, halt with:

> orchestrator: cycle detected — `<from-state>` → `<next-phase>` has fired 3 times. Operator must inspect the feat folder and unblock manually.

This prevents infinite loops when a skill returns success but the next
phase's preconditions remain unsatisfied.

---

## Initialization (rows #1, #1.5)

When `docs/browzer/<feat>/staging/` does not exist, the orchestrator:

1. Validates `<feat>` matches `^feat-\d{8}-[a-z0-9-]+$` (or derives
   from operator-supplied slug + today's date).
2. Creates `docs/browzer/<feat>/staging/` and the six per-phase
   subfolders: `planning/`, `tasks/`, `review/`, `review-lanes/`,
   `fixes/`, `acceptance/`.
3. Writes `staging/.gitignore` with `*\n!.gitignore\n`.
4. Writes `staging/CONFIG.md` with:
   ```yaml
   ---
   featureId: <feat>
   tier: null                # populated at Step 0.5 (probe-tier) or by --tier= flag
   executionStrategy: <serial | parallel | parallel-worktrees | agent-teams>
   acceptanceMode: <autonomous | autonomous-with-stack-boot | hybrid | manual | smoke>
   regressionGuardRound: 1
   createdAt: <RFC3339>
   ---
   ```
   `executionStrategy` defaults to `serial`. `acceptanceMode` defaults
   to the value implied by `tier` (`smoke` for express, `hybrid` for
   standard, `autonomous-with-stack-boot` for full).
5. Decides brainstorming vs direct-PRD via the heuristic in
   `intent-detection.md §brainstorming gate`.

After `INIT`, row #1.5 fires: `probe-tier.mjs` dispatches a haiku
sub-agent with the BRIEF and pre-computed `browzer deps --reverse` on
candidate files. The agent returns `{tier, rationale, candidateFiles[],
expectedAC[]}` which the script writes atomically into
`staging/CONFIG.md`. The probe is **skipped** when:

- Operator passed `--tier=X` at orchestrator entry (the flag forces the
  tier).
- `CONFIG.tier` is already populated (resume case).

`--retier` re-runs the probe regardless.

---

## INLINE writes (express tier)

Two inline-write states:

- `INLINE-PRD-IN-BRIEF` (row #3, tier=express): orchestrator appends a
  `## PRD-compact` heading to `planning/BRIEF.md` carrying:
  - `originalRequest` (verbatim operator ask)
  - `functionalRequirements` (verbatim from probe output)
  - `acceptanceCriteria` (verbatim from probe output)
  `feature-acceptance` reads this section directly when
  `CONFIG.tier == express`.

- `INLINE-TASK_01` (row #5, tier=express): orchestrator writes
  `tasks/TASK_01.md` directly, satisfying the closure principle for
  `execute-task`. The file carries the full TASK_NN.md template shape:
  - `featureId`
  - `taskId: T-01`
  - `acceptanceCriteria[]` verbatim from probe.expectedAC[]
  - `functionalRequirements[]` verbatim from probe
  - `scope.files[]` with `blastRadius` from `browzer deps --reverse`
  - `skillsFound[]` from `Skill(browzer:find-skills, programmatic)`
  - `testSpecs[]`
  - `prdSha: null` (no PRD in express)
  - `invariants[]` from the canonical preamble

The inline writes happen BEFORE the next `detect-phase` call. The
orchestrator does not need an `INLINE-*` exit — it writes the file and
loops back to `detect-phase`, which now sees the artefact and routes
forward normally.

---

## Regression-guard loop (rows #12, #12a, #12b)

After `receiving-code-review` aggregates fixes (`fixes/FIXES.md`
written), the state machine routes to `regression-guard` (row #12). The
skill body:

1. Invokes the host quality gate over the aggregate post-fix diff
   (lint + typecheck + test, plus build on full tier when public API
   drifted).
2. Writes `review/GATE_REPORT.md` with `gateResults: {lint, typecheck,
   test, build?}`.
3. If any gate command failed, appends synthetic HIGH findings to
   `review/CODE_REVIEW.md.frontmatter.findings[]` with `lane:
   regression-guard, round: <current>`, increments
   `CONFIG.regressionGuardRound`, and writes
   `staging/.regression-guard-rerun` sentinel.
4. Next `detect-phase` cycle sees the sentinel (row #12a), routes back
   to `receiving-code-review` for round 2 fixers. `receiving-code-review`
   deletes the sentinel on entry (idempotent — no error if absent) to
   prevent stale-sentinel reentry.
5. Round 3 with still-failing gate triggers row #12b: HALT with the
   verdict. Operator chooses `--override-gate` (recorded in
   `ACCEPTANCE.md.frontmatter.gateOverride`) or commits a manual fix
   and re-invokes.

**State-machine bypass** for empty fixes: when row #10 saw an empty
`findings[]` array and `receiving-code-review` was skipped (row #9), no
`fixes/` content exists. The per-task quality gates (under
`execute-task`) already validated the diff. Row #12 is bypassed
entirely; row #9's dispatch goes straight to `feature-acceptance`.

---

## DONE state (rows #17, #18)

When the state machine reaches "everything consistent + git clean", or
detects a `Feature: <featureId>` trailer in `git log -- docs/browzer/<feat>/`
(post-cleanup recovery — operator removed `README.md` after commit
landed), the orchestrator prints:

```
orchestrate-task-delivery: DONE for <feat>
  verdict: <ACCEPTANCE.md.verdict>
  tasks: <count>
  fixes: <count fixed> / <count tech-debt>
  tests: <count added across TASK_*.testsAdded[]>
  docs:  <count patched>
  commit sha: <full sha>
```

No further dispatch.

---

## HALT states (rows #6, #11, #12b, #14)

HALT means the operator must act before the orchestrator can advance.
The orchestrator prints the halt message AND exits successfully — it
does NOT loop indefinitely waiting. Operator re-invokes
`/orchestrate-task-delivery <feat>` after fixing the underlying issue;
the state machine picks up from the current filesystem state.

This is by design: orchestrator is stateless beyond the feat folder.

---

## Mid-workflow entry

Operator typing `/execute-task <feat> TASK_03` or `/finalize-feature <feat>`
DIRECTLY invokes the named skill — the orchestrator's state machine
does NOT need to be involved. Skills are standalone-invocable by the
markdown-chains contract; each dispatched skill reads `CONFIG.tier` from
`staging/CONFIG.md` itself as its first step. When the operator finishes
the direct invocation, they may resume the orchestrator: it re-detects
state and continues from the new file presence.

Use `intent-detection.md §mid-workflow entry` to determine when a
prompt is direct-skill vs orchestrator-resume.
