---
name: execute-task
description: "Implement N tasks end-to-end by resolving an execution strategy and fanning out to domain-specialist subagents per each task's `task.explorer.skillsFound[]`. Specialists load project skills, write code scoped to `task.scope`, report gates + invariants, and report back. execute-task aggregates each result into `task.execution.agents[]` and flips each task to COMPLETED. Tests are NOT authored at this phase — `write-tests` runs after `code-review` + `receiving-code-review` close findings. Triggers: execute TASK_03, run the first task, implement task 02, ship TASK_N, run all tasks, build the feature from the plan."
argument-hint: "feat dir: <path>; taskIds: [TASK_NN, ...]"
mutates:
  - path: steps[].task.execution
    requires: [gates]
  - path: config.executionStrategy
    requires: [setAt]
---

# execute-task — sub-orchestrator for the TASK execution phase

Phase 3 of the workflow. Receives an array of task IDs from the orchestrator, resolves an execution strategy, dispatches domain-specialist subagents per task, and aggregates each result into `workflow.json`.

You are the **orchestrator** of the execution phase. Specialists implement; you read, plan, dispatch, validate. Your only writes are trivial integration glue (<15 lines: barrel export, one-line import, config key) on the explicit `task.trivial == true` fast path.

`workflow.json` is the canonical state. Specialists do NOT read `workflow.json` — each receives a slice extracted to `/tmp/<feat>/.task-<NN>.json` so the main thread isn't replicated and parallel agents don't fight over reads.

This skill runs in the **main session context** (invoked via `Skill`, never via `Agent` dispatch). The reason: it must dispatch sub-Agents to specialists, and sub-Agents nested inside an `Agent` call are unreliable across harness configurations. Running in main keeps the fan-out reliable. Token economy is preserved by ensuring every specialist returns a one-line cursor — see §Phase 3 below.

## References router

| Reference | Load when |
|-----------|-----------|
| `../orchestrate-task-delivery/references/pipeline-phases.md` | **Load FIRST** before any `browzer workflow *` invocation — copy-paste cheat-sheet for every workflow verb. |
| `references/dispatch-pattern.md` | Per-domain dispatch template (Phase 3 fan-out), trivial inline path, isolation rules. |
| `references/parallel-dispatch.md` | `parallel` and `parallel-worktrees` strategies — N `Agent(...)` calls in one turn, file-overlap pre-check, worktree rendezvous protocol with checkpoint signatures. |
| `references/subagent-preamble.md` | Paste Step 0–5 verbatim into every dispatched specialist's prompt. Includes the "specialists read only their slice — do NOT touch workflow.json" rule. |
| `references/workflow-schema.md` | Authoritative schema mirror for jq filters against `workflow.json`. |

## Phase 0 — Resolve input

The skill is invoked with one of:

1. `feat dir: <path>; taskIds: [TASK_01, TASK_02, ...]` — the canonical shape from the orchestrator.
2. `feat dir: <path>` alone — fall back to "all incomplete TASK steps in tasksManifest.tasksOrder".
3. `TASK_N` or plain task number, no path — look up `FEAT_DIR` from chat context or `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -3` and ask. Use the single-task array `[TASK_N]`.
4. Free-form description without a workflow — call `generate-task` first, then re-enter with the array of newly-written task IDs.

Bind shell variables:

```bash
WORKFLOW="$FEAT_DIR/workflow.json"
TASK_IDS=( ... )
mkdir -p "/tmp/$(basename "$FEAT_DIR")"
SLICE_DIR="/tmp/$(basename "$FEAT_DIR")"
```

`TASK_IDS` is the array parsed from the invocation args (or, in the fall-back case, the list of incomplete TASK steps from `tasksManifest.tasksOrder`).

For each task ID, fetch the step ID and the slice payload:

```bash
for tid in "${TASK_IDS[@]}"; do
  STEP_ID=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" \
    | jq -r --arg t "$tid" '.TASK[]? | select(.taskId==$t) | .stepId')
  browzer workflow get-step "$STEP_ID" --field task \
    --save "$SLICE_DIR/.task-$tid.json" --quiet --workflow "$WORKFLOW"
done
```

The `.task-<TID>.json` slice is the ONLY context each specialist receives. It carries `scope`, `explorer.skillsFound[]`, `explorer.domains[]`, `explorer.depsGraph`, `invariants[]`, `acceptanceCriteria[]`, `suggestedModel`, `dependsOn[]`, `trivial` — everything `generate-task` discovered.

## Phase 1 — Resolve `config.executionStrategy`

Resolve once per workflow and persist via `browzer workflow set-config`. The strategy gates Phase 3 dispatch shape.

