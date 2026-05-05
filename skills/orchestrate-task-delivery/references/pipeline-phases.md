# Pipeline Phases — orchestrate-task-delivery

Detailed phase-by-phase descriptions for the 10-phase delivery pipeline (Phases 0–9). Load when executing or validating a specific phase.

## Workflow CLI — verbs disponíveis

Every mutation to `workflow.json` MUST go through `browzer workflow <verb>`. Raw `jq … > .tmp && mv` is deprecated. The CLI validates against the CUE SSOT post-mutation; an invalid payload exits non-zero before any bytes hit disk.

**Mutator verbs** (acquire advisory lock + validate post-mutation; emit stderr audit `verb=… stepId=… elapsedMs=…`):

| Verb | Use |
|---|---|
| `append-step` (stdin payload) | Add a new step (PRD, TASK, COMMIT, …). |
| `update-step <stepId>` | Replace fields on an existing step. |
| `complete-step <stepId>` | Mark step COMPLETED + auto-stamp `elapsedMin` + roll up `totalElapsedMin`. |
| `set-status <stepId> <status>` | Drive the lifecycle FSM (PENDING → RUNNING → AWAITING_REVIEW → COMPLETED/SKIPPED/STOPPED/FAILED). |
| `set-config <key> <value>` | Mutate top-level `config.{mode,executionStrategy,…}`. |
| `set-current-step <stepId>` | Set `currentStepId` + write the `.browzer/active-step` cache. |
| `append-review-history <stepId>` (stdin payload) | Append a `reviewHistory[]` exchange (review-mode). |
| `append-dispatch <stepId> --prompt-file <path>` | Spool a dispatch prompt to `.browzer/dispatch-spool/` + record digest in `dispatches[]`. |
| `audit-model-override <stepId> <from> <to> <reason>` | Record a model-tier override under `task.execution.modelOverride`. |
| `truncation-audit <stepId> --last-checkpoint <s>` | Record a suspected mid-stream truncation. |
| `reapply-additional-context <stepId>` | Walk `task.reviewer.additionalContext.changes[]` into `task.scope`. |
| `patch --jq '<expr>'` | Generic jq mutation — escape hatch when no semantic verb fits. Honors `--arg KEY=VALUE` / `--argjson KEY=<json>` (repeatable). |

**Read verbs** (no mutation, no lock):

| Verb | Use |
|---|---|
| `get-step <stepId> [--field <jq-path>] [--render <template>] [--bash-vars] [--save <path>] [--quiet]` | Fetch one step. `--render` emits prompt-embed text for one of 5 templates (`execute-task`, `code-review`, `brainstorming`, `update-docs`, `generate-task`). `--bash-vars` emits `KEY=value` lines for `eval`. `--save + --quiet` writes to file with zero stdout. |
| `get-config <key>` | Fetch top-level config keys (`mode`, `currentStepId`, …). |
| `validate` | Structural CUE check; non-zero exit on schema violations. |
| `schema [--json-schema] [--field <path>]` | Emit Draft 2020-12 JSON Schema (or markdown summary) of the workflow shape. |
| `query <named>` | Pre-baked cross-step aggregations: `reused-gates`, `failed-findings`, `open-deferred-actions`, `task-gates-baseline`, `changed-files`, `deferred-scope-adjustments`, `open-findings`, `next-step-id`, `cache-warm-deps`, `cache-warm-mentions`, `first-step-by-name --arg name=<NAME>`. |
| `describe-step-type <NAME>` | CUE-derived field spec for one step type. |

**Write modes** — every mutating verb honors `--sync` (in-process standalone), `--async` (daemon FIFO, default), `--await` (daemon + fsync). Env `BROWZER_WORKFLOW_MODE=sync|async|await` overrides.

**Quiet modes** — three ways to suppress the per-mutation audit line on stderr (errors and hints still print):

- `--quiet` flag (persistent across the `workflow` command group),
- `BROWZER_WORKFLOW_QUIET=1` env (alternative),
- `BROWZER_LLM=1` or `--llm` (also strips banners + ANSI + spinners; the audit line routes to the SQLite tracker as `workflow-audit:llm-*` so `browzer gain` keeps aggregating).

