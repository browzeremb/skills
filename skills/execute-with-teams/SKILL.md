---
name: execute-with-teams
description: "Domain-bound parallel execution of Phase 3 (TASK_*) via a Claude Code agent team — TeamCreate + a shared TaskList + N specialists (one per domain root) running in parallel — instead of serial per-task execute-task dispatch. Use when a feature spans 2+ distinct domain roots (e.g. apps/api + apps/web + packages/cli) AND task scopes have zero file overlap between domains. Saves wall-clock via per-domain isolation (no merge conflicts on shared tree) and TaskList-driven coordination with blockedBy chains. Triggered from orchestrate-task-delivery Phase 3 when the operator picks `agent-teams` strategy; each specialist runs the execute-task contract internally for its scope."
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(jq *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(awk *), Read, AskUserQuestion, Agent
---

# execute-with-teams — domain-bound parallel team for Phase 3

You orchestrate a Claude Code agent team. You DO NOT implement code — your specialists do. Your job is **partition by domain → dispatch specialists in parallel → wait for completion via mailbox → aggregate results into workflow.json → shutdown the team**.

This skill is invoked by `orchestrate-task-delivery` Phase 3 when the operator chose `executionStrategy: agent-teams`. It replaces the serial-or-worktree-parallel per-task dispatch with a team-based parallel execution. Each specialist owns one domain and the slice of tasks scoped to it, loads the domain skills declared in each owned task's `task.explorer.skillsFound[]` (the same contract `execute-task` honors per-task), and ships its slice in parallel with siblings on a shared working tree.

The pattern: when N tasks span M ≥ 2 disjoint domain roots (e.g. backend service + frontend app + CLI package, or service A + service B + shared package), domain isolation guarantees no merge conflicts on the shared tree. Wall-clock for the initial-phase domains runs concurrently; cross-domain follow-ups (validators, codemods, glue code that consumes initial-phase artifacts) dispatch after their prerequisites land.

## References router

| Reference | When to load |
|-----------|-------------|
| [references/dispatch-strategy.md](references/dispatch-strategy.md) | Strategy resolution: `executionStrategy` decision table, single-domain fallback path, capability check (TeamCreate availability), degrade contract. Load during Phase 0.5 when determining whether to proceed or abort. |
| [references/team-coordination.md](references/team-coordination.md) | DAG construction (Step 4), blockedBy chains, follow-up dispatch patterns, failure modes, when to fall back from team mode. Load before Step 4 and when any specialist completes. |
| [references/specialist-prompt-template.md](references/specialist-prompt-template.md) | Domain specialist Agent dispatch (Step 6). Paste verbatim with placeholders filled. Load immediately before dispatching domain specialists. |
| [references/test-specialist-prompt-template.md](references/test-specialist-prompt-template.md) | Test-and-mutation specialist Agent dispatch (Step 6). Paste verbatim with placeholders filled. Load immediately before dispatching the test specialist. |

## Output contract

ONE confirmation line on success:

```
execute-with-teams: <featureId> shipped <T> tasks across <D> domains via team <team-name>; <K> specialists
```

ONE stop line on failure:

```
execute-with-teams: stopped at <stage> — <reason>
hint: <single actionable next step>
```

No tasks tables, no specialist transcripts in chat — those live in `workflow.json` and the team's `TaskList`.

---

## Phase outline

**Phase 0 — Read manifest**: load `tasksManifest` from `workflow.json`; abort if fewer than 2 tasks.

**Phase 1 — Partition by domain root**: classify each task as single-domain or cross-domain; abort if >50% are cross-domain. See [references/dispatch-strategy.md](references/dispatch-strategy.md).

**Phase 2 — Verify domain isolation (zero file overlap)**: build `domain → set(files)` map; abort on any pair intersection. This is the sole safety mechanism on a shared working tree.

**Phase 3 — Build DAG and create team**: encode cross-domain dependencies as `addBlockedBy` chains; `TeamCreate` the team. See [references/team-coordination.md](references/team-coordination.md).

**Phase 4 — TaskCreate per domain milestone**: one TaskCreate per domain specialist + one standing test-and-mutation slot (no pre-allocated tasks).

**Phase 5 — Parallel specialist dispatch** (single message, multiple Agent calls): all domain specialists + the test specialist dispatched together. Use prompts from [references/specialist-prompt-template.md](references/specialist-prompt-template.md) and [references/test-specialist-prompt-template.md](references/test-specialist-prompt-template.md). `run_in_background: true` is non-negotiable.

**Phase 6 — Wait and forward**: react only to completion summaries and blocker messages; forward each domain completion to the test specialist immediately (not batched); dispatch follow-up waves as prerequisites unblock. See [references/team-coordination.md](references/team-coordination.md).

**Phase 7 — Verify**: `TaskList()` must show every task (including dynamic test tasks) `completed`; run final smoke verification.

**Phase 8 — Aggregate**: write `STEP_<NN>_TASK_TEAM_EXEC` to `workflow.json` via `browzer workflow append-step --await`. Include `perSpecialistDeliverables[]` and `testAndMutation` roll-up. **Per-task `elapsedMin` stamping is mandatory** — see Phase 8.1 below.

### Phase 8.1 — Per-task elapsedMin stamping (mandatory)

The aggregator owns the per-TASK rows that the team executed (one row per `taskId` in
`tasksManifest.tasksOrder`). Each row's `elapsedMin` MUST reflect realistic wall-clock
attribution — leaving `elapsedMin: 0` because the row "never went through RUNNING" hides
real cost from `totalElapsedMin` roll-up and from the orchestrator's per-task analytics.

Two acceptable attribution strategies:

**Strategy A — Per-specialist self-report (preferred when specialists tracked their own
timing).** Each specialist reports its `startedAt` / `completedAt` per owned task in its
final SendMessage to the lead, AND writes
`task.execution.specialists[i].elapsedMin` per task it owned. The aggregator sums:

```bash
for TID in $(jq -r '.steps[] | select(.name=="TASKS_MANIFEST") | .tasksManifest.tasksOrder[]' "$WORKFLOW"); do
  STEP_ID=$(jq -r --arg t "$TID" '.steps[] | select(.taskId==$t) | .stepId' "$WORKFLOW")
  TASK_ELAPSED=$(jq --arg t "$TID" '
    [.steps[] | select(.taskId==$t) | .task.execution.specialists[]?.elapsedMin // 0]
    | add // 0
  ' "$WORKFLOW")
  browzer workflow patch --workflow "$WORKFLOW" --jq --arg id "$STEP_ID" --argjson e "$TASK_ELAPSED" \
    '(.steps[] | select(.stepId==$id)).elapsedMin = $e'
done
```

**Strategy B — Proportional split by file count (fallback when specialists did not self-
report).** Distribute the team's total wall-clock across owned tasks proportionally to each
task's `task.scope.files | length`. Floor at 0.5 minutes per task so trivial single-file
tasks don't round to 0:

```bash
TEAM_WALL_CLOCK=$(jq --arg id "$TEAM_EXEC_STEP_ID" \
  '.steps[] | select(.stepId==$id) | .elapsedMin // 0' "$WORKFLOW")
TOTAL_FILES=$(jq '[.steps[] | select(.name=="TASK") | .task.scope.files | length] | add // 1' "$WORKFLOW")

for TID in $(jq -r '.steps[] | select(.name=="TASKS_MANIFEST") | .tasksManifest.tasksOrder[]' "$WORKFLOW"); do
  STEP_ID=$(jq -r --arg t "$TID" '.steps[] | select(.taskId==$t) | .stepId' "$WORKFLOW")
  TASK_FILES=$(jq --arg t "$TID" '.steps[] | select(.taskId==$t) | .task.scope.files | length // 0' "$WORKFLOW")
  TASK_ELAPSED=$(awk -v w="$TEAM_WALL_CLOCK" -v f="$TASK_FILES" -v tf="$TOTAL_FILES" \
    'BEGIN { share = (tf > 0 ? (w * f / tf) : 0); printf "%.2f", (share > 0.5 ? share : 0.5) }')
  browzer workflow patch --workflow "$WORKFLOW" --jq --arg id "$STEP_ID" --argjson e "$TASK_ELAPSED" \
    '(.steps[] | select(.stepId==$id)).elapsedMin = $e
     | (.steps[] | select(.stepId==$id)).task.execution.elapsedAttributionMethod = "proportional-by-file-count"'
done
```

Either strategy MUST run before the aggregator step itself flips to COMPLETED. Skipping it
leaves the per-TASK rows at `elapsedMin: 0` even though the team executed them — this is the
exact regression that broke the dogfood report's `totalElapsedMin` roll-up.

After per-task stamping, recompute the workflow's `totalElapsedMin` roll-up (per
`workflow-schema.md §5.1` Type-1 mutator rule):

