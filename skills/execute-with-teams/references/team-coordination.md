# Team coordination — DAG → blockedBy chains, follow-up dispatch

Reference for `execute-with-teams` Step 4 (DAG construction) and Step 7 (follow-up dispatch). Read this when designing the dependency graph or when a specialist completes and you need to decide what comes next.

## DAG → TaskCreate `addBlockedBy` mapping

The tasksManifest declares `task.dependencies[]` (cross-task data dependencies) and `tasksManifest.parallelizable[][]` (groups of mutually independent tasks). Both feed into the team DAG.

### Within-domain DAG

Tasks within the same domain run on a single specialist. They are sequenced by the specialist itself (in TaskList ID order, then by per-task `dependencies[]` if the specialist's read of `tasksManifest` shows ordering hints). The team-level TaskList does NOT need to model intra-domain ordering — that's the specialist's concern.

### Cross-domain DAG

Cross-domain dependencies become `addBlockedBy` chains:

```
DAG node A: "Phase Go: packages/cli — daemon WorkflowMutate + flags + tests"  (TaskList #1)
DAG node B: "Phase Skills: packages/skills — Stop hook + cascade + receipts"  (TaskList #2)
DAG node C: "Phase Validator: packages/skills — codemod + Rule 6 + docs"      (TaskList #3)

Edges: C blocked_by [A, B]   (codemod's pre-flight needs --await flag from A; consumes regex SoT from B)
```

After `TaskCreate × 3`, follow up with:

```
TaskUpdate({ taskId: "3", addBlockedBy: ["1", "2"] })
```

### Validation pass

Before dispatching specialists, walk the DAG and assert:

1. **No cycles** — `task.dependencies[]` should be acyclic by construction (manifest validator enforces it). Re-check: build adjacency map, run topological sort, fail if cycle detected.
2. **Every blocked task has at least one prerequisite that is dispatched** — guards against typos in `addBlockedBy`.
3. **Initial-phase tasks (no blockers) span ≥1 domain** — otherwise nothing dispatches and the team starves.

If any assertion fails, surface a stop line (Step 6 hasn't fired yet, so no specialist needs cleanup):

```
execute-with-teams: stopped at dag — <reason>
hint: re-run generate-task to re-emit a clean tasksManifest
```

## Initial dispatch — picking the parallel set

Specialists are dispatched in waves driven by the DAG. The first wave = all tasks with empty `blockedBy`. Send them ALL in a single response turn:

```
Agent({ name: "go-specialist", ..., run_in_background: true })
Agent({ name: "skills-specialist", ..., run_in_background: true })
```

(Two `Agent` calls in ONE response. Not a sequence. Not "first this, then that".)

Background mode is non-negotiable — see Step 6 of SKILL.md.

## Follow-up dispatch — when a phase unblocks

When a specialist reports their phase complete, run:

```
TaskList()  // returns current state
```

Find tasks where `blockedBy` resolves to all-completed. Those are the next wave.

**Decision: spawn fresh OR re-use existing specialist?**

| Situation | Decision |
|-----------|----------|
| Next wave is in a NEW domain (no specialist owns those files yet) | Spawn fresh `Agent({name: "<new-domain>-specialist", ...})` |
| Next wave is in an EXISTING domain (a specialist already worked there) AND that specialist is now idle | SendMessage to the existing specialist with new instructions; they wake up, claim, work |
| Next wave reuses an artifact a specific specialist created (e.g. validator extension consuming `_workflow-mutator-patterns.mjs` written by skills-specialist) | Strongly prefer SendMessage to the artifact's author — context is live, no rebrief needed |
| Next wave is the cross-domain coordinator | Spawn fresh `Agent({name: "coordinator", ...})` — they need a clean working set across multiple domains |

Concrete heuristic for pattern #3: when the artifact a follow-up phase consumes is a module/file/contract that one specific specialist authored in the prior phase, prefer SendMessage to that specialist over spawning fresh. Their working memory still has the API shape, the design tradeoffs, and the call-sites. A fresh agent would re-read those from disk and infer them — that's pure overhead.

## SendMessage discipline

The lead uses SendMessage for exactly five cases:

1. **Initial brief** at dispatch time — but this lives inside the `Agent({prompt: ...})` call, not a follow-up SendMessage. No separate brief message.
2. **Follow-up phase dispatch** to an existing specialist — wake them with the new task IDs and any new context they need (e.g. "prior phase shipped a shared module at <path>; consume it via the documented API").
3. **Forward to test specialist** — every domain completion event is forwarded to `test-mutation-specialist` IMMEDIATELY (not batched), with sibling name + completed taskIds + files touched + verification result + notes. This unlocks the test specialist to TaskCreate a test task and work in parallel with siblings still running. Forwarding lazily (e.g. waiting for all domains to finish before forwarding any) collapses the wall-clock benefit — the test specialist would idle through the entire active phase.
4. **Blocker diagnostics** — when a specialist sends a help message, lead replies with guidance via SendMessage.
5. **Shutdown request** at the end — protocol message `{type: "shutdown_request", reason: "..."}`. Send to test specialist LAST, after they've confirmed every forward processed (their TaskList tasks all `completed`).

The lead does NOT:

- Reply to idle notifications (those are informational).
- Send "good job!" or "thanks!" messages (noise; specialists don't need encouragement to finish).
- Quote a specialist's previous message back at them (SendMessage shows them their own history; they have it).

## Failure modes and recovery

| Symptom | Cause | Recovery |
|---------|-------|----------|
| Specialist sends summary but TaskList shows tasks still `in_progress` | Specialist forgot the final `TaskUpdate({status: completed})` | SendMessage with reminder; if no response in 1 turn, lead can update TaskList directly |
| Specialist sends blocker about file outside their domain | Domain partition was wrong | Lead reviews scope; either re-scope the task in workflow.json or absorb the cross-domain glue into the coordinator's wave |
| Two specialists working on the same file | Domain isolation check (Step 3) was bypassed | Stop the chain; surface stop line; operator must re-partition. This is a contract violation — NEVER attempt to merge concurrent edits |
| Specialist process disappears (no shutdown_response, no messages) | Harness crash, OOM, or operator killed it | Lead can dispatch a fresh specialist with the same domain ownership; the deceased specialist's TaskList claims auto-release after the harness's idle timeout |
| Coordinator starves because a single-domain specialist never finishes | Specialist stuck on flake test or unclear scope | Lead SendMessage with diagnostic prompts ("what's blocking?"); if specialist confirms infinite-flake, lead can claim+complete the failing task themselves (less common, last resort) |

## When to stop the team and fall back

Some signals say "team mode is the wrong tool — bail":

- ≥3 cross-domain coordinator dispatches required (DAG is too coupled — serialization + worktree rendezvous would be cleaner)
- Single specialist owns >80% of files (no real parallelism — overhead outweighs gain)
- Two specialists hit the same blocker independently (architecture issue that wasn't surfaced in the manifest — re-do generate-task before continuing)

Stop signal:

```
execute-with-teams: stopped at coordination — <reason>
hint: shutdown team via SendMessage shutdown_request to all members; re-invoke orchestrate-task-delivery with executionStrategy: serial
```

## Final consolidation

After all team tasks are `completed`, the lead writes the aggregator step (Phase 8) and shuts the team down (Phase 9). The operator's chat sees ONE success line; the audit trail (TaskList + workflow.json + team config file) carries the full story. No tasks-table, no transcript dump, no per-specialist breakdown in chat.

## Aggregator step shape (STEP_<NN>_TASK_TEAM_EXEC)

Phase 3's contract with the orchestrator is "TASK steps are written for every task in the manifest". With team execution, individual `STEP_<NN>_TASK_<MM>` steps may not be written 1-to-1 by specialists (they each manage their own slice). The aggregator step closes the contract.

Write via:

```bash
NN=$(browzer workflow query next-step-id --workflow "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_TASK_TEAM_EXEC"
```

Key payload fields:

- `task.teamExecution.teamName` — the team name from TeamCreate.
- `task.teamExecution.members[]` — one entry per specialist (domain + name + taskIds owned).
- `task.teamExecution.domains[]` — list of domain roots served.
- `task.teamExecution.ownedTasks[]` — all task IDs that ran through the team.
- `task.teamExecution.perSpecialistDeliverables[]` — one per domain specialist: name, files touched, LoC delta, skillsLoaded[], verification command + result, blockers (if any), final summary message.
- `task.teamExecution.testAndMutation` — test specialist roll-up: total tests authored, total mutants generated, total mutants killed, kill rate (overall + per sibling), surviving-mutant locations with annotations (`equivalent_mutation` vs real coverage gap), per-sibling slice summaries, any `deferred-post-merge` markers.

`testAndMutation` replaces the orchestrator's Phase 6 (WRITE_TESTS) record — the orchestrator records Phase 6 as `SKIPPED` in agent-teams strategy and points downstream readers at this block.

The orchestrator's validation reads `currentStepId` and sees `STEP_<NN>_TASK_TEAM_EXEC` with `status: COMPLETED`, satisfying the gate to chain to Phase 4 (CODE_REVIEW).

## Idle-notification discipline (round-table contract)

The harness auto-delivers messages from teammates as new conversation turns. **Do not poll TaskList. Do not check inboxes. Do not react to idle notifications.**

Idle is the normal post-turn state for every teammate. An idle notification immediately after a content message means the specialist sent their summary and is now waiting — they are not done with the team, they are done with the turn. The system will deliver real progress as it happens.

**React to**:
- Domain specialist completion summary → forward to test specialist (immediate), dispatch next wave.
- Test specialist completion summary → acknowledge by NOT replying (they return to Phase 0).
- Any specialist blocker message → diagnose, reply via SendMessage.

**Do not react to**:
- Idle notifications (any volume — even 5 in a row).
- Inter-teammate DM summaries that arrive in your idle notification (informational only).
- Test specialist's idle state between forwards (that is their normal Phase 0 wait state).

## Shutdown sequence

```
SendMessage({ to: "<member-name>", message: { type: "shutdown_request", reason: "Phase 3 complete; team work concluded" } })
```

Send to test specialist LAST (after all domain specialists confirm shutdown). Members respond with `shutdown_response` and their process exits. The team file at `~/.claude/teams/<team-name>/config.json` persists for retro analysis.

**Do NOT skip shutdown.** Lingering teammates consume harness resources and confuse downstream phases (a stale specialist could pick up unrelated tasks the next time someone fires `TaskCreate` in the same team namespace).
