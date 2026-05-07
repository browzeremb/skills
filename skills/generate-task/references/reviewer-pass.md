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
     files). Record additionalContext using the **canonical structured shape**
     consumed by `browzer workflow reapply-additional-context` (apply.go:1011).
     The shape is enforced by the CUE schema (#TaskReviewer.additionalContext
     accepts string OR #AdditionalContextObj):
       additionalContext: {
         changes: [
           // kind == "corrected": rewrites scope entry from→to
           { kind: 'corrected', from: 'src/old.ts', to: 'src/new.ts', reason: '...' },
           // kind == "added": appends path (or `to` as fallback) to scope
           { kind: 'added',     path: 'src/helper.ts',                reason: '...' },
           // kind == "dropped": removes path (or `from` as fallback) from scope
           { kind: 'dropped',   path: 'src/legacy.ts',                reason: '...' },
           // kind == "rename-domain": rewrites task.explorer.domains[] AND
           // task.explorer.skillsFound[].domain when the Explorer typo'd a
           // domain string. Use this instead of out-of-band jq surgery on
           // the staged JSON.
           { kind: 'rename-domain', from: 'fastapi-backend', to: 'fastify-backend', reason: '...' }
         ]
       }
     Field-name discipline: use `kind` (not `action`), `from`/`to`/`path` (not `file`/`oldFile`).
     The reapply mutator silently NoOps any change whose kind/fields don't match this contract.
  3. Enumerate green-test specs that satisfy the task's AC + invariants.
     `intent` is the semantic stage of the red→green→refactor loop;
     `scope` is the testing layer the spec belongs to. The legacy `type`
     field is rejected by the schema:
       { testId: 'T-N',
         file: 'path/__tests__/xyz.test.ts',
         intent: 'green',                          // 'green' | 'red' | 'chaos'
         scope: 'unit',                            // 'unit' | 'integration' | 'e2e' | 'chaos'
         description: '...',
         coverageTarget: '...' }
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
# `browzer workflow patch` requires single-token `--arg name=value` /
# `--argjson name=value` (cobra parser semantic). Space-separated jq-native
# `--arg name value` is REJECTED — the second token is consumed as a
# positional and produces `unknown command "<value>"`.
browzer workflow patch --workflow "$WORKFLOW" \
  --arg "id=$STEP_ID" --argjson "reviewer=$REVIEWER_JSON" \
  --jq '(.steps[] | select(.stepId==$id)).task.reviewer = $reviewer'
```

## Banned dispatch-prompt patterns (Reviewer)

Do NOT include in the Reviewer prompt:
- Instructions to write actual code or tests.
- "Invent file paths" — use Explorer's mapping as the baseline; only adjust with `browzer read` evidence.
- Requests to bypass `additionalContext.changes` shape — it is load-bearing for Step 7.5.

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

`task.acceptanceCriteria[].bindsTo[]` MUST reference IDs that exist in
`PRD.acceptanceCriteria[].id` — the CUE schema enforces the regex
`^AC-[0-9]+$` (see `packages/cli/schemas/workflow-v1.cue` `#TaskAC.bindsTo`).
Earlier versions of this validator collected FR-N + NFR-N IDs as the
universe, which produced a guaranteed false-positive on every valid run
(no AC-N would ever appear in an FR-N / NFR-N set). Fixed 2026-05-06.

```bash
SBN=$(browzer workflow query steps-by-name --workflow "$WORKFLOW")
PRD_IDS=$(echo "$SBN" | jq -r '.PRD[]? | .prd.acceptanceCriteria[].id' | sort -u)
TASK_BINDINGS=$(echo "$SBN" | jq -r '.TASK[]? | .task.acceptanceCriteria[].bindsTo[]?' | sort -u)
UNRESOLVED=$(comm -23 <(echo "$TASK_BINDINGS") <(echo "$PRD_IDS"))
[ -n "$UNRESOLVED" ] && {
  echo "STOP: task acceptanceCriteria.bindsTo references nonexistent PRD acceptance-criteria IDs: $UNRESOLVED"
  exit 1
}
```

### AC ↔ scope call-graph validator (STOP — not a warning)

For every `task.acceptanceCriteria[]` entry: the AC binds to one or more PRD acceptance criteria via `bindsTo[]`, and each PRD AC carries a `verificationQuery` whose primary symbol is the function (or method) the AC asserts behaviour about. The task that owns this AC MUST have `task.scope[]` reach the file containing that function — either directly (the file IS in scope) or transitively (a file in scope imports the file containing the function).

```bash
# For each task with acceptanceCriteria[]:
for AC_ID in $(echo "$TASK_ACS" | jq -r '.[].id'); do
  AC_FILE=$(echo "$PRD_ACS" | jq -r --arg id "$AC_ID" '.[] | select(.id==$id) | .verificationQuery.boundFile // empty')
  [ -z "$AC_FILE" ] && continue
  browzer deps "$AC_FILE" --reverse --json --save "/tmp/<feat>/.deps-${AC_ID}.json" --quiet
  IMPORTERS=$(jq -r '.importedBy[]?' "/tmp/<feat>/.deps-${AC_ID}.json")
  # Pass if AC_FILE itself is in scope OR any importer is in scope.
  HIT=$(echo "$TASK_SCOPE" | jq -r --arg f "$AC_FILE" --arg list "$IMPORTERS" '
    . as $scope | ($list|split("\n")) as $imp |
    if ($scope|index($f)) or ([$scope[] | select(. as $s | $imp|index($s))]|length>0)
    then "ok" else "miss" end')
  [ "$HIT" = "miss" ] && {
    echo "STOP: scope-incomplete-for-AC $AC_ID — bound function lives in $AC_FILE; no scope file is $AC_FILE nor imports it"
    exit 1
  }
done
```

If the AC's `verificationQuery.boundFile` is absent (the PRD writer left it implicit), skip this AC's check rather than guess — Reviewer surfaces the missing binding via additionalContext for the next iteration to fill in.

### Tiered thresholds (reject whole set if tripped)

- [ ] Total files ≥ 15 AND median files-per-task < 10 AND < 50% `trivial: true` → Rule 8 under-applied.
- [ ] Total files ≥ 45 AND median < 15 → consolidate further.
- [ ] **Total tasks ≥ 4** AND > 30% carry `trivial: true` → surface to operator (skip when `totalTasks < 4`).

## Step 7.5 — Re-apply Reviewer corrections to task.scope

Run this BEFORE Step 8 emit. Without it, the Reviewer's corrections are stranded in `additionalContext.changes` while `task.scope` retains the wrong Explorer paths.

Use the dedicated mutator `browzer workflow reapply-additional-context` — DO NOT hand-roll a `patch --jq` snippet. The mutator (apply.go:1011) is idempotent, validates each change's `kind` against the canonical contract, and silently NoOps changes whose fields don't match. Hand-rolled jq paths historically diverged from the mutator's vocabulary (the doc once used `action`/`file`/`oldFile`; the mutator uses `kind`/`from`/`to`/`path`) — drift WF-SYNC-2 closed by routing all callers through the verb.

```bash
TASK_STEPS=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" | jq -r '.TASK[]?.stepId')

for STEP_ID in $TASK_STEPS; do
  browzer workflow reapply-additional-context "$STEP_ID" --await --workflow "$WORKFLOW"
  # Idempotent: empty additionalContext OR `changes: []` → no-op audit + exit 0.
done
```

**Canonical shape of `additionalContext.changes[]`** (matches `#FileChange` in `workflow-v1.cue` and the mutator branches in `apply.go::mutatorReapplyAdditionalContext`):

```jsonc
// kind: "corrected" — rewrites a scope entry from `from` to `to`.
{ "kind": "corrected", "from": "<old-path>", "to": "<new-path>", "reason": "<why>" }

// kind: "added" — appends `path` to scope (idempotent; skipped if already present).
//                 Fallback: if `path` is absent, the mutator reads `to` as the path.
{ "kind": "added", "path": "<path>", "reason": "<why>" }

// kind: "dropped" — removes `path` from scope.
//                   Fallback: if `path` is absent, the mutator reads `from`.
{ "kind": "dropped", "path": "<path>", "reason": "<why>" }

// kind: "rename-domain" — rewrites every matching entry in
// task.explorer.domains[] AND every entry in task.explorer.skillsFound[].domain.
// Idempotent (dedupes on rewrite). Use when the Reviewer caught a domain-string
// typo (e.g. `fastapi-backend` for a Fastify project) instead of jq-surgery on
// the staged JSON.
{ "kind": "rename-domain", "from": "<wrong-domain>", "to": "<right-domain>", "reason": "<why>" }
```
