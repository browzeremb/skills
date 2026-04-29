# Dispatch strategy — executionStrategy resolution and capability check

Reference for `execute-with-teams` Phase 0.5 (strategy resolution) and Phase 1 (domain partition). Read this before deciding whether to proceed with team mode or fall back to serial.

## executionStrategy resolution

The strategy is resolved in `orchestrate-task-delivery` Step 0.5, immediately after Step 0 mode resolution:

```
Step 0   — mode resolution (autonomous | review)        — orthogonal axis (gating)
Step 0.5 — strategy resolution (serial | agent-teams)   — orthogonal axis (dispatch shape)
```

Operator is asked the strategy question CONDITIONALLY — only when the `tasks_manifest` will likely produce ≥2 single-domain task groups. The orchestrator computes a hint based on `task.scope.files[]` prefixes and prompts only when the hint signals multi-domain. Single-domain features default to `serial` silently.

### Decision table

| Condition | executionStrategy |
|-----------|-------------------|
| Feature spans ≥2 distinct domain roots AND file overlap across domains = zero | `agent-teams` (candidate) |
| Feature spans ≥2 distinct domain roots AND >50% of tasks are cross-domain | `serial` (team overhead > benefit) |
| Feature spans 1 domain root (all tasks in `apps/api`, OR all in `packages/cli`, etc.) | `serial` (default, no prompt) |
| Operator explicitly chose `serial` at the Step 0.5 prompt | `serial` |
| `TeamCreate` tool not available in this harness (capability check fails) | `serial` (forced fallback) |
| `>80%` of files owned by one specialist candidate (no real parallelism) | `serial` |
| `≥3` cross-domain coordinator dispatches required in the DAG | `serial` (DAG too coupled) |

## Single-domain fallback path

If, after Step 2 (partition), only one domain is detected, abort team mode immediately:

```
execute-with-teams: stopped at partition — all N tasks resolve to domain <X>; no parallelism benefit
hint: re-invoke orchestrate-task-delivery without agent-teams strategy (serial path)
```

Do NOT create the team before aborting. `TeamCreate` is irreversible in the current harness — a created team without specialists leaves a dangling config in `~/.claude/teams/`.

## Capability check

Some Claude Code harnesses lack `TeamCreate`/`SendMessage`. Probe via `ToolSearch` BEFORE calling `TeamCreate`:

```
ToolSearch({ query: "select:TeamCreate,SendMessage,TaskCreate,TaskUpdate,TaskList" })
```

If any of the five are missing, fall back gracefully:

```
execute-with-teams: stopped at capability — TeamCreate not available in this harness
hint: re-invoke orchestrate-task-delivery without agent-teams strategy (serial path)
```

Required tools (all must be present):

- `TeamCreate` — bootstrap the team
- `TaskCreate`, `TaskUpdate`, `TaskList` — shared coordination
- `Agent` — spawn specialists with `team_name` + `name` + `run_in_background`
- `SendMessage` — inter-agent comms (dispatch follow-ups, request shutdown)

## Domain root taxonomy

Domain root = the first 2 path segments shared by every file in a task's scope:

| File path | Domain root |
|-----------|-------------|
| `apps/api/src/routes/foo.ts` | `apps/api` |
| `apps/web/components/Bar.tsx` | `apps/web` |
| `packages/cli/internal/daemon/methods.go` | `packages/cli` |
| `packages/skills/hooks/_util.mjs` | `packages/skills` |
| `docs/runbooks/foo.md` + `apps/api/...` | `cross-domain` |

Tasks mixing paths from two different domain roots are **cross-domain tasks** — assigned to a special `coordinator` specialist that runs AFTER all single-domain specialists finish.

## Degrade contract

When team mode aborts at any pre-dispatch phase (capability missing, too many cross-domain tasks, single-domain detected), the orchestrator receives a stop line and re-routes to serial `execute-task` dispatch. The degrade is clean — no partial team state, no TaskList tasks created, no workflow.json mutations performed by this skill.

When team mode aborts post-dispatch (specialists already running), the lead must:

1. Send `shutdown_request` to all running specialists.
2. Wait for `shutdown_response` (or timeout after 2 turns).
3. Surface a stop line with `hint: re-invoke execute-with-teams or switch to serial after reviewing partial changes`.

Partial changes from specialists that ran are NOT automatically rolled back — the operator decides whether to keep or revert via `git diff` before re-attempting.

## Patterns from production

1. **Domain isolation eliminates worktree need.** When zero file overlap holds (Phase 2 passes), the entire team writes to the shared working tree concurrently. Worktrees become overhead, not safety.

2. **Re-use specialists for follow-up phases.** A specialist who built a shared module in the initial phase has live context on its API; SendMessage to the existing teammate beats spawning fresh when an artifact created by specialist X is the primary input for the next phase's work.

3. **`run_in_background: true` is non-negotiable for the lead.** If the lead foregrounds even one specialist, the lead loses the ability to dispatch follow-ups while specialists are working. The whole team-mode benefit collapses to serial.

4. **TaskList is the audit log; chat is the cursor.** Specialists update TaskList with status changes — that's the durable record. Chat between lead and specialists is for handoffs, blockers, and shutdown. Restating TaskList content in chat (e.g. "5 of 7 tasks done") is forbidden — operator can read TaskList directly.

5. **Single-commit consolidation (default).** Specialists do NOT commit. The lead consolidates everything at the end via the operator's preferred commit flow (`commit` skill or operator-driven `git commit`). One feature, one or a few commits, not 4 specialists × N tasks each.
