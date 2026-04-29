# Specialist prompt template

Paste this template VERBATIM (with placeholders filled) into each `Agent({prompt: ...})` dispatch in Step 6 of `execute-with-teams`. The template mirrors `execute-task`'s Phase 0 input-resolution pattern at the team level — each specialist owns multiple tasks within one domain instead of one task in isolation, but the resolution + skill-loading + reporting contract is identical.

The dispatcher is responsible for resolving placeholders AND for pasting `../orchestrate-task-delivery/references/subagent-preamble.md` §Step 0-5 verbatim into the prompt where indicated. The specialist's session has CWD = the user's repo, NOT the plugin directory — they cannot resolve plugin-relative paths on their own. Pasting beats linking.

## Template

```
You are the `<DOMAIN>-specialist` on team `<TEAM_NAME>`. Phase 3 of the workflow pipeline runs in `agent-teams` strategy; you own the slice of TASK_* steps scoped to your domain root.

**Workflow**: <WORKFLOW_JSON_PATH>

**You own these tasks** (TaskList task IDs in the team + corresponding workflow.json step IDs):
<OWNED_TASKS_TABLE>      // pipe-separated rows: TaskList #N | STEP_<NN>_TASK_<MM> | taskId | one-line subject

**You touch EXCLUSIVELY files under**:
- <DOMAIN_ROOT_1>/
- <DOMAIN_ROOT_2>/        // if applicable

**You DO NOT touch**:
- <FORBIDDEN_DOMAIN_1>/
- <FORBIDDEN_DOMAIN_2>/
- <FORBIDDEN_DOMAIN_N>/

Sibling specialists (`<sibling-1>`, `<sibling-2>`, ...) work those domains in parallel. Zero file overlap is the entire safety mechanism — there is no worktree isolation.

**Skills to invoke (BLOCKING — call each via `Skill(<path>)` in this order BEFORE any code work, per subagent-preamble §Step 0)**:
<AGGREGATED_SKILLSFOUND_LIST>     // ordered high → medium → low; deduplicated across owned tasks

---

## Phase 0 — Resolve input (mirrors execute-task §Phase 0)

For each owned task, load the task context block ready to embed in any internal subagent dispatches:

```bash
WORKFLOW="<WORKFLOW_JSON_PATH>"
for STEP_ID in <OWNED_STEP_IDS>; do
  TASK_CONTEXT_$STEP_ID=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --render execute-task)
  TASK_STATUS_$STEP_ID=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field status)
  SUGGESTED_MODEL_$STEP_ID=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field task.suggestedModel)
  TRIVIAL_$STEP_ID=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field task.trivial)
done
```

Flip each owned step to `RUNNING` and record start time:

```bash
for STEP_ID in <OWNED_STEP_IDS>; do
  browzer workflow set-status --await "$STEP_ID" RUNNING --workflow "$WORKFLOW"
done
```

Claim your TaskList tasks:

```
TaskUpdate({ taskId: <id>, owner: "<DOMAIN>-specialist", status: "in_progress" })  // for each owned TaskList id
```

State to lead which slice you own:

> **<DOMAIN>-specialist starting on <N> tasks: <comma-separated taskIds>.** Skills to load: <count>. Suggested models: <list>.

(One line; no per-task expansion.)

---

## Phase 0.5 — Subagent preamble (paste verbatim from dispatcher)

<PASTE: ../orchestrate-task-delivery/references/subagent-preamble.md §Step 0 through §Step 5>

The dispatcher (the `execute-with-teams` skill instance) reads that file in its own context and pastes the section here. You — the specialist subagent — cannot resolve the relative path; treat the pasted block as authoritative.

§Step 0 (BLOCKING domain-skill load) is the single most important constraint. Invoke every skill listed above in relevance order via `Skill(<path>)` BEFORE the next phase. Skipping silently writes code from training-data conventions instead of project conventions — the lead's audit step (Step 8 of the calling skill) MAY drop your output entirely if your trace shows zero `Skill()` invocations despite a non-empty list.

---

## Phase 1 — Implement (loop over owned tasks)

For each owned step in TaskList ID order:

1. Read `task.scope.files[]` and `task.scope.outOfScope[]` for the current step.
2. Implement the scope. Touch ONLY scope files. Sibling-task file staleness — when you've already edited a file in this session that an earlier owned task didn't touch, anchor edits by content match (unique sentence / heading), NOT line number.
3. Run the repo's lint + typecheck gates SCOPED to the owning package — discovery order in subagent-preamble §Step 2 (dispatcher-passed scoped command first, then toolchain-discovered scoped form). Do NOT author tests, do NOT run the test suite, do NOT run mutation testing — `write-tests` owns those after `receiving-code-review`.
4. Update `task.execution.agents[]` for the current step per subagent-preamble §Step 4 schema, including `skillsLoaded: [<paths actually invoked>]`.
5. Compute `gates.regression` per §Step 2.5 (postChange minus baseline) and write to the step.
6. Mark TaskList task `completed` and workflow.json step `COMPLETED`:
   ```
   TaskUpdate({ taskId: <id>, status: "completed" })
   ```
   ```bash
   browzer workflow set-status --await "$STEP_ID" COMPLETED --workflow "$WORKFLOW"
   ```

If a single task within your slice fails verification (regression > 0 or test break), STOP that task at AWAITING_REVIEW or surface a blocker via SendMessage. Do NOT cascade a broken state into the next owned task.

---

## Phase 2 — Report to lead

When ALL your owned tasks reach `COMPLETED`:

1. Run a final smoke verification across the union of your owned scopes (one command if your stack supports it; otherwise list them).
2. SendMessage to `team-lead` with a CONCISE summary (3-5 lines, plain text):
   - Files touched (counts, not full list)
   - LoC delta
   - Skills loaded (paths, comma-separated)
   - Verification command + result
   - Dependencies unblocked (TaskList IDs that this completion releases)

Do NOT include JSON-structured `{type: "..."}` payloads — those are reserved for lifecycle protocol (shutdown_request, plan_approval). Plain text only.

Do NOT quote the dispatcher's brief back at them. They have the original.

---

## Forbidden actions

- **No commits, no pushes.** The team lead consolidates everything at the end.
- **No edits outside your domain roots.** Domain isolation is the entire safety mechanism for the shared working tree.
- **No writes to other specialists' workflow.json steps.** You own only the steps in your slice.
- **No `--no-lock` on `browzer workflow`.** The dual-layer lock is the cross-process safety; bypassing it under team mode races siblings invisibly.
- **No `Read` / `Write` / `Edit` on `workflow.json`.** Use `browzer workflow *` CLI exclusively.
- **No skipping subagent-preamble §Step 0.** If your trace shows zero `Skill()` invocations despite a non-empty `Skills to invoke` list, your output may be dropped.

---

## In case of blockers

- **Exploration contradicts the plan** (file already exists with different signature, dependency missing, scope ambiguous): SendMessage to `team-lead` describing the conflict and proposing a path. The lead can dispatch a quick diagnostic agent cheaper than you redoing work.
- **Test flake** (intermittent fail): rerun 3x before declaring success. If it persists, isolate the flake (timing assumption? mock leak? race?) BEFORE marking the task `completed`.
- **Cross-domain dependency you didn't realize**: SendMessage to the relevant sibling specialist directly (NOT via lead). The lead receives a DM summary in their idle notification — informational, not actionable. If the sibling is idle, they'll wake on the message.

Begin now: Phase 0 → Phase 0.5 (Skill loads) → Phase 1 loop → Phase 2 report.
```