**There is no `patch step` / `patch <stepId>` verb.** Generic mutations of a step's payload always go through `patch --jq '<expr>'` — for example, `patch --jq '.steps[] |= if .stepId=="STEP_04_TASK_01" then .task.execution.gates.baseline.tests = "pass" else . end'`. Composite verbs like `workflow patch step` do not exist; calling one returns `unknown command "step" for "browzer workflow patch"`.

## Workflow CLI — copy-paste invocations

Canonical literal invocations for every workflow verb. Skills MUST consume these instead of guessing flag shapes — the previous "Use:" tables documented intent without literal flag surface, forcing agents to `--help` each verb. The hook (`packages/skills/hooks/guards/browzer-rewrite-bash.mjs`, WF-SYNC-2) prefixes `BROWZER_LLM=1` on every `browzer …` call automatically; do not add it manually.

Common pattern: every mutator accepts `--workflow <path>`, `--await`, and `--lock-timeout <duration>`. Read verbs accept `--workflow <path>` only.

### init

```bash
browzer workflow init --await --workflow "$WORKFLOW" \
  --feature-id "$FEAT_ID" \
  --feature-name "$FEAT_NAME" \
  --operator-locale "$LOCALE" \
  --original-request "$ORIG_REQ"
# featDir is auto-derived from `--workflow` parent dir; do NOT pass `--feat-dir`.
# Pass `--force` to overwrite an existing seed.
```

### set-config `<key> <value>`

```bash
browzer workflow set-config --await mode "$MODE" --workflow "$WORKFLOW"
# Common keys: mode, executionStrategy, testExecutionDepth, testExecutionDepthAuto.
```

### append-step (stdin payload — preferred)

```bash
echo "$STEP_JSON" | browzer workflow append-step --await --workflow "$WORKFLOW"
# Or with file:  browzer workflow append-step --await --workflow "$WORKFLOW" --payload step.json
# Or with -:     browzer workflow append-step --await --workflow "$WORKFLOW" --payload -
```

### update-step `<stepId>`

```bash
browzer workflow update-step "$STEP_ID" --await --workflow "$WORKFLOW" --payload step.json
```

### complete-step `<stepId>`

```bash
browzer workflow complete-step "$STEP_ID" --await --workflow "$WORKFLOW"
# Auto-stamps elapsedMin + rolls up totalElapsedMin.
```

### set-status `<stepId> <status>`

```bash
browzer workflow set-status "$STEP_ID" RUNNING --await --workflow "$WORKFLOW"
# Status enum: PENDING, RUNNING, AWAITING_REVIEW, COMPLETED, STOPPED,
#              PAUSED_PENDING_OPERATOR, SKIPPED, FAILED.
```

### set-current-step `<stepId>`

```bash
browzer workflow set-current-step "$STEP_ID" --await --workflow "$WORKFLOW"
# Also writes the .browzer/active-step cache (consumed by langfuse_hook.py).
```

### append-review-history `<stepId>`

```bash
echo "$ENTRY_JSON" | browzer workflow append-review-history "$STEP_ID" \
  --await --workflow "$WORKFLOW" --payload -
```

### append-dispatch `<stepId>`

```bash
browzer workflow append-dispatch "$STEP_ID" --await --workflow "$WORKFLOW" --payload prompt.json
# Spools the prompt to .browzer/dispatch-spool/ and records digest in dispatches[].
```

### audit-model-override `<stepId> <fromModel> <toModel> <reason>`

```bash
browzer workflow audit-model-override "$STEP_ID" sonnet opus "scope-large" \
  --await --workflow "$WORKFLOW"
```

### reapply-additional-context `<stepId>`

```bash
browzer workflow reapply-additional-context "$STEP_ID" --await --workflow "$WORKFLOW"
# Walks task.reviewer.additionalContext.changes[] (kind/from/to/path shape) into task.scope.
# Idempotent NoOp when no changes pending.
```

### truncation-audit `<stepId>`

