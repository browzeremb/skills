# Reviewer pass — Steps 3, 5, 7, 7.5 of generate-task

## Step 3 — Dispatch (sonnet default, opus for complex, haiku for pure-docs)

Model selection per task:
- **sonnet** (default).
- **opus** for multi-service / multi-invariant / novel-uncertainty tasks.
- **haiku** for pure-docs-or-fixture tasks.

Choose per task (batch or one dispatch per task — use judgment on batch cost).

```
Agent(
  model: "<sonnet|opus|haiku per task complexity>",
  prompt: "<subagent-preamble verbatim>

  You are the Reviewer. For each task the Explorer produced:
  1. Read each file in explorer.filesToRead via `browzer read` or Read.
  2. Validate/correct Explorer's file mapping (drop false positives, add missed
     files). Record additionalContext about what you changed and why. Use this shape:
       additionalContext: {
         changes: [
           { file: 'path/to/file.ts', action: 'corrected' | 'added' | 'dropped', reason: '...' }
         ]
       }
  3. Enumerate green-test specs that satisfy the task's AC + invariants. Each spec:
       { testId: 'T-N', file: 'path/__tests__/xyz.test.ts',
         type: 'green', description: '...', coverageTarget: '...' }
     Tests are authored AFTER code-review + receiving-code-review by write-tests.
     Bind at least one green spec to every AC.

  Output ONE JSON per task matching `task.reviewer` shape in references/workflow-schema.md §4.

  Per-task input: <task stepId, explorer payload, PRD AC + NFR entries bound to this task>
  ",
  isolation: "none"
)
```

Write each task's `reviewer` payload via CLI:

```bash
REVIEWER_JSON='<reviewer JSON for this task>'
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" --argjson reviewer "$REVIEWER_JSON" \
  '(.steps[] | select(.stepId==$id)).task.reviewer = $reviewer'
```

## Banned dispatch-prompt patterns (Reviewer)

Do NOT include in the Reviewer prompt:
- Instructions to write actual code or tests.
- "Invent file paths" — use Explorer's mapping as the baseline; only adjust with `browzer read` evidence.
- Requests to bypass `additionalContext.changes` shape — it is load-bearing for Step 7.5.

---

## Step 5 — Grouping rules

The Explorer's task boundaries should honor these rules. The Reviewer re-validates.

**Rule 1 — Layer order.** Lower layers ship before higher consumers: shared → contracts → data → core → api → workers → client → tests → observability+docs → edge.

**Rule 2 — ~30-file soft cap per task.** Split at layer boundaries when exceeded.

**Rule 3 — Orphan-free.** A new symbol ships with its first consumer (or an earlier task a later task explicitly depends on).

**Rule 4 — Merge-safe on main.** Each task, merged in order, leaves the repo runnable.

**Rule 5 — Forward dependencies only.** Task N depends only on tasks with index < N.

**Rule 6 — Repo invariants as constraints.** Every "must"/"never"/"always"/"invariant" surfaced by browzer (or fallback reads of CLAUDE.md / AGENTS.md) is stored in `task.invariants[]` with `rule` + `source`.

**Rule 7 — Delivered value per task.** Each task ends demoable (passing test, curl, rendered page behind flag).

**Rule 7a — Worktree-isolated parallel** kicks in at ≥3 tasks AND ≥15 in-scope files OR any task is estimated >~30s wall-clock.

**Rule 7b — Pure-removal carve-out.** When ≥2 pure-removal tasks AND combined deletions exceed 1000 LoC, prefer worktree-isolated parallel even below Rule 7a threshold. Record reason on `tasksManifest.parallelStrategy`.

**Rule 8 — Merging is the default; splitting requires justification.** Target median files-per-task ≥ 10 (preferred ≥ 15 for PRDs with ≥15 files). Split-preserving conditions: (a) incompatible invariants, (b) different `suggestedModel` tier, (c) opposite reversibility profiles, (d) would exceed the ~30-file cap. Cross-layer merges require a feature-flag gate in `task.invariants[]`.

