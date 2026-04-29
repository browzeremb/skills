# Parallel Dispatch — orchestrate-task-delivery

Worktree rendezvous protocol and parallel-dispatch heuristic table. Load when `tasksManifest.parallelizable[][]` fires or `receiving-code-review` dispatches across disjoint-file groups.

## Heuristic — when worktree-isolated parallel beats sequential

Worktree isolation costs ~30s of setup per branch (clone, install, baseline). Use parallel ONLY when at least ONE of the following holds for the `parallelizable[]` group:

- **≥ 3 tasks** in the group — wall-time amortizes the setup overhead.
- **≥ 15 in-scope files** total across the group — each task is non-trivial enough to dominate the setup cost.
- **≥ 1 task expected to run longer than ~30s** of agent work (long test suites, multi-package refactors, anything calling `pnpm turbo lint typecheck test`).
- **Pure-removal carve-out (mirrors `generate-task` Rule 7b):** ≥ 2 pure-removal tasks (deletion-only, no surviving glue beyond i18n keys, route tables, constants) AND combined deletions exceed 1000 LoC.

For groups smaller than this threshold (e.g. 2 disjoint tasks of ≤5 files each), prefer **sequential** Skill invocations. Document the choice in `tasksManifest.parallelStrategy`:

```
"worktrees" | "sequential" | "sequential (under heuristic threshold)" | "worktrees (pure-removal carve-out)"
```

## Worktree rendezvous protocol

When `tasksManifest.parallelizable[][]` fires (and meets the heuristic), or `receiving-code-review` dispatches across disjoint-file groups, follow the four-step claim → isolate → merge → freeze protocol:

### Step 1 — Pre-dispatch claim

Main worktree marks each step's `owner` and flips `status: "RUNNING"` before dispatching:

```bash
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" --arg owner "worktree-$N" \
  '(.steps[] | select(.stepId==$id)) |= (.owner = $owner | .status = "RUNNING")'
```

### Step 2 — In-worktree isolation

Each subagent operates ONLY on steps it owns — determined by reading `.owner` from the step. Never touches another worktree's slice. Dispatch with `isolation: "worktree"` mandatory when agents touch overlapping files or shared config.

```
Agent(
  model: "$SUGGESTED_MODEL",
  prompt: "...",
  isolation: "worktree"
)
```

#### Step 2.1 — Gitignored feat-dir (workflow.json not in worktree checkouts)

`docs/browzer/feat-*` is gitignored in this repo (verify with `git check-ignore docs/browzer/feat-x/workflow.json`). When a worktree is created with `git worktree add`, the new checkout has NO `workflow.json` because gitignored files are not propagated. Subagents cannot `Read $FEAT_DIR/workflow.json` from inside the worktree — the file does not exist there.

Two routes work; pick by failure mode you want to avoid:

| Route                                      | When to use                                                                 | Tradeoff                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **A. Inline the task spec into the prompt** | `tasksManifest.parallelizable[][]` group + worktree isolation required (overlapping files / shared config). | Loses the workflow-as-canonical-state contract for that dispatch round. Agent sees a snapshot, can't `browzer workflow get-step`. Mitigate by passing the rendered context bundle (`browzer workflow get-step <id> --render task-context` from the main worktree) as inline prompt body. |
| **B. Skip worktree isolation**             | The `parallelizable[][]` group has truly disjoint files AND no shared config touch. | Agents read/write the same checkout; race risk if scopes leak. Validate disjoint-ness via `browzer deps --reverse` BEFORE dispatch — if any reverse-dep set overlaps across groups, fall back to A or serialize. |

The dispatcher MUST decide once per dispatch round and record in `tasksManifest.parallelStrategy`:

```jsonc
{
  "mode": "worktree-isolated" | "shared-checkout-disjoint" | "serial",
  "rationale": "<one line>",
  "workflowAccess": "rendered-bundle" | "live"
}
```

`workflowAccess: "rendered-bundle"` means the agent receives a frozen snapshot in its prompt and CANNOT do live workflow.json mutations from inside the worktree — main-worktree rendezvous (Step 3) is responsible for the patch-back. `workflowAccess: "live"` is only valid in route B (shared checkout, no `.tmp` race).

A future option (track-the-feat-dir) would un-ignore `docs/browzer/feat-*/workflow.json` so worktrees inherit it; not done today because the file is high-churn and would bloat git history.

### Step 3 — Rendezvous

After all parallel agents return, main worktree patches each owned step back via `jq | mv` (replacement, not merge):

```bash
RESULT_JSON="$AGENT_EXECUTION_JSON"
jq --arg id "$STEP_ID" --argjson result "$RESULT_JSON" \
  '(.steps[] | select(.stepId==$id)) |= . + $result' \
  "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Owner-string convention: `"worktree-1"`, `"worktree-2"`, etc. — monotonically increasing per dispatch round. Two dispatch rounds in the same pipeline get different prefixes: `"rcr-worktree-1"` for receiving-code-review dispatches.

### Step 4 — Freeze completed steps

Completed steps are immutable. Re-runs require an explicit `retryCount` bump:

```bash
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" \
  '(.steps[] | select(.stepId==$id)).retryCount += 1'
```

## Failure modes

| Failure | Recovery |
|---------|----------|
| One worktree fails, others succeed | Patch the failed step to `STOPPED`; leave successful steps as `COMPLETED`. Hint: re-dispatch the failed step standalone. |
| Merge conflict after rendezvous | Indicates the isolation: "worktree" was missing OR the file sets weren't truly disjoint. Fix: re-serialize the affected tasks. |
| `.tmp` file left over | Safe to delete. Run `find "$FEAT_DIR" -name 'workflow.json.tmp' -delete` on re-entry. |
| Owner string collision | Two rounds claimed the same owner string. Guard: check existing owners before claiming — use `jq '[.steps[].owner] | unique'` to audit before dispatch. |

## Sequential flows

Sequential flows skip this entirely — the worktree setup cost is never paid. Use serial Skill invocations for:

- Single-domain work.
- Task groups below the heuristic threshold.
- Any flow where domain output is needed as context by the next domain.
