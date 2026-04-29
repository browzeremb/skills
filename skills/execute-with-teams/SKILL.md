---
name: execute-with-teams
description: "Domain-bound parallel execution of Phase 3 (TASK_*) via a Claude Code agent team — TeamCreate + a shared TaskList + multiple specialists (one per domain root) running in parallel — instead of serial per-task execute-task dispatch. Use this when a feature spans 2+ distinct domain roots (apps/api, apps/web, packages/cli, packages/skills, etc.) AND the task scopes have zero file overlap between domains. Saves wall-clock by parallelizing across orthogonal scopes; preserves correctness via per-domain isolation (no merge conflicts on shared working tree) and TaskList-driven coordination with blockedBy chains. Triggered from orchestrate-task-delivery Phase 3 when the operator picks `agent-teams` execution strategy. Replaces per-task execute-task dispatch with a team — each specialist still runs the equivalent of execute-task internally for its scope. Make sure to use this skill whenever the feature touches multiple independent packages/apps and the operator opted into team mode, even if they don't explicitly say 'spawn a team'."
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(jq *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Read, AskUserQuestion, Agent
---

# execute-with-teams — domain-bound parallel team for Phase 3

You orchestrate a Claude Code agent team. You DO NOT implement code — your specialists do. Your job is **partition by domain → dispatch specialists in parallel → wait for completion via mailbox → aggregate results into workflow.json → shutdown the team**.

This skill is invoked by `orchestrate-task-delivery` Phase 3 when the operator chose `executionStrategy: agent-teams`. It replaces the serial-or-worktree-parallel per-task dispatch with a team-based parallel execution. Each specialist owns one domain and the slice of tasks scoped to it, loads the domain skills declared in each owned task's `task.explorer.skillsFound[]` (the same contract `execute-task` honors per-task), and ships its slice in parallel with siblings on a shared working tree.

The pattern: when N tasks span M ≥ 2 disjoint domain roots (e.g. backend service + frontend app + CLI package, or service A + service B + shared package), domain isolation guarantees no merge conflicts on the shared tree. Wall-clock for the initial-phase domains runs concurrently; cross-domain follow-ups (validators, codemods, glue code that consumes initial-phase artifacts) dispatch after their prerequisites land.

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

## Step 1 — Read manifest and per-task scopes

```bash
WORKFLOW="$FEAT_DIR/workflow.json"
MANIFEST=$(browzer workflow query --workflow "$WORKFLOW" task-gates-baseline)
```

Read these from `workflow.json`:

- `tasksManifest.tasksOrder[]` — ordered task IDs.
- `tasksManifest.parallelizable[][]` — groups already vetted for parallel execution.
- For each `STEP_<NN>_TASK_<MM>` step: `task.scope.files[]`, `task.explorer.domains[]`, `task.explorer.skillsFound[]`, and any `task.dependencies[]`.

If the manifest carries fewer than 2 tasks, abort:

```
execute-with-teams: stopped at validate — only N task(s); team mode adds overhead with no benefit
hint: re-invoke orchestrate-task-delivery without agent-teams strategy
```

---

## Step 2 — Group tasks by domain root

Domain root = the first 2 path segments shared by every file in a task's scope. Examples:

| File path | Domain root |
|-----------|-------------|
| `apps/api/src/routes/foo.ts` | `apps/api` |
| `apps/web/components/Bar.tsx` | `apps/web` |
| `packages/cli/internal/daemon/methods.go` | `packages/cli` |
| `packages/skills/hooks/_util.mjs` | `packages/skills` |
| `docs/runbooks/foo.md` + `apps/api/...` | `cross-domain` |

Classify each task:

- **Single-domain task** → assigned to that domain's specialist.
- **Cross-domain task** → assigned to a special `coordinator` specialist that runs AFTER all single-domain specialists finish. Encode the dependency via TaskCreate `addBlockedBy`.

If `>50%` of tasks are cross-domain, the team-mode benefit collapses — abort with hint to use serial mode:

```
execute-with-teams: stopped at partition — N/M tasks are cross-domain; team mode is not the right tool
hint: re-invoke orchestrate-task-delivery without agent-teams strategy
```

---

## Step 3 — Verify domain isolation (zero file overlap)

Build a `domain → set(files)` map. For every pair of domains, the intersection MUST be empty. If overlap detected:

```
execute-with-teams: stopped at validate — domain <X> and <Y> share files: <list (max 5)>
hint: re-scope offending tasks in tasks_manifest to live in a single domain, OR fall back to serial
```

**Why this matters**: parallel team members work on the same git working tree (no worktree isolation). Zero file overlap is what guarantees no merge conflicts. The test cost is ~50ms per intersection check; the cost of getting it wrong is corrupted edits mid-run.

---

## Step 4 — Build the dependency DAG and create the team

DAG nodes = domain milestones (group of tasks within one domain executable together by one specialist).
DAG edges = cross-domain `task.dependencies[]` already declared in the manifest.

Encode the DAG as TaskCreate `addBlockedBy` chains. Cross-domain coordinator (if any) is blocked by all single-domain milestones it depends on.

Create the team:

```bash
TEAM_NAME="exec-$(date -u +%Y%m%d)-${FEATURE_SLUG}"
# TeamCreate is a deferred tool — harness loads its schema via ToolSearch on first use
```

Tool call (pseudo):

```
TeamCreate({
  team_name: TEAM_NAME,
  agent_type: "team-lead",
  description: "Phase 3 team for <featureId>: parallel execution across <list of domains>"
})
```

You (the agent invoking this skill) become the team lead.

---

## Step 5 — TaskCreate per domain milestone (and pre-allocate the test slot)

The team has TWO classes of members:

- **Domain specialists** — one per domain root from Step 2. Pre-allocated TaskList tasks with explicit owned files.
- **Test-and-mutation specialist** — one standing member with NO initial TaskList tasks. They create test tasks dynamically as domain specialists complete their slices. See `references/test-specialist-prompt-template.md` for the contract.

The test specialist is dispatched in Step 6 alongside domain specialists, but the lead does NOT pre-create their tasks. Their tasks are TaskCreated by the specialist itself when the lead forwards a domain completion event (Step 7). This is why the team-mode pipeline can SKIP the orchestrator's Phase 6 (WRITE_TESTS) — the test work is already happening inside Phase 3, in parallel with the domain work that produces it.

For each domain milestone, fire one `TaskCreate`:

```
TaskCreate({
  subject: "Phase <X>: <domain> — <one-line goal>",
  description: """
    Domain: <domain root>
    Owned tasks: <TASK_ID list>
    Files in scope: <bullet list, capped at 30; if more, link to workflow.json query>
    Forbidden files: <other domains' file lists>
    Acceptance criteria: <copied from manifest's task.gates and task.acceptance>
    Verification commands: <stack-specific gate, e.g. `cd packages/cli && make ci`>
    Reference: docs/browzer/<feat>/workflow.json (read with browzer workflow get-step ...)
  """,
  activeForm: "Building <domain milestone>"
})
```

Then chain `TaskUpdate({ taskId, addBlockedBy: [<prereq taskIds>] })` for each cross-domain dependency.

Creation MUST happen in a single response turn (parallel tool calls). `addBlockedBy` chaining can be a follow-up turn (it requires the IDs returned from the previous round).

---

## Step 6 — Parallel specialist dispatch (single message, multiple Agent calls)

This is the load-bearing step. **All specialists — every domain specialist PLUS the standing test-and-mutation specialist — are dispatched in a SINGLE response turn, with multiple `Agent(...)` tool calls in parallel.** Announcing "I'll dispatch 4 specialists" and then sending 1 call is a protocol violation — the parallelism is literal.

The test-and-mutation specialist is dispatched with NO initial owned TaskList tasks (they create tasks dynamically per Step 7's forwarding pattern). Their prompt comes from `references/test-specialist-prompt-template.md` — different shape from domain specialists because the role is reactive.

Each specialist is dispatched as a domain-skill-loading agent following the same contract `execute-task` uses for its per-task subagents (Phase 0 input resolution + subagent-preamble §Step 0 BLOCKING domain-skill load + §Step 1-5). The team specialist is essentially the per-domain-subagent of execute-task scaled up to own multiple tasks within one domain.

**Pre-dispatch: aggregate skillsFound per specialist.**

For each domain milestone, read every owned task's `task.explorer.skillsFound[]` and aggregate into a deduplicated list ordered by max relevance (`high` → `medium` → `low`):

```bash
SPECIALIST_SKILLS=$(jq -r --arg ids "$OWNED_TASK_IDS_CSV" '
  ($ids | split(",")) as $ids
  | [ .steps[] | select(.taskId as $t | $ids | index($t)) | .task.explorer.skillsFound[]? ]
  | group_by(.skill)
  | map({ skill: .[0].skill, relevance: ([.[].relevance] | max_by(if .=="high" then 3 elif .=="medium" then 2 else 1 end)) })
  | sort_by(if .relevance=="high" then 0 elif .relevance=="medium" then 1 else 2 end)
' "$WORKFLOW")
```

This list goes verbatim into the specialist's prompt as the `Skill to invoke:` block — same shape `execute-task` Phase 2 dispatch uses.

**Pre-dispatch: paste the subagent-preamble.**

Read `../orchestrate-task-delivery/references/subagent-preamble.md` (or whichever path resolves from this skill's directory) and paste §Step 0 through §Step 5 verbatim into the specialist's prompt — Step 0 is the BLOCKING domain-skill load that makes the specialist load `skillsFound[]` before touching any code, Step 1-5 cover repo anchoring, baseline capture, regression-diff contract, and the workflow.json reporting schema.

Per domain specialist Agent call:

```
Agent({
  description: "<domain> specialist — Phase 3",
  subagent_type: "general-purpose",
  team_name: TEAM_NAME,
  name: "<domain>-specialist",
  run_in_background: true,
  prompt: <see references/specialist-prompt-template.md, with skillsFound + subagent-preamble pasted>
})
```

Test-and-mutation specialist Agent call (standing member, dispatched in the same turn):

```
Agent({
  description: "test-and-mutation specialist — Phase 3 (replaces serial Phase 6)",
  subagent_type: "general-purpose",
  team_name: TEAM_NAME,
  name: "test-mutation-specialist",
  run_in_background: true,
  prompt: <see references/test-specialist-prompt-template.md, with sibling list + testing skills + subagent-preamble pasted>
})
```

The full prompt templates are in `references/specialist-prompt-template.md` (domain) and `references/test-specialist-prompt-template.md` (test). Key constraints encoded in the domain template:

1. **Phase 0 — Resolve the input** (mirrors execute-task §Phase 0): for each owned task, run `browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --render execute-task` to load `TASK_CONTEXT`; flip status to RUNNING via `set-status --await`; capture lifecycle flags (`task.suggestedModel`, `task.trivial`).
2. **subagent-preamble §Step 0 — BLOCKING domain-skill load**: invoke each `Skill(<path>)` from the aggregated list in relevance order BEFORE any Read/Edit/browzer call. Skipping = drift; the lead's audit step (Step 8) MAY drop output from a specialist whose trace shows zero `Skill()` invocations.
3. **subagent-preamble §Step 1 — Anchor on repo rules**: CLAUDE.md / AGENTS.md / CONTRIBUTING.md + per-package CLAUDE.md for every directory in scope. `browzer search` before touching unfamiliar libraries.
4. **subagent-preamble §Step 2 — Baseline gate**: scoped to owned files (NOT repo-wide). The skillsFound entries usually carry the right gate command; otherwise discover from manifests.
5. **TaskList workflow**: `TaskUpdate({taskId, owner: "<name>", status: "in_progress"})` BEFORE starting; `TaskUpdate({taskId, status: "completed"})` AFTER verification passes for each owned task.
6. **Domain boundary discipline**: NEVER touch files outside the specialist's domain root list. Sibling specialists own those.
7. **Forbidden actions**: NO commits, NO push, NO writes to other specialists' workflow.json steps. Lead consolidates the aggregator step (Step 9) at the end.
8. **subagent-preamble §Step 4 — workflow.json reporting**: append `task.execution.agents[]` per owned task with `skillsLoaded[]` (the actual skill paths invoked via `Skill()`); `gates.regression` per §Step 2.5.
9. **SendMessage discipline**: ONE summary message to lead on phase completion (plain text, 3-5 lines). Help message ASAP on blocker.

**Why background mode**: lead has independent work — dispatching follow-up phases when prereqs unblock. Foreground would serialize the lead.

**Why same working tree (no worktree isolation)**: domain isolation (Step 3) already guarantees zero file overlap. Worktree setup costs wall-clock per branch; skipping it amortizes when isolation holds. Worktrees are still the right move when isolation does NOT hold (cross-domain coordinator with overlap, or tasks editing shared files); in that case the operator should pick serial mode + worktree-rendezvous instead.

---

## Step 7 — Wait for completion notifications + forward to test specialist (no polling)

The harness auto-delivers messages from teammates as new conversation turns. **Do not poll TaskList. Do not check inboxes. Do not react to idle notifications.**

Idle is the normal post-turn state for every teammate. An idle notification immediately after a content message means the specialist sent their summary and is now waiting — they're not done with the team, they're done with the turn. The system will deliver real progress as it happens.

**What you SHOULD react to**:

- **Domain specialist sends a completion summary** → that domain milestone is done. Two follow-ups in the same turn:
  1. **Forward to the test specialist via SendMessage** with the completion event — sibling name, taskIds (TaskList + workflow.json STEP_IDs) completed, files touched, verification command + result, any explicit notes (skipped invariants, deferred coverage, fragility callouts). The test specialist creates a TaskCreate'd test task per the forward and works on it. Do this forward IMMEDIATELY, not batched at the end — the test specialist works in parallel with siblings still running, that's where the wall-clock win is.
  2. **Dispatch follow-up phases** if cross-domain prerequisites are now unblocked (TaskList shows blocked tasks eligible). Prefer SendMessage to existing teammates whose context is reusable (e.g. a specialist who built a shared module is the natural owner of a follow-up consuming that module). Spawn fresh specialists only when no existing teammate has the relevant context.

- **Test specialist sends a completion summary** → one test task slice is done (mutation kill rate captured, reports filed). Acknowledge by NOT replying — they return to Phase 0 (waiting for next forward) automatically.

- **Any specialist sends a blocker message** → diagnose, send guidance back via SendMessage. If the test specialist blocks (e.g. stack has no mutation tool wired), decide: dispatch a tooling-setup task to a domain specialist, OR mark the affected slice's mutation testing as `deferred-post-merge` in workflow.json and let the test specialist proceed with regular tests only.

**What you should NOT react to**:

- Idle notifications (any volume — even 5 in a row).
- Inter-teammate DM summaries that arrive in your idle notification (they're informational).
- Test specialist's idle state between forwards — that's their normal Phase 0 state, NOT a stall.

---

## Step 8 — Verify final state via TaskList (including dynamic test tasks)

When all domain specialists have reported their phases complete AND the test specialist has processed every forward:

```
TaskList()  // built-in tool
```

Every team task MUST show `status: completed` — including the dynamically-created test tasks (subjects starting with "Test+mutation for"). Don't shutdown the team until the test specialist's last test task closes. Any task in `pending` or `in_progress` past expected duration (rule of thumb: 2x the planned duration) is a stop signal:

```
execute-with-teams: stopped at verify — task #<id> stuck in <status>; specialist <name> idle but task not closed
hint: SendMessage to <name> asking for status, or claim the task yourself to close it manually
```

Run a final smoke verification covering all domains touched:

```bash
# Aggregate per-stack verifications discovered in Step 5 task descriptions
# Example for a Go + Node feature:
cd packages/cli && go build ./... && go test ./... -count=1 -timeout=120s
cd packages/skills && node scripts/validate-frontmatter.mjs && pnpm test
```

If any verification fails, do NOT mark the parent step COMPLETED. Surface a stop line and let the operator decide whether to re-dispatch a specialist or fall back to serial.

---

## Step 9 — Aggregate into a single TASK_TEAM_EXEC step

Phase 3's contract with the orchestrator is "TASK steps are written for every task in the manifest". With team execution, individual `STEP_<NN>_TASK_<MM>` steps may not be written 1-to-1 by specialists (they each manage their own slice). The aggregator step closes the contract:

```bash
NN=$(browzer workflow query next-step-id --workflow "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_TASK_TEAM_EXEC"

PAYLOAD=$(jq -n \
  --arg id "$STEP_ID" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg team "$TEAM_NAME" \
  --argjson tasks "$ALL_TASK_IDS_JSON" \
  --argjson domains "$DOMAINS_JSON" \
  --argjson members "$MEMBERS_JSON" \
  --argjson deliverables "$DELIVERABLES_JSON" \
  '{
    stepId: $id, name: "TASK", taskId: "TEAM_EXEC", status: "COMPLETED",
    applicability: { applicable: true, reason: "team-mode aggregator" },
    startedAt: $now, completedAt: $now, elapsedMin: 0,
    retryCount: 0, itDependsOn: [], nextStep: null,
    skillsToInvoke: ["execute-with-teams"], skillsInvoked: ["execute-with-teams"],
    owner: null, worktrees: { used: false, worktrees: [] },
    warnings: [], reviewHistory: [],
    task: {
      teamExecution: {
        teamName: $team, members: $members,
        domains: $domains, ownedTasks: $tasks,
        perSpecialistDeliverables: $deliverables,
        testAndMutation: $testDeliverables
      }
    }
  }')

echo "$PAYLOAD" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

`perSpecialistDeliverables[]` carries one entry per domain specialist with: name, files touched, LoC delta, skillsLoaded[], verification command + result, blockers (if any), final summary message.

`testAndMutation` carries the test specialist's roll-up: total tests authored, total mutants generated, total mutants killed, kill rate (overall + per sibling), surviving-mutant locations with annotations (`equivalent_mutation` vs real coverage gap), per-sibling slice summaries, any `deferred-post-merge` markers (e.g. mutation tool absent on a slice). This is the audit trail that REPLACES the orchestrator's Phase 6 (WRITE_TESTS) record — the orchestrator records Phase 6 as `SKIPPED` in agent-teams strategy and points downstream readers at this block.

The orchestrator's Step 4 read of `currentStepId` will see `STEP_<NN>_TASK_TEAM_EXEC` with `status: COMPLETED`, satisfying the gate to chain to Phase 4 (CODE_REVIEW). Phase 6 (WRITE_TESTS) is then skipped via its own SKIPPED step.

---

## Step 10 — Shutdown teammates

For each team member, send a graceful shutdown:

```
SendMessage({
  to: "<member-name>",
  message: { type: "shutdown_request", reason: "Phase 3 complete; team work concluded" }
})
```

Members respond with `shutdown_response` and their process exits. The team file at `~/.claude/teams/<team-name>/config.json` persists for retro analysis but the workers are gone.

**Do NOT skip shutdown.** Lingering teammates consume harness resources and confuse downstream phases (a stale `skills-specialist` could pick up unrelated tasks the next time someone fires `TaskCreate` in the same team namespace).

---

## Step 11 — Return control to orchestrator

Print the success line:

```
execute-with-teams: <featureId> shipped <T> tasks across <D> domains via team <TEAM_NAME>; <K> specialists
```

The orchestrator's chain contract advances to Phase 4 (CODE_REVIEW) on the same response turn — quote-then-`Skill(code-review, ...)` in one response.

---

## Patterns from production

These patterns shaped the skill — keep them in mind when adapting:

1. **Domain isolation eliminates worktree need.** When `Step 3` passes (zero file overlap), the entire team can write to the same working tree concurrently. Worktrees become overhead, not safety.

2. **Re-use specialists for follow-up phases.** A specialist who built a shared module in the initial phase has live context on its API; making them ALSO own a follow-up phase that consumes that module saves the rebrief cost. SendMessage to the existing teammate beats spawning fresh whenever an artifact created by specialist X is the primary input for the next phase's work.

3. **`run_in_background: true` is non-negotiable for the lead.** If the lead foregrounds even one specialist, lead loses the ability to dispatch follow-ups while specialists are working. The whole team-mode benefit collapses to serial.

4. **TaskList is the audit log; chat is the cursor.** Specialists update TaskList with status changes — that's the durable record. Chat between lead and specialists is for handoffs, blockers, and shutdown. Restating TaskList content in chat (e.g. "5 of 7 tasks done") is forbidden — operator can read TaskList directly.

5. **Single-commit consolidation (default).** Specialists do NOT commit. The lead consolidates everything at the end via the operator's preferred commit flow (`commit` skill or operator-driven `git commit`). This keeps history clean — one feature, one or a few commits, not 4 specialists × N tasks each.

6. **Capability detection on entry.** Some Claude Code harnesses lack `TeamCreate`/`SendMessage`. Probe ToolSearch BEFORE calling TeamCreate. If unavailable, fall back gracefully:

   ```
   execute-with-teams: stopped at capability — TeamCreate not available in this harness
   hint: re-invoke orchestrate-task-delivery without agent-teams strategy (serial path)
   ```

---

## Wire-in to orchestrate-task-delivery

This skill is invoked from `orchestrate-task-delivery` Phase 3 ONLY when the operator chose `executionStrategy: agent-teams`. The strategy is resolved in Step 0.5 (immediately after Step 0 mode resolution):

```
Step 0   — mode resolution (autonomous | review)        — orthogonal axis (gating)
Step 0.5 — strategy resolution (serial | agent-teams)   — orthogonal axis (dispatch shape)
```

Operator is asked the strategy question CONDITIONALLY — only when the tasks_manifest will likely produce ≥2 single-domain task groups. The orchestrator computes a hint based on `task.scope.files[]` prefixes and prompts only when the hint signals multi-domain. Single-domain features default to `serial` silently.

When `executionStrategy == "agent-teams"`, Phase 3's `Skill(execute-task, ...)` line is replaced with `Skill(execute-with-teams, "feat dir: $FEAT_DIR")`. Phase 4+ (CODE_REVIEW onward) are unchanged — `execute-with-teams` writes a STEP_<NN>_TASK_TEAM_EXEC step that satisfies the orchestrator's Step 4 validation contract.

When `executionStrategy == "serial"`, the existing per-task `execute-task` dispatch runs unchanged.

---

## Tool dependencies

This skill REQUIRES a Claude Code harness with these tools (all auto-loaded via ToolSearch on first use; deferred):

- `TeamCreate` — bootstrap the team
- `TaskCreate`, `TaskUpdate`, `TaskList` — shared coordination
- `Agent` — spawn specialists with `team_name` + `name` + `run_in_background`
- `SendMessage` — inter-agent comms (dispatch follow-ups, request shutdown)
- `AskUserQuestion` — operator prompts (already used by orchestrator at Step 0.5; this skill itself doesn't ask)

If any are missing, fall back per Step 10 capability check.

`browzer workflow * --await` is the synchronous append-step path used in Step 9 — needed because the aggregator step gates Phase 4. Do NOT skip `--await` here; the orchestrator's `currentStepId` read in Step 4 happens immediately after this skill returns, so the write must be durable before the orchestrator reads.

---

## Non-negotiables

- **No application code in this skill.** You orchestrate; specialists implement.
- **Single source of truth for team state**: the `TaskList`, not chat, not memory.
- **No silent skip of Step 3** (domain isolation). Skipping risks corrupted edits.
- **No silent skip of Step 10** (shutdown). Lingering teammates leak resources.
- **Single commit at the end** (driven by operator or `commit` skill). Specialists never commit.
- **English in workflow.json**, conversational language follows operator.

---

## Related skills

- `orchestrate-task-delivery` — invokes this skill from Phase 3 when team mode selected.
- `execute-task` — the per-task skill whose Phase 0 input-resolution + per-domain dispatch contract this skill mirrors at the team level. Specialists honor the same `task.explorer.skillsFound[]` skill-loading contract via the pasted subagent-preamble.
- `../orchestrate-task-delivery/references/subagent-preamble.md` — the canonical §Step 0-5 contract for code-subagent dispatch. Pasted verbatim into each specialist's prompt.
- `code-review`, `receiving-code-review`, `write-tests`, `update-docs`, `feature-acceptance`, `commit` — chain after Phase 3 (unchanged regardless of strategy).
- `references/specialist-prompt-template.md` — per-specialist prompt template.
- `references/team-coordination.md` — DAG → blockedBy chains, follow-up dispatch patterns.