### 1.1 Capability probe

`agent-teams` requires both an operator opt-in flag AND the harness exposing the team-tools. Probe both BEFORE the resolution rule:

```bash
TEAMS_FLAG=$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' ~/.claude/settings.json 2>/dev/null)
TEAMS_TOOLS_AVAILABLE=$(ToolSearch '{"query":"select:TeamCreate,SendMessage","max_results":2}' 2>/dev/null | jq 'length >= 2' 2>/dev/null || echo false)

if [ "$TEAMS_FLAG" = "1" ] && [ "$TEAMS_TOOLS_AVAILABLE" = "true" ]; then
  TEAMS_OK=yes
else
  TEAMS_OK=no
fi
```

When `TEAMS_OK=no`, `agent-teams` is REMOVED from the candidate set. The operator never sees it as an option (in `review` mode) and the heuristic never picks it (in `autonomous` mode).

### 1.2 Resolution order

1. **Inherited** — if `browzer workflow get-config executionStrategy --workflow "$WORKFLOW"` returns non-empty, keep it.
2. **`autonomous` mode** — pick via heuristic (§1.3 below); persist silently.
3. **`review` mode** — fire `AskUserQuestion` listing the viable options:

   ```
   Question header: "Execution"
   How should TASK steps execute?
     (a) serial               — one task at a time, no isolation
     (b) parallel             — N agents in one turn, shared working tree (requires zero file overlap)
     (c) parallel-worktrees   — N agents in one turn, each in its own git worktree
     [(d) agent-teams         — Claude Code Agent Teams round-table dialogue]   ← only when TEAMS_OK=yes
   ```

Persist:

```bash
browzer workflow set-config --await executionStrategy "$STRATEGY" --workflow "$WORKFLOW"
```

### 1.3 Autonomous-mode heuristic

| Condition | Strategy |
|-----------|----------|
| `len(TASK_IDS) == 1` | `serial` |
| `len(TASK_IDS) >= 2` AND zero file overlap across all `task.scope[]` | `parallel` |
| `len(TASK_IDS) >= 2` AND any file overlap | `parallel-worktrees` |
| `len(TASK_IDS) >= 2` AND ≥ 3 distinct `task.explorer.domains[]` roots AND `TEAMS_OK=yes` | `agent-teams` |
| `len(TASK_IDS) >= 2` AND ≥ 3 distinct domain roots AND `TEAMS_OK=no` | `parallel-worktrees` |

File overlap: union the `task.scope[]` arrays across the selected tasks; if any path appears in two arrays, overlap is non-zero. The check is path-equality, not directory-prefix — adjacent files in the same dir are not "overlap".

## Phase 2 — Mark each TASK as RUNNING

Flip each selected TASK step to `RUNNING` BEFORE dispatch:

```bash
for tid in "${TASK_IDS[@]}"; do
  STEP_ID=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" \
    | jq -r --arg t "$tid" '.TASK[]? | select(.taskId==$t) | .stepId')
  browzer workflow set-status --await "$STEP_ID" RUNNING --workflow "$WORKFLOW"
done
```

State to operator: `**Executing <N> tasks: <TASK_IDS>.** Strategy: <STRATEGY>.`

## Phase 3 — Dispatch by strategy

Each branch loads the relevant reference and runs the dispatch loop. After dispatch, every specialist returns a one-line cursor:

```
<task-id>: status=<COMPLETED|FAILED>; agentRole=<role>; files=<created>/<modified>
```

No prose, no diff dumps, no specialist transcripts. The full per-task evidence lives in the specialist-written `task.execution.agents[]` entry inside `workflow.json`.

### Cursor regex enforcement (mandatory)

Apply the regex `^TASK_\d+: status=(COMPLETED|FAILED); agentRole=[a-z][a-z0-9-]*-specialist; files=\d+/\d+$` to the LAST non-empty line of the specialist's return. Strip any leading prose before applying — a return that contains a prose preamble followed by a cursor that matches the regex on its final line is acceptable, but the cursor itself MUST match exactly.

If no line matches:

1. Record the offending agent record under `task.execution.agents[]` with `status: REJECTED_CURSOR_MALFORMED` and the raw return string truncated to 200 chars in `notes`.
2. Re-dispatch the same specialist ONCE with the corrective instruction appended to the prompt:
   `Your previous return violated the cursor contract: <offending-line>. Return ONLY the cursor line, exactly matching ^TASK_\d+: status=(COMPLETED|FAILED); agentRole=[a-z][a-z0-9-]*-specialist; files=\d+/\d+$, nothing before or after.`