**Trivial flag** (`task.trivial: true`): valid only when scope is ≤ 3 files, single layer, single package, no cross-invariant, deterministic outcome. Never for authz, billing, migrations, or any invariant-bearing file.

---

## Step 7 — Validators before emitting

Run all of these. Fix in place before emitting. If cannot fix without losing scope, ask the operator.

### Structural checks (STOP if any fail)

- [ ] STEP_03_TASKS_MANIFEST exists and is COMPLETED.
- [ ] Every task step has `task.explorer` AND `task.reviewer` populated.
- [ ] No file path appears in more than one task's `task.scope`.
- [ ] Every `task.dependsOn` entry references a task that appears earlier in `tasksOrder`.
- [ ] Every task has at least one green test spec under `task.reviewer.testSpecs[]` bound to every AC (or an explicit `task.reviewer.skipTestsReason`).
- [ ] Layer order holds (no consumer before producer).

### bindsTo validator (STOP — not a warning)

```bash
PRD_IDS=$(jq -r '.steps[] | select(.name=="PRD") | (.prd.functionalRequirements[].id, .prd.nonFunctionalRequirements[].id)' "$WORKFLOW" | sort -u)
TASK_BINDINGS=$(jq -r '.steps[] | select(.name=="TASK") | .task.acceptanceCriteria[].bindsTo[]?' "$WORKFLOW" | sort -u)
UNRESOLVED=$(comm -23 <(echo "$TASK_BINDINGS") <(echo "$PRD_IDS"))
[ -n "$UNRESOLVED" ] && {
  echo "STOP: task acceptanceCriteria.bindsTo references nonexistent PRD IDs: $UNRESOLVED"
  exit 1
}
```

### Tiered thresholds (reject whole set if tripped)

- [ ] Total files ≥ 15 AND median files-per-task < 10 AND < 50% `trivial: true` → Rule 8 under-applied.
- [ ] Total files ≥ 45 AND median < 15 → consolidate further.
- [ ] **Total tasks ≥ 4** AND > 30% carry `trivial: true` → surface to operator (skip when `totalTasks < 4`).

---

## Step 7.5 — Re-apply Reviewer corrections to task.scope

Run this BEFORE Step 8 emit. Without it, the Reviewer's corrections are stranded in `additionalContext.changes` while `task.scope` retains the wrong Explorer paths.

```bash
# For each task step, walk additionalContext.changes and patch task.scope:
TASK_STEPS=$(jq -r '.steps[] | select(.name=="TASK") | .stepId' "$WORKFLOW")

for STEP_ID in $TASK_STEPS; do
  CHANGES=$(browzer workflow get-step "$STEP_ID" --field task.reviewer.additionalContext.changes --workflow "$WORKFLOW" 2>/dev/null || echo "[]")

  if [ "$CHANGES" = "[]" ] || [ -z "$CHANGES" ]; then
    continue
  fi

  # Apply each change to task.scope:
  # - corrected: replace the old path with the corrected path in scope
  # - added:     append the file to scope if not already present
  # - dropped:   remove the file from scope
  browzer workflow patch --await --workflow "$WORKFLOW" --jq \
    --arg id "$STEP_ID" \
    --argjson changes "$CHANGES" \
    '(.steps[] | select(.stepId == $id)) |= (
       . as $step |
       reduce $changes[] as $c (
         $step;
         if $c.action == "corrected" then
           .task.scope = [.task.scope[] | if . == $c.oldFile then $c.file else . end]
         elif $c.action == "added" then
           if (.task.scope | map(. == $c.file) | any) then .
           else .task.scope = (.task.scope + [$c.file]) end
         elif $c.action == "dropped" then
           .task.scope = [.task.scope[] | select(. != $c.file)]
         else . end
       )
     )'
done
```

**Shape of `additionalContext.changes[]`:**

```jsonc
{
  "file": "apps/api/src/routes/new-route.ts",   // corrected/added path
  "oldFile": "apps/api/src/routes/old.ts",       // present only for action=="corrected"
  "action": "corrected" | "added" | "dropped",
  "reason": "Explorer had the wrong file; read confirmed the real path"
}
```
