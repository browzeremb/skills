# State machine — canonical phase transitions

The orchestrator is **filesystem-driven**: it inspects what is present in
`docs/browzer/<feat>/`, derives the current state, and dispatches the
next skill. This file is the source-of-truth transition table.

---

## Transition table

Each row is `(detected state) → (next action)`. Rows are evaluated **in
order** — first match wins. `detect-phase.mjs` implements this verbatim.

| # | Detected state | Next action | Args passed |
|---|---|---|---|
| 1 | `docs/browzer/<feat>/` does NOT exist | create dir + write `CONFIG.md` + dispatch `brainstorming` OR jump to `generate-prd` per heuristic | `<feat>` |
| 2 | `CONFIG.md` exists, `BRIEF.md` missing, `PRD.md` missing AND heuristic says brainstorming needed | `brainstorming` | `<feat>` |
| 3 | `PRD.md` missing AND `BRIEF.md` exists OR heuristic skip | `generate-prd` | `<feat>` |
| 4 | `PRD.md` exists, `EXPLORATION.md` missing | `scope-feature` | `<feat>` |
| 5 | `EXPLORATION.md` exists, NO `TASK_*.md` AND NO `TASK_*.completed.md` | `generate-task` | `<feat>` |
| 6 | Any `TASK_*.failed.md` exists | **HALT** + nudge "re-run /execute-task on listed failures" | — |
| 7 | At least one `TASK_*.md` exists without a sibling `.completed.md` | `execute-task` | `<feat>` |
| 8 | All TASKs have `.completed.md`, `CODE_REVIEW.md` missing | `code-review` | `<feat>` |
| 9 | `CODE_REVIEW.md` exists, `frontmatter.totalFindings == 0`, `TESTS.md` missing | `write-tests` (skip receiving-code-review entirely) | `<feat>` |
| 10 | `CODE_REVIEW.md` exists with findings, `RECEIVING_CODE_REVIEW.md` missing | `receiving-code-review` | `<feat>` |
| 11 | Any `FIX_F-*.tech_debt.md` exists with `severity: high` AND no `.browzer/accepted-tech-debt.json` override | **HALT** + nudge "operator must triage high-severity tech-debt" | — |
| 12 | `RECEIVING_CODE_REVIEW.md` exists, `TESTS.md` missing | `write-tests` | `<feat>` |
| 13 | `TESTS.md` exists, `DOC_PATCHES.md` missing | `update-docs` | `<feat>` |
| 14 | `DOC_PATCHES.md` exists, `ACCEPTANCE.md` missing | `feature-acceptance` | `<feat> <mode>` (mode from `CONFIG.md.acceptanceMode`, default `hybrid`) |
| 15 | `ACCEPTANCE.md.frontmatter.verdict == rejected` | **HALT** + nudge "operator must triage rejected verdict" | — |
| 16 | `ACCEPTANCE.md.verdict == accepted`, `README.md` missing | `finalize-feature` | `<feat>` |
| 17 | `README.md` exists, `git diff --quiet docs/browzer/<feat>/` returns non-zero (uncommitted changes) | `commit` | `<feat>` |
| 18 | Everything consistent + git clean for `docs/browzer/<feat>/` | **DONE** — print summary | — |

---

## Cycle guard

`detect-phase.mjs` reads the last `MAX_REPEAT = 3` entries from
`DELEGATION_TRACE.md` (when present). If the same `(detected-state →
next-action)` transition has fired 3 times consecutively, halt with:

> orchestrator: cycle detected — `<from-state>` → `<next-phase>` has fired 3 times. Operator must inspect the feat folder and unblock manually.

This prevents infinite loops when a skill returns success but the next
phase's preconditions remain unsatisfied.

---

## Initialization (row #1)

When `docs/browzer/<feat>/` does not exist, the orchestrator:

1. Validates `<feat>` matches `^feat-\d{8}-[a-z0-9-]+$` (or derives from operator-supplied slug + today's date).
2. Creates `docs/browzer/<feat>/`.
3. Writes `CONFIG.md` with:
   ```yaml
   ---
   featureId: <feat>
   executionStrategy: <serial | parallel | parallel-worktrees | agent-teams>
   acceptanceMode: <autonomous | autonomous-with-stack-boot | hybrid | manual>
   createdAt: <RFC3339>
   ---
   ```
   `executionStrategy` defaults to `serial` when not passed as arg.
   `acceptanceMode` defaults to `hybrid`.
4. Decides brainstorming vs direct-PRD via the heuristic in
   `intent-detection.md §brainstorming gate`.

---

## DONE state (row #18)

When the state machine reaches "everything consistent + git clean", the
orchestrator prints:

```
orchestrate-task-delivery: DONE for <feat>
  verdict: <ACCEPTANCE.md.verdict>
  tasks: <count>
  fixes: <count fixed> / <count tech-debt>
  tests: <count tests added, kill rate %>
  docs:  <count patched>
  commit sha: <full sha>
```

No further dispatch.

---

## HALT states (rows #6, #11, #15)

HALT means the operator must act before the orchestrator can advance.
The orchestrator prints the halt message AND exits successfully — it
does NOT loop indefinitely waiting. Operator re-invokes
`/orchestrate-task-delivery <feat>` after fixing the underlying issue;
the state machine picks up from the current filesystem state.

This is by design: orchestrator is stateless beyond the feat folder.

---

## Mid-workflow entry

Operator typing `/execute-task <feat> TASK_03` or `/update-docs <feat>`
DIRECTLY invokes the named skill — the orchestrator's state machine
does NOT need to be involved. Skills are standalone-invocable by the
markdown-chains contract. When the operator finishes the direct
invocation, they may resume the orchestrator: it re-detects state and
continues from the new file presence.

Use `intent-detection.md §mid-workflow entry` to determine when a
prompt is direct-skill vs orchestrator-resume.