3. If the second attempt also fails the regex, flip the task to STOPPED with hint `cursor-malformed twice — manual recovery: read task.execution.agents[N].notes and decide`.

The regex is also the contract for `references/dispatch-pattern.md §Cursor regex` and `references/specialist-prompt-template.md §RETURN`.

### Cursor count cross-check (TE2-T3.2 enforcement)

After the regex passes, parse `files=<C>/<M>` and cross-check the integers against the structured ledger the specialist persisted in its `task.execution.agents[<i>]` entry:

```bash
# Pseudocode the orchestrator runs after each dispatch returns:
match='^TASK_\d+: status=(COMPLETED|FAILED); agentRole=[a-z][a-z0-9-]*-specialist; files=([0-9]+)/([0-9]+)$'
[[ $cursor =~ $match ]] || { /* REJECTED_CURSOR_MALFORMED ladder above */ }
# Portable parse (avoids BASH_REMATCH numeric indexing — zsh arrays are 1-based,
# bash arrays are 0-based, so the same numeric index yields different captures).
files_part=${cursor##*files=}
cursor_C=${files_part%%/*}
cursor_M=${files_part##*/}

browzer workflow get-step "$STEP_ID" \
  --field 'task.execution.agents[-1].filesCreated' \
  --json --save /tmp/agent-fc.json --quiet
browzer workflow get-step "$STEP_ID" \
  --field 'task.execution.agents[-1].filesModified' \
  --json --save /tmp/agent-fm.json --quiet
ledger_C=$(jq 'length' /tmp/agent-fc.json)
ledger_M=$(jq 'length' /tmp/agent-fm.json)

[[ "$cursor_C" == "$ledger_C" && "$cursor_M" == "$ledger_M" ]] || { /* count-mismatch ladder below */ }
```

On mismatch (`cursor.files=2/3` but `len(filesCreated)=1` and/or `len(filesModified)=4`):

1. Patch the agent record to `status: REJECTED_FILES_COUNT_MISMATCH` with `notes` set to `cursor=<C>/<M>; ledger=<ledgerC>/<ledgerM>` so the audit trail records both shapes verbatim.
2. Re-dispatch the same specialist ONCE with the corrective instruction:
   `Your previous return claimed files=<C>/<M> but task.execution.agents[<i>].filesCreated has length <ledgerC> and filesModified has length <ledgerM>. Re-emit the cursor with counts that match your ledger arrays exactly. The arrays are first-class — the cursor counts are derived from them, not the other way around.`
3. If the second attempt also fails, flip the task to STOPPED with hint `files-count-mismatch twice — manual recovery: reconcile cursor vs task.execution.agents[<i>].{filesCreated,filesModified}`.

The contract is symmetric: the orchestrator never recomputes the counts on its own. The cursor is the specialist's terse signal; the structured arrays are the canonical source of paths. They MUST agree, and the orchestrator's job is to surface drift, not paper over it.

### 3.1 `serial`

For each task in order: dispatch one or more domain specialists, wait for each task to flip to COMPLETED, proceed to the next. See `references/dispatch-pattern.md` for the per-domain dispatch template + isolation rules.

### 3.2 `parallel`

All tasks run in one response turn — multiple `Agent(...)` calls in the same message, NO worktree isolation. Pre-requisite: file-overlap pre-check returned zero (every task touches a disjoint set of files). See `references/parallel-dispatch.md §parallel`.

If the pre-check fails at this point (e.g. operator picked `parallel` in review mode despite overlap), STOP with hint: `parallel strategy requires zero file overlap; fall back to parallel-worktrees`. Do NOT silently switch strategies — the operator picked it for a reason; surface the conflict.

### 3.3 `parallel-worktrees`

All tasks run in one response turn, each `Agent(...)` call carries `isolation: "worktree"`. Each agent works in its own git worktree; the rendezvous protocol (4 steps: spawn → per-agent checkpoint → merge → cleanup) is in `references/parallel-dispatch.md §parallel-worktrees`.

**Checkpoint signature is mandatory.** Each specialist's return cursor MUST include a checkpoint hash that execute-task verifies before merging. A specialist that returns without a valid checkpoint flips its task to STOPPED with hint `worktree rendezvous broken — manual recovery: <recovery cmd>`. This is the safety layer against "agent returned but its work didn't make it back to the main worktree".

### 3.4 `agent-teams`

Domain-bound parallel team via `TeamCreate` + a shared `TaskList` + N specialists (one per domain root). Each specialist owns the slice of TASK_IDs scoped to its domain. See `references/dispatch-pattern.md §team-mode` for the team coordination logic.

