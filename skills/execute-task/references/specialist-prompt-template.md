# Specialist dispatch prompt — template

The verbatim prompt body for every domain-specialist `Agent(...)` call dispatched by `execute-task`. Substitute the placeholders before calling — every placeholder is mandatory unless explicitly marked optional.

This template is the SSOT for three contracts:

- **PHASE 0 (skill load)** — closes the empty-`skillsLoaded[]` failure class. The aggregator REJECTS any agent record that returns an empty array unless the dispatched `skillsFound[]` was also empty.
- **PHASE 1 (receipts-first reads)** — closes the duplicate-exploration failure class. The specialist consults cached receipts in `$RECEIPTS_DIR` BEFORE running any `browzer explore`/`Read`/`Grep` of its own.
- **RETURN** — closes the cursor-drift failure class. The cursor MUST match the regex pinned in `SKILL.md §Cursor regex enforcement`. Any prose before or after the cursor line gets the dispatch flagged and re-issued.

## Placeholders

| Placeholder | Source | Example |
|---|---|---|
| `$TASK_ID` | The task step's id | `TASK_03` |
| `$STEP_ID` | The workflow step id (often equal to `$TASK_ID`) | `TASK_03` |
| `$DOMAIN` | One entry from `task.explorer.domains[]` | `fastify-backend` |
| `$RECEIPTS_DIR` | Per-feature receipts dir resolved by orchestrator | `/tmp/orch-receipts/feat-<slug>/` |
| `$SCOPE_FILES` | Newline-separated paths from `task.scope[]` for this domain | `src/routes/foo.ts\nsrc/services/bar.ts` |
| `$GATE_CMDS` | Lint + typecheck command(s) scoped to the owning package | `<package-manager> --filter <package-name> lint typecheck` (or whatever the host repo's gate command is) |
| `$SKILLS_TO_LOAD` | Skill paths from `task.explorer.skillsFound[].skill` for this domain, ordered high → med → low | `fastify-best-practices, nodejs-backend-patterns` |
| `$FEAT_ID` | The feature id (used to locate `workflow.json` and feat dir) | `feat-<date>-<slug>` |

If `$SKILLS_TO_LOAD` is empty (Explorer found no domain skills for this slice), pass the literal string `(none)` and the PHASE 0 audit will accept the empty `skillsLoaded[]` array on return.

## Verbatim prompt body

```
You are a $DOMAIN-specialist working on $TASK_ID. Your output budget is finite — return the cursor line specified at the bottom of this prompt and nothing else.

Receipts already cached for this feature live at $RECEIPTS_DIR. Treat them as authoritative for any symbol/path question your scope raises.

PHASE 0 (BLOCKING — skill load)

For each skill listed below, invoke it via Skill(<name>) BEFORE reading any source file or writing any code. This is non-negotiable. If you skip PHASE 0 the aggregator will REJECT your agent record on return and re-dispatch with a corrective prompt.

  $SKILLS_TO_LOAD

Record every skill you actually invoked in your task.execution.agents[].skillsLoaded[] entry. The aggregator audits this against the dispatched list and surfaces a contract violation when the set is empty despite a non-empty dispatch list. The only legitimate empty-skillsLoaded[] case is "(none)" above.

PHASE 1 (receipts-first reads)

BEFORE any Read, Grep, or browzer explore call:

  ls $RECEIPTS_DIR/

For every cached receipt, jq the keys you care about (symbol, path, importedBy, exports). Only if the symbol or path your scope needs is NOT covered by a cached receipt may you invoke a fresh `browzer explore` / `search` / `deps` — and that fresh call MUST use `--save $RECEIPTS_DIR/<basename>.json --quiet` so the next specialist inherits the work.

Then Read your scope files:

  $SCOPE_FILES

PHASE 2 (implement)

Implement the task's spec. The spec lives at /tmp/$FEAT_ID/.task-$TASK_ID.json (jq it; do not request the orchestrator re-paste it). Touch ONLY the scope files listed above. Do NOT author tests, run the test suite, or run mutation testing — those concerns belong to `write-tests`, which runs after `receiving-code-review` closes findings.

PHASE 3 (gates)

Run the gate commands:

  $GATE_CMDS

All must pass. Failures are reported in the cursor with status=FAILED.

PHASE 4 (record)

Update .task.execution.agents[] via:

  browzer workflow patch --workflow /tmp/$FEAT_ID/workflow.json --quiet \
    --argjson "agent=<your record JSON>" \
    --jq '.steps[] | select(.id == "$STEP_ID") | .task.execution.agents += [$agent]'

Your agent record MUST include: role ("$DOMAIN-specialist"), model, status, startedAt, completedAt, skillsLoaded[] (every Skill() invoked in PHASE 0), filesCreated[] (paths of files you newly added), filesModified[] (paths of files you edited but did not create), and notes (one sentence on what you did). The `filesCreated[]` + `filesModified[]` arrays are first-class fields on `#TaskAgent` (TE2-T3.2) — populate them with absolute or repo-relative paths, NOT counts. The cursor's `files=<n>/<m>` line below carries the integer COUNTS for the orchestrator's quick scan; the orchestrator derives them from the arrays during aggregation.

RETURN

The LAST non-empty line of your output MUST be the cursor below. Anything before or after the cursor line gets the dispatch flagged and re-issued — return the cursor line alone, no prose framing, no diff dump, no transcript.

  $TASK_ID: status=<COMPLETED|FAILED>; agentRole=$DOMAIN-specialist; files=<created>/<modified>

`<created>` is the count of newly-added files, `<modified>` is the count of files you edited but did not create. Both are integers. The orchestrator cross-checks these counts against `len(filesCreated)` / `len(filesModified)` on your agent record — a mismatch flags the dispatch for re-issuance.
```

## Why each PHASE exists (failure classes closed)

- **PHASE 0** closes the case where specialists ignore the dispatched `skillsFound[]` and operate from generic training-data memory rather than project conventions. Empirically, dispatches that skipped Skill() loads produced sub-optimal code that downstream `code-review` flagged at multi-roundtrip cost.
- **PHASE 1** closes the case where specialists re-run `browzer explore` / `Read` / `Grep` over symbols the orchestrator already cached, doubling exploration cost and polluting the agent's natural-language output budget with rediscovered context.
- **RETURN** (cursor regex) closes the case where specialists added prose preambles or invented their own `files=` count. The aggregator parses the cursor mechanically; any deviation is rejected.

## Aggregator audit step (executed by execute-task after dispatch returns)

For each returned agent record:

1. Apply the cursor regex from `SKILL.md §Cursor regex enforcement`. On failure → re-dispatch (one retry) with the corrective instruction; second failure → STOP the task.
2. **Cross-check cursor counts against the structured ledger** (TE2-T3.2). Parse `files=<C>/<M>` from the cursor and assert `C == len(filesCreated)` AND `M == len(filesModified)` on the returned `task.execution.agents[<i>]` entry. On mismatch → mark the record `status: REJECTED_FILES_COUNT_MISMATCH` with `notes=cursor=<C>/<M>; ledger=<ledgerC>/<ledgerM>` and re-dispatch ONCE per the ladder in `SKILL.md §Cursor count cross-check`; second failure → STOP. The structured arrays are canonical — the cursor count is derived FROM them, never overrides them.
3. If `skillsFound[]` (from `task.explorer`) is non-empty AND the returned `skillsLoaded[]` is empty AND the role is NOT `inline-glue`, mark the record `status: REJECTED_SKILLS_NOT_LOADED` and re-dispatch ONCE with the corrective instruction `PHASE 0 was skipped; load $SKILLS_TO_LOAD before returning.`. Second failure → STOP.
4. Otherwise, accept the record and append to `task.execution.agents[]`.
