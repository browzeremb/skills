---
name: generate-task
description: "Two-pass task decomposer. Explorer pass (haiku, zero technical decisions) maps files, dep graphs, domains, and skills-to-invoke per prospective task; Reviewer pass (sonnet default, opus for complex scopes) validates the mapping and enumerates test coverage targets per task. Reads the PRD from `workflow.json`. Triggers: break this PRD into tasks, generate tasks, plan the implementation, decompose this spec, task plan, task breakdown, sequence the work, split this into PRs, 'how should I sequence this'."
argument-hint: "feat dir: <path> | free-form PRD source"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(date *), Bash(jq *), Bash(mv *), Bash(source *), Read, Write, Agent, AskUserQuestion
---

# generate-task — Explorer + Reviewer two-pass

Step 2 of the workflow. Reads the PRD from `STEP_02_PRD` in `workflow.json` and writes:

- **STEP_03_TASKS_MANIFEST** — totalTasks, tasksOrder, dependencyGraph, parallelizable.
- **STEP_04_TASK_01 … STEP_NN_TASK_MM** — one step per task, with `task.explorer` (Pass 1) and `task.reviewer` (Pass 2) payloads populated.

Output contract: emit ONE confirmation line on success.

You are a staff engineer breaking a spec into mergeable PR-sized tasks for **the repo this skill is invoked from**. You don't assume framework, monorepo shape, or test runner — you discover them. Every task must be directly runnable by `execute-task` with zero additional discovery.

---

## References router

| Topic | Reference |
|---|---|
| Explorer dispatch + domain taxonomy | `references/explorer-pass.md` |
| Reviewer dispatch + grouping rules + validators + Step 7.5 | `references/reviewer-pass.md` |
| Atomic jq helpers | `references/jq-helpers.sh` |
| Subagent preamble (paste into every dispatch) | `references/subagent-preamble.md` |
| Workflow step shapes | `references/workflow-schema.md` |
| Review-mode renderers | `references/renderers/tasks-manifest.jq`, `task.jq` |

---

## Inputs

- **Primary:** `feat dir: <path>` — passed by the orchestrator, `generate-prd`, or direct invocation. Bind to `FEAT_DIR`.
- **Fallback 1:** user invokes `generate-task` alone. List existing folders via `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -5` and ask which one (or accept a path arg). If none exist, call `Skill(skill: "generate-prd")` first.
- **Fallback 2:** user pastes a free-form description without a PRD. Call `Skill(skill: "generate-prd")` first — don't decompose against a shapeless request.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

```bash
source references/jq-helpers.sh   # provides clarification_audit, seed_step, complete_step
```

## Step 1 — Read the PRD and baseline

```bash
PRD=$(jq '.steps[] | select(.name=="PRD") | .prd' "$WORKFLOW")
BRAINSTORM_STEP=$(jq -r 'first(.steps[] | select(.name=="BRAINSTORMING") | .stepId) // empty' "$WORKFLOW")
if [ -n "$BRAINSTORM_STEP" ]; then
  BRAINSTORM_SUMMARY=$(browzer workflow get-step "$BRAINSTORM_STEP" --render brainstorming --workflow "$WORKFLOW")
fi
MODE=$(browzer workflow get-config mode --workflow "$WORKFLOW" --no-lock)
MODE=${MODE:-autonomous}
```

If the PRD step is missing or empty, STOP and emit:

```
generate-task: stopped at pre-PRD gate — workflow.json has no STEP_02_PRD
hint: invoke Skill(skill: "generate-prd") first
```

**Staleness gate** — same three-signal protocol as `generate-prd` (lastSyncCommit drift, browzer stderr "N commits behind", or `lastSyncCommit==null` unconditional warning). Surface at most once; append `; ⚠ index N commits behind HEAD` to the confirmation line.