Each team specialist still writes its results into the relevant TASK's `task.execution.agents[]` array — no separate `task.teamExecution.*` payload. The team is the dispatch mechanism, not a parallel data shape.

## Phase 4 — Aggregate and complete each TASK

After all dispatches return, for each task ID:

1. Verify the specialist(s) wrote their entries to `task.execution.agents[]` (read via `browzer workflow get-step <STEP_ID> --field task.execution.agents`).
2. Validate gates per `task.execution.gates` (lint, typecheck, scoped tests if any). If a gate failed, flip to STOPPED with the failure recorded.
3. Validate the regression-diff contract: any step that captured `task.execution.gates.baseline` MUST have populated `task.execution.gates.regression`. Use the helper:

   ```bash
   source scripts/jq-helpers.sh
   validate_regression "$STEP_ID" || {
     browzer workflow set-status --await "$STEP_ID" STOPPED --workflow "$WORKFLOW"
     browzer workflow patch --workflow "$WORKFLOW" \
       --arg "id=$STEP_ID" \
       --jq '(.steps[] | select(.stepId==$id)).stopReason = "regression-diff-contract-failed"'
     continue
   }
   ```

4. Flip the TASK to COMPLETED:

   ```bash
   browzer workflow complete-step --await "$STEP_ID" --workflow "$WORKFLOW"
   ```

## Phase 5 — Return one-line cursor to the orchestrator

```
execute-task: stepId=<last completed STEP_ID or aggregator-virtual-id>; status=<COMPLETED|FAILED>; executedTaskIds=[<list>]; failedTaskIds=[<list>]
```

`failedTaskIds` non-empty does NOT prevent the orchestrator from proceeding to Phase 4 (CODE_REVIEW) — even partial diffs are reviewable. The orchestrator decides how to interpret the failure list.

## Banned dispatch-prompt patterns

- Specialist prompts that read `$WORKFLOW` directly (`Read $WORKFLOW`, `cat workflow.json`, `jq . "$WORKFLOW"`). Specialists ONLY consume their slice at `$SLICE_DIR/.task-<TID>.json`.
- Specialist prompts that call `browzer workflow query` or `get-step` to fetch other tasks' context — the slice already carries `dependsOn` resolutions if needed.
- Subagents tables, files lists, "skills loaded", "invariants enforced" in chat output.
- Baseline-vs-post-change comparison tables printed to chat — those go into `task.execution`.
- Announcing N parallel agents without emitting N literal `Agent(...)` calls in the same message.
- Editing an application file directly (unless `task.trivial == true` and the inline path applies per `references/dispatch-pattern.md`).

## Phase 6 — Hand-off

You do NOT invoke `code-review`, `update-docs`, `feature-acceptance`, or `commit`. The orchestrator schedules those phases after this skill returns its cursor.

## Orchestrator anti-patterns (self-check before every message)

- [ ] About to edit an application file? → **Stop, dispatch a subagent** (unless trivial inline path applies).
- [ ] Announced N parallel agents? → Count `Agent()` calls in this message. Must equal N.
- [ ] Parallel agents touching overlapping files? → Either upgrade to `parallel-worktrees` OR refuse to dispatch.
- [ ] Gate failed? → **Dispatch fix agent OR flip to STOPPED**, don't fix inline.
- [ ] About to guess library/config shape? → Run `browzer search` first, then external docs lookup if needed.
- [ ] Editing CLAUDE.md / README.md / AGENTS.md? → **Stop. That's `update-docs`'s job.**
- [ ] About to `Read` or `Write` `workflow.json` directly? → **Stop.** Use `browzer workflow *` only.
- [ ] About to read another task's slice while dispatching task X? → **Stop.** Each specialist receives only its own slice.

## Non-negotiables

- **Output language: English.** `task.execution` fields and the one-line cursor are English.
- No application code by execute-task itself (except ≤15-line integration glue on the trivial fast path).
- No silent skips of baseline capture or post-change verification.
- No inline fixes of failed gates.
- No parallel edits of the same file without isolation (`parallel-worktrees`) OR a verified zero-overlap pre-check (`parallel`).
- No re-citation of specialist transcripts in the cursor.
- No invention of payload fields not in the CUE SSOT — every write goes through `task.execution.agents[]` and the `#TaskAgent` shape.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands.

## Invocation modes

- **Via `orchestrate-task-delivery` Phase 3** — receives `taskIds: [...]` array; the orchestrator chains code-review afterwards.
- **Standalone** — `/execute-task TASK_03` or "implement TASK_01,TASK_02". The skill executes the named tasks and returns; downstream phases (code-review, etc.) require manual invocation OR a fresh orchestrator entry.
