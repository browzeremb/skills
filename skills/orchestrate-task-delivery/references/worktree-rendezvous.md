# Worktree rendezvous protocol

How `orchestrate-task-delivery` claims, isolates, and merges parallel subagent work in `workflow.json`. Read this only when you actually fire a parallel dispatch — sequential flows never enter this protocol.

Triggers for entering the protocol:

- `tasksManifest.parallelizable[][]` has at least one group, AND that group meets the heuristic in SKILL.md §"Heuristic — when worktree-isolated parallel beats sequential" (≥3 tasks OR ≥15 files OR ≥1 task >30s).
- `receiving-code-review` dispatches across disjoint-file finding groups concurrently.

## 1. Pre-dispatch (main worktree)

For each parallel subagent, claim ownership on the steps it will write:

```bash
jq --arg id "STEP_04_TASK_01" --arg owner "worktree-TASK_01" \
   '(.steps[] | select(.stepId==$id)) |= (.owner = $owner | .status = "RUNNING")' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Repeat per subagent. Owners are short, stable strings (`worktree-TASK_NN` or `worktree-fix-FN`).

## 2. In-worktree

Each worktree operates only on steps where `owner == <its owner string>`. Subagent prompts MUST include a jq filter that asserts this — otherwise two worktrees can race on the same step.

The subagent reads/writes its own `<worktree>/<workflow.json relative path>`, never the main worktree's copy.

## 3. Rendezvous (after all subagents return)

Merge each worktree's owned step(s) back into the main `workflow.json`:

```bash
for WT in "${WORKTREES[@]}"; do
  OWNED=$(jq -c --arg owner "$WT" '.steps[] | select(.owner==$owner)' "$WT/$WORKFLOW_REL")
  echo "$OWNED" | while read -r STEP; do
    SID=$(echo "$STEP" | jq -r '.stepId')
    jq --argjson step "$STEP" --arg sid "$SID" \
       '(.steps[] | select(.stepId==$sid)) = $step' \
       "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
  done
done
```

This is patch-based: each worktree's step replaces (not merges) the main copy. Concurrent worktrees touching disjoint steps cannot collide.

## 4. Completed → immutable

Once a step hits `status: "COMPLETED"`, subsequent writes to it MUST bump `retryCount` and reset `status` explicitly. Silent overwrites of a completed step are a protocol violation — any skill that needs to re-run a step after completion treats it as a new dispatch with a fresh owner.

## Failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Two worktrees both think they own a step | Forgot the pre-dispatch claim, OR claimed but didn't propagate `owner` into the subagent prompt | Re-run pre-dispatch claim; rebuild the subagent prompt |
| Step missing from main `workflow.json` after rendezvous | Worktree path resolution wrong | Check `$WORKFLOW_REL` — must be `docs/browzer/<feat>/workflow.json` from the worktree root, not absolute |
| Step came back with `owner: null` | Subagent edited the step via `Read`/`Write` instead of `jq | mv` | Reject the result; re-dispatch with the explicit jq snippet from `references/subagent-preamble.md` |
| Rendezvous overwrites operator manual edits | Operator edited a `COMPLETED` step in the main worktree mid-dispatch | Don't do that — the rendezvous merge is patch-based and will lose the manual edit. Revert the manual edit, let the dispatch finish, then edit |