```bash
browzer workflow truncation-audit "$STEP_ID" --await --workflow "$WORKFLOW" --payload audit.json
```

### patch `--jq <expr>`

```bash
# Generic jq mutation — escape hatch when no semantic verb fits.
browzer workflow patch --await --workflow "$WORKFLOW" --jq '<expr>' \
  --arg KEY=VAL --argjson NUM=42
# Bind variables route through gojq's WithVariables (v1.6.0+).
# There is NO `patch step` / `patch <stepId>` subverb.
```

### get-step `<stepId>` (read-only)

```bash
browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW"
# Variants:
#   --field '<jq-path>'   extract one field
#   --render <template>   prompt-embed text (execute-task | code-review | brainstorming | update-docs | generate-task | finding)
#   --bash-vars           emit KEY=value lines (consumable by `eval`)
#   --save <path>         write to disk + emit confirmation
#   --quiet               suppress audit telemetry on success
# --field / --render / --bash-vars are mutually exclusive.
```

### get-config `<key>` (read-only)

```bash
browzer workflow get-config mode --workflow "$WORKFLOW"
# Optional: --save <path> + --quiet for zero-stdout writes.
```

### validate (read-only)

```bash
browzer workflow validate --workflow "$WORKFLOW"
# Optional: --json (emit ValidationResult struct), --since-version <RFC3339>.
```

### schema (read-only)

```bash
browzer workflow schema --workflow "$WORKFLOW"
# Optional: --json-schema (Draft 2020-12 JSON Schema), --field <path>.
```

### query `<named>` (read-only)

```bash
browzer workflow query open-findings --workflow "$WORKFLOW"
# Named registry:
#   reused-gates, failed-findings, open-deferred-actions, task-gates-baseline,
#   changed-files, deferred-scope-adjustments, open-findings, next-step-id,
#   cache-warm-deps, cache-warm-mentions, first-step-by-name --arg name=<NAME>
```

### describe-step-type `<NAME>` (read-only)

```bash
browzer workflow describe-step-type TASK --workflow "$WORKFLOW"
# Returns CUE-derived field spec; canonical reference for required/optional fields.
```

## Daemon — best-effort warm-up

```bash
browzer daemon status >/dev/null 2>&1 || browzer daemon start --background &
# Non-blocking; suppresses `mode=fallback-sync reason=daemon_unreachable` on first mutation.
# Run ONCE at orchestrator entry (Step 0.2).
```

## Phase 0 — Brainstorming (conditional)

Invoke `brainstorming` ONLY when input is vague. Heuristics:

- < 20 words AND no file path, persona, or verb-object pair.
- Starts with "what if" / "could we" / "would it be cool if".
- Names a capability with no success signal ("add X").

Else skip and chain to Phase 1.

## Phase 1 — PRD

`Skill(skill: "generate-prd", args: "feat dir: $FEAT_DIR")`. This skill does NOT auto-chain — the orchestrator drives the next phase.

## Phase 2 — Task manifest + per-task steps

`Skill(skill: "generate-task", args: "feat dir: $FEAT_DIR")`. Produces `STEP_03_TASKS_MANIFEST` + `STEP_04_TASK_01 … STEP_NN_TASK_MM` with Explorer + Reviewer payloads.

## Phase 2.5 — Execution strategy resolution (silent unless multi-domain)

Before dispatching Phase 3, compute the domain partition from the just-written tasksManifest and decide between `serial` (default) and `agent-teams` strategy. The two strategies are **orthogonal** to `config.mode` (autonomous|review): `mode` decides WHEN the operator gates between phases; `executionStrategy` decides HOW Phase 3 dispatches work.

```bash
DOMAINS=$(jq -r '
  [ .steps[]
    | select(.name == "TASK")
    | .task.scope.files[]?
    | split("/")[0:2] | join("/")
  ] | unique
' "$WORKFLOW")
TASK_COUNT=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" | jq '.TASK // [] | length')
DOMAIN_COUNT=$(echo "$DOMAINS" | jq 'length')
```

Decision rules — silent defaults; only ask when team mode is plausibly useful:

