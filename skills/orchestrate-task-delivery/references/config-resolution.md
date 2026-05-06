# Config resolution — Step 2.6 + Step 2.7

Two persistent config fields are resolved once at orchestrator entry and consumed by downstream skills. Both are persisted under `.config.<key>` via `browzer workflow set-config`; neither is a workflow step. The `executionStrategy` field gates Phase 3 + Phase 5 dispatch shape; the `testExecutionDepth` field gates how deep `code-review`'s regression-tester and `feature-acceptance`'s execution-required AC gate run.

Both prompts are batched into the Step 0 `AskUserQuestion` when two or more of `mode` / `executionStrategy` / `testExecutionDepth` are unresolved. When batched, the §2.6 / §2.7 sections below SKIP the per-step prompt and only persist the captured value.

## Step 2.6 — Execution-strategy resolution

Mandatory before Phase 3 + Phase 5. Resolved exactly once per workflow and persisted at `config.executionStrategy`. **NEVER append a workflow step named EXECUTION_STRATEGY** — `workflow-schema.md §3` rejects that name. The strategy is config, not a step.

Resolve in this order:

1. **Inherited** — if `browzer workflow get-config executionStrategy --workflow "$WORKFLOW" --no-lock` returns a non-empty value, keep it.
2. **Probe the agent-teams flag**:

   ```bash
   TEAMS_FLAG=$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' ~/.claude/settings.json 2>/dev/null)
   ```

3. **Prompt the operator before Phase 3 dispatch** — fires regardless of `config.mode` (the strategy is an operational/cost decision, not a flow decision). **SKIP this prompt when the answer was already captured by the Step 0 batched `AskUserQuestion`**; in that case, jump directly to Persist (§4):

   ```
   AskUserQuestion (header: "Execution"):
     How should TASK steps execute?
       (a) serial               — one task at a time, no isolation
       (b) parallel-worktrees   — disjoint-file groups in git worktrees, N agents in one turn
       (c) agent-teams          — Claude Code Agent Teams (round-table dialogue)  [only when TEAMS_FLAG=="1"]
   ```

   When `TEAMS_FLAG != "1"`, omit option (c). The choice in `code-review` Phase 3 (parallel-with-consolidator vs agent-teams) is a SEPARATE prompt with its own surface — both fire when teams is enabled.

4. **Persist** the chosen value:

   ```bash
   browzer workflow set-config --await executionStrategy "$STRATEGY" --workflow "$WORKFLOW"
   ```

5. **Route Phase 3** dispatch on the value:
   - `serial` → invoke `execute-task` once per TASK step in tasksOrder.
   - `parallel-worktrees` → follow `references/parallel-dispatch.md` (N `Agent(...)` calls in one turn).
   - `agent-teams` → invoke `execute-with-teams` (single Skill call; the skill spawns the team).

If the flag is unset and the operator answer is freeform (e.g. "do whatever's fastest"), normalize to `serial` and record under `.config.executionStrategyNote`.

## Step 2.7 — Test-execution depth resolution

Mandatory before Phase 4 + Phase 8. The second config field that downstream skills (`code-review`'s regression-tester, `feature-acceptance`'s execution-required AC gate) read to decide whether to actually run integration / e2e suites or treat them as out-of-scope for the orchestrator turn. Resolving it once here keeps each downstream skill from re-prompting and avoids the "skills declared COMPLETED but CI surfaces 6 follow-up bugs" failure mode.

**Heuristic — only fire when the repo HAS integration / e2e suites.** Skip the prompt entirely on repos with unit-tests only — there's nothing the depth field would change.

```bash
# Detect integration / e2e test files in the repo (cap depth + count for speed)
HAS_INTEGRATION=$(find . -type f \( -name '*.integration.test.*' -o -name '*.integration.spec.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)
HAS_E2E=$(find . -type f \( -name '*.e2e.test.*' -o -name '*.e2e.spec.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)

if [ -z "$HAS_INTEGRATION" ] && [ -z "$HAS_E2E" ]; then
  # Repo has only unit tests; default and skip prompt
  browzer workflow set-config --await testExecutionDepth "static-only" --workflow "$WORKFLOW"
  browzer workflow set-config --await testExecutionDepthAuto "true" --workflow "$WORKFLOW"
else
  # Resolve via inheritance → prompt
  CURRENT=$(browzer workflow get-config testExecutionDepth --workflow "$WORKFLOW" 2>/dev/null || true)
  if [ -z "$CURRENT" ]; then
    # SKIP this AskUserQuestion when the answer was already captured by the
    # Step 0 batched prompt; in that case, jump directly to set-config below
    # using the value resolved at Step 0.
    AskUserQuestion (header: "Test-exec depth"):
      How deep should code-review and feature-acceptance run tests?
        (a) static-only       — lint + typecheck + unit only (fastest; CI catches the rest)
        (b) scoped-execute    — also run integration/e2e suites for newly added test files
        (c) full-rehearse     — run the entire test pipeline (lint + typecheck + unit + integration + e2e)
    browzer workflow set-config --await testExecutionDepth "$DEPTH" --workflow "$WORKFLOW"
    browzer workflow set-config --await testExecutionDepthAuto "false" --workflow "$WORKFLOW"
  fi
fi
```

The chosen value is read by:
- `code-review/references/regression-tester.md §Phase 5.1` to decide whether to augment the gate command with `pnpm test:integration` / `pnpm test:e2e`.
- `feature-acceptance/references/live-verify.md §Phase 2.6.2` to decide whether execution-required ACs can be locally verified or must defer with `kind: blocks-commit`.

The autonomous-mode auto-default is `static-only` (matches the historical baseline). The prompt only fires in interactive sessions where the repo actually has integration / e2e suites that would be skipped under static-only.