```bash
TOTAL=$(jq '[.steps[].elapsedMin // 0] | add' "$WORKFLOW")
browzer workflow patch --workflow "$WORKFLOW" --jq --argjson t "$TOTAL" '.totalElapsedMin = $t'
```

**Phase 9 — Shutdown**: `SendMessage shutdown_request` to every team member; wait for `shutdown_response`.

**Phase 10 — Return control**: print the success line; orchestrator chains to Phase 4 (CODE_REVIEW).

---

## Banned dispatch-prompt patterns

When composing the `Agent({prompt: ...})` call for specialists, NEVER include:

- `Read $WORKFLOW` or `cat workflow.json` — specialists use `browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --render execute-task` for context, never raw file reads.
- `jq . "$WORKFLOW"` — the full JSON is too large; use targeted `browzer workflow query` / `get-step` calls instead.
- "check the task list by reading workflow.json" — TaskList is the live task state; `workflow.json` steps are the audit trail. Specialists use TaskList for status, not `workflow.json`.
- Inline multi-line jq pipelines in specialist prompts — any jq needed in dispatch prompts uses `source "$BROWZER_SKILLS_REF/jq-helpers.sh"` and named helper calls.
- "feel free to commit when done" — commits are NEVER per-specialist. The lead consolidates at the end.