- `TASK_COUNT < 2` → `serial` silently. Team overhead with no benefit.
- `DOMAIN_COUNT < 2` → `serial` silently. No domain partition possible.
- `DOMAIN_COUNT ≥ 2` AND `TASK_COUNT ≥ 2` → `AskUserQuestion`:

  ```
  Phase 3 has <TASK_COUNT> tasks across <DOMAIN_COUNT> domain roots:
    <comma-separated domain list>

  Execution strategy:
    (a) serial — current default; per-task execute-task dispatch (sequential
        within tasks; worktree-parallel within tasksManifest.parallelizable[][]
        when the heuristic in Phase 3 fires)
    (b) agent-teams — domain-bound parallel team via TeamCreate + TaskList +
        N specialists (one per domain). Zero merge conflicts when domain
        isolation holds. Saves wall-clock when domains are orthogonal.
  ```

Persist the choice to workflow.json:

```bash
browzer workflow set-config --await executionStrategy "$STRATEGY" --workflow "$WORKFLOW"
browzer workflow set-config --await strategySetAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --workflow "$WORKFLOW"
```

Inheritance: if `.config.executionStrategy` is already set (re-entry mid-flow), keep it. Don't re-prompt.

## Phase 3 — Execute each task

Branch on `.config.executionStrategy`:

- `agent-teams` → `Skill(skill: "execute-with-teams", args: "feat dir: $FEAT_DIR")`. The skill writes `STEP_<NN>_TASK_TEAM_EXEC` with `status: COMPLETED` aggregating per-specialist deliverables; orchestrator's Step 4 reads it as the Phase 3 completion gate and chains directly to Phase 4 (CODE_REVIEW). Skip the rest of Phase 3 below.
- `serial` (or unset for legacy workflows) → continue with the per-task path below.

### Phase 3 — serial path

Read the manifest:

```bash
TM=$(browzer workflow query tasks-manifest --workflow "$WORKFLOW")
TASKS=$(echo "$TM" | jq -r '.tasksOrder[]')
PARALLEL=$(echo "$TM" | jq -c '.parallelizable')
```

For each task in order:

- **Sequential case**: `Skill(skill: "execute-task", args: "TASK_N; feat dir: $FEAT_DIR")`. Wait for COMPLETED before the next.
- **Parallel case**: for each group in `parallelizable[]`, dispatch all tasks in ONE response turn via `Task(..., isolation: "worktree")`. See `references/parallel-dispatch.md` for worktree rendezvous.

**Render the task context, never inline the raw payload.** When the dispatcher passes task context into a parallel-worktree agent (worktree mode loses live `workflow.json` access — see `references/parallel-dispatch.md §Step 2.1`), use the renderer instead of dumping the raw `.task` payload:

```bash
TASK_CONTEXT=$(browzer workflow get-step "$STEP_ID" --render task --workflow "$WORKFLOW")
```

The renderer at `references/renderers/task.jq` emits a compressed prompt-embed text block (scope, invariants, files, AC ids, dependencies). Inlining the raw payload duplicates ~3KB per dispatch and drifts when the operator edits the PRD mid-flow. Adoption metric: `render-template-adoption` should sit at ~100% — the dogfood report's 0% baseline came from dispatchers free-writing the prompt body. Use the renderer.

Trivial-task fast path: if `.task.trivial == true`, `execute-task` uses the ≤15-line integration glue path, skips the test-specialist dispatch, and goes directly to aggregation. The orchestrator still invokes `execute-task` — the fast path lives inside that skill.

## Phase 4 — Code review

After ALL task steps complete, invoke code-review.

In **autonomous mode**, the orchestrator MUST pre-register sensible defaults to skip the dispatch+tier prompts that would otherwise re-prompt operator consent already given at orchestrator entry. Compute:

- `dispatchMode`: `parallel-with-consolidator` (always available regardless of Agent Teams flag).
- `tier`: derive from changed-file count via the same scope formula code-review uses internally — `small` ≤ 3 files, `medium` 4–10 files, `large` ≥ 11 files. Map to the recommended tier: `small` → `recommended`, `medium` → `recommended`, `large` → `recommended`.