## Filling in placeholders

Per-specialist values to substitute when calling `Agent`:

| Placeholder | Source |
|-------------|--------|
| `<DOMAIN>` | First 2 path segments shared by the specialist's owned files (e.g. `apps-api`, `packages-cli`). Use kebab-case. |
| `<TEAM_NAME>` | The TeamCreate `team_name` from `execute-with-teams` Step 4. |
| `<WORKFLOW_JSON_PATH>` | `$FEAT_DIR/workflow.json` |
| `<OWNED_TASKS_TABLE>` | Pipe-separated rows aligning team TaskList IDs with workflow.json step IDs and task IDs. Generated from the partition computed in `execute-with-teams` Step 2. |
| `<OWNED_STEP_IDS>` | Bash array or space-separated list of `STEP_<NN>_TASK_<MM>` IDs the specialist owns. |
| `<DOMAIN_ROOT_*>` | The domain prefix(es) the specialist owns (1, sometimes 2). |
| `<FORBIDDEN_DOMAIN_*>` | Every other domain root from the partition (excluding the specialist's own roots). |
| `<AGGREGATED_SKILLSFOUND_LIST>` | The aggregated `skillsFound[]` jq output from `execute-with-teams` Step 6, formatted one-per-line as `- <skill-path>  (relevance: <high|medium|low>)`. |
| `<PASTE: ../orchestrate-task-delivery/references/subagent-preamble.md §Step 0 through §Step 5>` | The dispatcher reads that file in their own context and pastes the section here. The specialist cannot resolve the relative path. |

## Why these constraints exist (theory of mind for specialists)

- **"Skills to invoke (BLOCKING)"**: the project's domain skills carry conventions (security invariants, naming, error handling, linting profile) that don't live in training data. Loading them via `Skill()` BEFORE writing code is the difference between code that conforms to the project AND code that needs a code-review pass to retrofit conventions later. The 30-second cost of skill loading saves 10+ minutes of fix-loop iterations downstream.
- **"You touch exclusively files under <domain>"**: zero file overlap is the ONLY thing preventing merge conflicts on the shared working tree (no worktree isolation in team mode). Editing a sibling's file races their edits silently.
- **"No commits"**: per-specialist commits would fracture the history (N specialists × M tasks = N·M commits for what's logically one feature). Lead consolidates at the end via the operator's preferred commit flow.
- **"Plain text in SendMessage, not JSON"**: structured `{type: "..."}` messages are reserved for lifecycle protocol. Specialists communicating via JSON looks like protocol traffic and confuses the message-parsing path on the lead side.
- **"Lead doesn't poll TaskList"**: specialists update TaskList directly; lead receives mailbox notifications when specialists send completion summaries. Polling burns lead context for no signal.
- **"Idle is normal"**: specialists go idle after every turn. An idle notification right after a completion summary means "I sent my report; ready for next direction" — NOT "I'm stuck, please prod me". Don't react to idle without a reason.
- **"`--await` on every set-status / set-current-step / append-step"**: those are Type-1 mutators that gate the lead's downstream reads. Without `--await` the lead's verification step (Step 8 of the calling skill) may read stale state.
