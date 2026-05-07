# Operational-audit pass — Step 2.5 (between Explorer and Reviewer)

Cheap haiku pass that verifies every path the Explorer wrote into `task.scope[]` AND every function the PRD's `acceptanceCriteria[].verificationQuery` cites actually exists on disk. Purpose: kill the **filename-hallucination** failure class without spending Reviewer-pass budget rediscovering the same fact.

Triggered by `generate-task/SKILL.md §Step 2.5`. Runs only when Step 2 (Explorer) emitted at least one TASK step.

## Why this pass exists (failure mode it closes)

LLM-driven Explorer passes occasionally write `task.scope[]` paths that do not exist on disk — typo'd basenames, paraphrased filenames, or files merged before the index was current. Each hallucinated path costs multiple downstream roundtrips: the `execute-task` specialist tries to Read the file, fails, retries, and finally surfaces the path error to the operator. A grounded audit pass at task-decomposition time costs ~2-3k haiku tokens and avoids the entire class.

## Inputs (passed from generate-task body)

- `WORKFLOW` — workflow.json path.
- `FEAT_DIR` — feature dir; `$FEAT_DIR/.prd.json` is the PRD payload.
- The list of TASK steps Explorer just wrote.

## Per-task validation steps

For every TASK step, for every path P in `task.scope[]`:

1. `ls "$P"` (best-effort): if the command exits non-zero, the path does not exist.
   → Record violation: `slice-validation-failed: <path> (no such file)`.
2. `browzer explore "$(basename "$P" | sed 's/\..*$//')" --json --save /tmp/<feat>/.audit-explore-<basename>.json --quiet`: if the receipts contain zero hits, the path was never indexed and is suspect.
   → Record violation: `slice-validation-failed: <path> (basename not indexed; suggest sibling: <closest-real-path>)`.
3. For every function name F cited in the AC's `verificationQuery` whose `boundFile` claims P: `grep -nE "func ${F}|function ${F}|${F}\\(" "$P"`; zero matches means the AC binds to a function the path doesn't actually contain.
   → Record violation: `slice-validation-failed: <path> (AC <id> binds function <F> not found in this file)`.

If a closest-real-path suggestion is available (matching basename within Browzer's index; pick the highest-scoring `explore` hit by symbol distance), include it in the violation. Otherwise omit.

## Output shape

If zero violations:

```
generate-task operational-audit: 0 violations across N tasks; proceeding to Reviewer-pass
```

If any violations:

```
generate-task: stopped at STEP_<NN>_<TASK_ID> — slice-validation-failed: <first violating path>
hint: Reviewer-pass should drop or correct these scope entries before proceeding
  - <task-id>: <violation 1>
  - <task-id>: <violation 2>
  ...
```

The skill exits at the first STOP line — Reviewer-pass owns correction. The bullet list is the operator's actionable diff.

## Cost envelope

- ~7 paths per task × ~11 tasks = ~77 file-existence probes; `ls` is sub-millisecond locally.
- ~4 explore probes per task that survive the `ls` check (~30 total); each `browzer explore --save --quiet` is ~50-150ms.
- ~5 grep probes per AC × ~8 ACs = ~40 greps; sub-millisecond.

Total: ~3-5 seconds wall-clock, ~2-3k haiku tokens for the dispatch prompt itself. Far cheaper than even one downstream slice-error roundtrip.

## Non-goals

- Does NOT validate import correctness or build success — that's `code-review` + `write-tests`.
- Does NOT propose new `task.scope[]` paths — that's Reviewer-pass.
- Does NOT mutate any workflow.json field; output is purely a STOP-or-pass signal.