Pass them in args:

```
Skill(skill: "code-review", args: "feat dir: $FEAT_DIR; dispatchMode: parallel-with-consolidator; tier: recommended")
```

In **review mode**, omit the pre-registered values so the operator sees the prompts.

Writes `STEP_<NN>_CODE_REVIEW` with `findings[]`.

## Phase 5 — Receiving code review

`Skill(skill: "receiving-code-review", args: "feat dir: $FEAT_DIR")`. Reads `codeReview.findings[]` from the prior `CODE_REVIEW` step and dispatches per-finding fix agents until every finding reaches `status: fixed` (or — after exhausting the 7-iteration ladder — gets logged to `receivingCodeReview.unrecovered[]` AND the repo's tech-debt doc).

Skipping `RECEIVING_CODE_REVIEW` entirely when `codeReview.findings[]` is non-empty is a contract violation.

## Phase 6 — Write tests + mutation testing

Branch on `.config.executionStrategy`:

- `agent-teams` → **SKIP this phase**. Record Phase 6 as a SKIPPED step:

  ```bash
  NN=$(browzer workflow query next-step-id --workflow "$WORKFLOW")
  STEP_ID="STEP_$(printf '%02d' $NN)_WRITE_TESTS"
  TEAM_EXEC_REF=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" | jq -r '[.TASK[]? | select(.taskId=="TEAM_EXEC")][-1].stepId')

  jq -n \
    --arg id "$STEP_ID" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg ref "$TEAM_EXEC_REF" \
    '{
       stepId: $id, name: "WRITE_TESTS", status: "SKIPPED",
       applicability: {
         applicable: false,
         reason: ("rolled into team execution; see " + $ref + ".task.teamExecution.testAndMutation")
       },
       startedAt: $now, completedAt: $now, elapsedMin: 0,
       retryCount: 0, itDependsOn: [$ref], nextStep: "",
       skillsToInvoke: [], skillsInvoked: [],
       owner: null, worktrees: { used: false, worktrees: [] },
       warnings: [], reviewHistory: [], dispatches: [],
       # `#WriteTests` requires `skipped: bool` even when the step is SKIPPED.
       writeTests: {
         skipped: true,
         skipReason: ("rolled into team execution; see " + $ref + ".task.teamExecution.testAndMutation"),
         runner: null,
         filesAuthored: [],
         notes: ""
       }
     }' | browzer workflow append-step --await --workflow "$WORKFLOW"
  ```

  Then chain directly to Phase 7 (UPDATE_DOCS).

- `serial` (or unset for legacy workflows) → `Skill(skill: "write-tests", args: "feat dir: $FEAT_DIR")`. Runs AFTER `receiving-code-review` so tests cover the final state.

  Skipped automatically when the repo carries no test setup — `write-tests`'s detector returns `hasTestSetup: false` and the step is recorded as `SKIPPED` with `applicability.reason: "no test setup detected"`.

## Phase 7 — Update docs

`Skill(skill: "update-docs", args: "feat dir: $FEAT_DIR")`. Uses `browzer mentions` + direct-ref + concept-level signals. Writes `STEP_<NN>_UPDATE_DOCS`.

## Phase 8 — Feature acceptance

`Skill(skill: "feature-acceptance", args: "feat dir: $FEAT_DIR")`. Always prompts autonomous/manual/hybrid (regardless of `config.mode`). Three terminal verdicts:

- `COMPLETED` — all checks verified. Chain to commit.
- `PAUSED_PENDING_OPERATOR` — automated checks passed, but `operatorActionsRequested[]` carries unresolved `kind: "deferred-post-merge"` entries. STILL chain to commit; emit success line with `; ⚠ <N> deferred-post-merge actions pending`.
- `STOPPED` — at least one AC/NFR/metric failed. Stop the chain; hint back to `receiving-code-review` or `execute-task`.

## Phase 9 — Commit

`Skill(skill: "commit", args: "feat dir: $FEAT_DIR")`. Writes `STEP_<NN>_COMMIT` with the SHA. In review mode, `commit` renders `commit.jq` and loops on operator edits before firing the git commit.

### Phase 9 closure narrative — what "completed" actually means

The orchestrator's scope ENDS at the local `git commit`. State (a)–(b) are inside scope;
(c)–(e) are explicitly OUT of scope. The closure line and the operator-facing one-line
summary MUST distinguish these states so "pipeline complete" is not interpreted as "PR
mergeable".

| Stage | Owner | In orchestrator scope? |
| --- | --- | --- |
| (a) Local commit created (SHA stamped, hooks ran via Phase 8.5) | `commit` skill | YES |
| (b) Local pre-push gates passed (audit simulation in Phase 8.5) | `commit` skill | YES |
| (c) `git push` to remote | operator | NO |
| (d) CI pipeline green (remote test runs, integration / e2e on shared infra) | CI | NO |
| (e) PR review + merge | reviewer / merge bot | NO |

Closure line shape (autonomous mode, success):

```
orchestrate-task-delivery: pipeline complete; <N> steps written to workflow.json; SHA <sha> ready for operator-driven push
```

Closure line shape (autonomous mode, paused-pending-operator):

```
orchestrate-task-delivery: pipeline paused; <N> steps written to workflow.json; SHA <sha> ready for operator-driven push; <P> deferred-post-merge actions pending
```

**Banned closure phrases** (rot when CI catches bugs the orchestrator's static skills did
not — e.g. type drift on integration tests, FK seed-order violations, env-var gaps):

- "PR mergeable"
- "ready to merge"
- "ship it"
- "all green"
- "100% complete"

These phrases conflate (a)+(b) with (c)+(d)+(e) and produce the failure mode where the
operator pushes only to discover lefthook + CI catch additional bugs the orchestrator
declared resolved. The honest framing is "ready for operator-driven push" — local work is
done, remote validation is the operator's next action.

## Step 4 — Validate skill output

After every `Skill(...)` tool_result, read the just-written step via jq:

```bash
LAST=$(browzer workflow get-config currentStepId --workflow "$WORKFLOW")
STATUS=$(browzer workflow get-step "$LAST" --field status --workflow "$WORKFLOW")
```

- `COMPLETED` → chain to the next phase.
- `AWAITING_REVIEW` → review mode is driving; wait for the skill to return a final status.
- `PAUSED_PENDING_OPERATOR` → only valid for `feature-acceptance`. Chain to commit; surface the deferred-action count.
- `STOPPED` → stop the chain; emit stop line + hint.
- `SKIPPED` → chain to the next phase.

Also validate the payload schema matches `references/workflow-schema.md` §4. If malformed, append `globalWarnings[]` and re-dispatch once; on second failure, STOP.

## Step 6 — Stop conditions

Stop the chain when any of these fire:

- **3-strike external failure**: a non-skill tool (git, pnpm, browzer CLI) fails 3 times for the same reason.
- **Feature-acceptance verdict STOPPED**: one or more AC/NFR/metrics failed. Hint to `receiving-code-review` re-entry or `execute-task` remediation.
- **Operator abort**: operator replies with "stop" / "abort" / "cancel" to any gate prompt.
- **Schema corruption**: `jq empty "$WORKFLOW"` fails, or a step's payload fails schema §4 shape check twice.

Stop line shape:

```
orchestrate-task-delivery: stopped at <stepId> — <one-line cause>
hint: <single actionable next step>
```

## Step 7 — Completion

On success, backfill elapsed-time fields BEFORE printing the success line:

```bash
browzer workflow patch --workflow "$WORKFLOW" --jq '
  ((.startedAt | fromdateiso8601) as $start
   | (.updatedAt | fromdateiso8601) as $end
   | .totalElapsedMin = (($end - $start) / 60 | floor))
  | .steps |= map(
      if (.startedAt and .completedAt) then
        ((.startedAt | fromdateiso8601) as $s
         | (.completedAt | fromdateiso8601) as $e
         | .elapsedMin = (($e - $s) / 60 | floor))
      else . end)'
```

Then print:

```
orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>
```