---

## Non-negotiables

- **No application code in this skill.** You orchestrate; specialists implement.
- **Single source of truth for team state**: the `TaskList`, not chat, not memory.
- **No silent skip of domain isolation check** (Phase 2). Skipping risks corrupted edits.
- **No silent skip of shutdown** (Phase 9). Lingering teammates leak resources.
- **Single commit at the end** (driven by operator or `commit` skill). Specialists never commit.
- **`run_in_background: true` on every specialist dispatch.** Foreground mode collapses parallelism.
- **English in workflow.json**; conversational language follows operator.

---

## Invocation modes

- **From `orchestrate-task-delivery` Phase 3** — the only production invocation path. Operator chose `executionStrategy: agent-teams` at the orchestrator's Phase 0.5 strategy prompt.
- **Direct** — rare; caller must supply `feat dir: <path>` and the workflow must have a completed `TASKS_MANIFEST` step.

Strategy resolution (`serial` vs `agent-teams`) is documented in [references/dispatch-strategy.md](references/dispatch-strategy.md). When `executionStrategy == "serial"`, the existing per-task `execute-task` dispatch runs unchanged and this skill is never invoked.

---

## Wire-in to orchestrate-task-delivery

Phase 3's `Skill(execute-task, ...)` line is replaced with `Skill(execute-with-teams, "feat dir: $FEAT_DIR")`. Phase 4+ (CODE_REVIEW onward) are unchanged — this skill writes a `STEP_<NN>_TASK_TEAM_EXEC` step that satisfies the orchestrator's Step 4 validation contract. Phase 6 (WRITE_TESTS) is recorded as `SKIPPED` with `applicability.reason: "rolled into team execution by execute-with-teams test-mutation-specialist"`.

## Related skills

- `orchestrate-task-delivery` — invokes this skill from Phase 3 when team mode selected.
- `execute-task` — the per-task skill whose Phase 0 input-resolution + per-domain dispatch contract this skill mirrors at the team level.
- `code-review`, `receiving-code-review`, `write-tests`, `update-docs`, `feature-acceptance`, `commit` — chain after Phase 3 (unchanged regardless of strategy).