Extract from the PRD payload: `functionalRequirements[]`, `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, `inScope`, `outOfScope`, `dependencies`, `taskGranularity`. `outOfScope` is a hard constraint.

## Step 2 — Pass 1: Explorer

See **`references/explorer-pass.md`** for the full dispatch prompt, domain taxonomy table, and the jq block that writes each `TASK` step with `task.explorer` filled.

## Step 3 — Pass 2: Reviewer

See **`references/reviewer-pass.md`** for the full dispatch prompt and the CLI command that patches `task.reviewer` into each task step.

## Step 4 — Emit STEP_03_TASKS_MANIFEST

After every task step has `task.reviewer` filled, compute:

- **tasksOrder**: array of taskIds in dependency + layer order.
- **dependencyGraph**: `{ "TASK_01": [], "TASK_02": ["TASK_01"], ... }`.
- **parallelizable**: `[[ "TASK_02", "TASK_03" ]]` — groups with disjoint scope + same predecessor batch.
- **totalTasks**: count.

Insert the manifest step BEFORE the first task step (stepId `STEP_03_TASKS_MANIFEST`):

```bash
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --argjson step "$MANIFEST_STEP" \
  '.steps = ([.steps[] | select(.name!="TASK")] + [$step] + [.steps[] | select(.name=="TASK")])'
```

## Step 5 — Grouping rules

See **`references/reviewer-pass.md` §Step 5** for all 8 rules (layer order, file cap, orphan-free, merge-safe, forward deps, repo invariants, delivered value, worktree thresholds). The Reviewer re-validates all rules; this step is a cross-check gate only.

## Step 6 — Review gate (when `config.mode == "review"`)

- `autonomous` → skip.
- `review` → flip STEP_03_TASKS_MANIFEST + each task step to `AWAITING_REVIEW`; render `references/renderers/tasks-manifest.jq`, then `references/renderers/task.jq` for each task step. Enter the gate loop (Approve / Adjust / Skip / Stop). Translate operator edits to jq ops on `.task.scope`, `.task.reviewer.testSpecs`, `.task.invariants`. Append to `reviewHistory[]` per schema §7.

## Step 7 — Validation before emitting

See **`references/reviewer-pass.md` §Step 7** for the full structural checklist, bindsTo validator script, and tiered threshold rules. Fix in place before emitting; ask the operator if scope would be lost.

## Step 7.5 — Re-apply Reviewer corrections to task.scope

See **`references/reviewer-pass.md` §Step 7.5** for the full patch loop that walks every `task.reviewer.additionalContext.changes[]` and applies `corrected`/`added`/`dropped` entries to `task.scope`. This step runs BEFORE Step 8.

## Step 8 — Output contract

```
generate-task: updated workflow.json STEP_03_TASKS_MANIFEST + N task steps; status COMPLETED
```

With staleness warning:

```
generate-task: updated workflow.json STEP_03_TASKS_MANIFEST + N task steps; status COMPLETED; ⚠ index N commits behind HEAD
```

On failure:

```
generate-task: stopped at <stepId> — <one-line cause>
hint: <single actionable next step>
```

Nothing else. No summary table. No inline task bodies. No "Next steps" block.

---

## Non-negotiables

- **Output language: English.** All JSON fields, task titles, scopes, test specs in English.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.
- No legacy `.meta/activation-receipt.json` or `TASK_NN.md` files.
- Explorer makes ZERO technical decisions. Reviewer owns test-spec authoring.
- Don't invent paths — if `explore` found nothing, leave `filesModified` empty.
- Don't over-split. Rule 8 is load-bearing.
- Don't invent invariants.

## Related skills

- `generate-prd` — previous step; source of the PRD payload.
- `execute-task` — next step; dispatches agents per task's `explorer.skillsFound`.
- `orchestrate-task-delivery` — master router driving the full pipeline.
- `references/workflow-schema.md` — authoritative schema.
- `references/subagent-preamble.md` — mandatory preamble for Explorer + Reviewer dispatches.
