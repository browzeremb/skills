---
name: generate-task
description: "Step 2 of the workflow (brainstorming → generate-prd → generate-task → execute-task → code-review → fix-findings → update-docs → feature-acceptance → commit). Two-pass skill: Pass 1 (Explorer, haiku, zero technical decisions) maps files, dep graphs, domains, and skills-to-invoke for each prospective task; Pass 2 (Reviewer, sonnet default, opus for complex) validates Explorer's mapping, decides TDD applicability per task, and enumerates red/green test specs. Reads STEP_02_PRD from docs/browzer/feat-<date>-<slug>/workflow.json and writes STEP_03_TASKS_MANIFEST + N task steps via jq + mv. Triggers: 'break this PRD into tasks', 'generate tasks', 'plan the implementation', 'split this into PRs', 'decompose this spec', 'task plan', 'task breakdown', 'sequence the work', 'how should I sequence this', 'decompose into tasks'."
argument-hint: "feat dir: <path> | free-form PRD source"
allowed-tools: Bash(browzer *), Bash(git *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(date *), Bash(jq *), Bash(mv *), Read, Write, Agent, AskUserQuestion
---

# generate-task — Explorer + Reviewer two-pass

Step 2 of the workflow. Reads the PRD from `STEP_02_PRD` in `docs/browzer/feat-<date>-<slug>/workflow.json` and writes:

- **STEP_03_TASKS_MANIFEST** — totalTasks, tasksOrder, dependencyGraph, parallelizable.
- **STEP_04_TASK_01 … STEP_NN_TASK_MM** — one step per task, with `task.explorer` (Pass 1) and `task.reviewer` (Pass 2) payloads populated.

`workflow.json` is the durable artefact; this skill never writes `.meta/` sidecars or `TASK_NN.md` files anymore. Downstream skills (`execute-task`, `orchestrate-task-delivery`) read task steps via `jq`.

Output contract: `../../README.md` §"Skill output contract". One confirmation line on success.

You are a staff engineer breaking a spec into mergeable PR-sized tasks for **the repo this skill is invoked from**. You don't assume framework, monorepo shape, or test runner — you discover them. Every task must be directly runnable by `execute-task` with zero additional discovery.

---

## Inputs

- **Primary:** `feat dir: <path>` — passed by the orchestrator, `generate-prd`, or direct invocation. Bind to `FEAT_DIR`.
- **Fallback 1:** user invokes `generate-task` alone. List existing folders via `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -5` and ask which one (or accept a path arg). If none exist, call `Skill(skill: "generate-prd")` first.
- **Fallback 2:** user pastes a free-form description without a PRD. Call `Skill(skill: "generate-prd")` first — don't decompose against a shapeless request.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

## Step 1 — Read the PRD and baseline

Read the PRD payload and any brainstorming step via jq (NEVER via `Read`):

```bash
PRD=$(jq '.steps[] | select(.name=="PRD") | .prd' "$WORKFLOW")
BRAINSTORM=$(jq '.steps[] | select(.name=="BRAINSTORMING") | .brainstorm // empty' "$WORKFLOW")
MODE=$(jq -r '.config.mode // "autonomous"' "$WORKFLOW")
```

If the PRD step is missing or empty, STOP and emit:

```
generate-task: stopped at pre-PRD gate — workflow.json has no STEP_02_PRD
hint: invoke Skill(skill: "generate-prd") first
```

**Staleness gate** — same three-signal protocol as `generate-prd` (lastSyncCommit drift, browzer stderr "N commits behind", or `lastSyncCommit==null` unconditional warning). Surface at most once, append `; ⚠ index N commits behind HEAD` to the confirmation line.

Extract from the PRD payload:

- `functionalRequirements[]` — atomic behaviors.
- `acceptanceCriteria[]` — drive per-task `t.acceptanceCriteria` and `bindsTo` the FR they validate.
- `nonFunctionalRequirements[]` — scope each NFR to the task(s) that touch it.
- `inScope`, `outOfScope` — `outOfScope` is a hard constraint.
- `dependencies.external/internal` — feeds dep-graph hints.
- `taskGranularity` — `one-task-one-commit` (default) vs. `grouped-by-layer`.

---

## Step 2 — Pass 1: Explorer (haiku, zero technical decisions)

Dispatch a single **haiku** `Agent` with a constrained prompt. The Explorer does no technical design — it only reports the shape of the repo.

### Explorer dispatch

```
Agent(
  model: "haiku",
  prompt: "You are the Explorer. Zero technical decisions. For each prospective task in
  the PRD below:
    1. Map files likely to be modified (use `browzer explore` with PRD nouns/verbs).
    2. Map files required for context (use `browzer read` for top matches).
    3. Compute dep graph via `browzer deps <path> --json` (forward) and
       `browzer deps <path> --reverse --json` (blast radius).
    4. Classify domains per the taxonomy below (fastify-backend, nextjs-web,
       queue-worker, rag-retrieval, neo4j-graph, auth-identity, billing-outbox,
       security, infra-build, testing, performance, observability).
    5. For each detected domain, invoke `/find-skills <domain>` and capture the
       top-ranked skill path + name.
  Output ONE JSON per prospective task matching `task.explorer` shape in
  ../../references/workflow-schema.md §4. DO NOT make implementation decisions.
  DO NOT write tests. DO NOT propose code.

  Domain taxonomy (match file-path heuristics):
    apps/api, apps/auth, apps/rag, apps/gateway → fastify-backend
    apps/web, next.config.* → nextjs-web
    apps/worker, packages/queue → queue-worker
    packages/core/src/search, apps/rag → rag-retrieval
    packages/core/src/store, Cypher → neo4j-graph
    apps/auth, packages/db → auth-identity / billing-outbox (split by file)
    anything referencing tenancy, timingSafeEqual, api-key → security
    Dockerfile, docker-compose, Railway → infra-build
    *.test.ts, vitest.config → testing
    bench, perf → performance
    Langfuse, Pino, metrics → observability

  PRD: <inline PRD payload>
  Brainstorm (if any): <inline BRAINSTORM payload>
  ",
  isolation: "none"
)
```

Paste the `packages/skills/references/subagent-preamble.md` content verbatim into the Explorer prompt before the instructions above — the preamble enforces repo-rule anchoring and the "browzer first, training data last" discipline.

### Write each prospective task with `task.explorer` filled

After Explorer returns, for each prospective task in its output, append a `TASK` step to `workflow.json` via jq. Use step IDs `STEP_04_TASK_01`, `STEP_05_TASK_02`, … (monotonic step index NN; monotonic task number MM). The `task.reviewer` field is left empty for Pass 2 to fill:

```bash
STEP=$(jq -n \
  --arg id "STEP_04_TASK_01" \
  --arg tid "TASK_01" \
  --arg now "$NOW" \
  --argjson explorer '<explorer JSON for this task>' \
  --argjson acceptance '<per-task AC derived from PRD>' \
  --arg suggestedModel "sonnet" \
  --argjson trivial false \
  '{
     stepId: $id,
     name: "TASK",
     taskId: $tid,
     status: "PENDING",
     applicability: { applicable: true, reason: "default path" },
     startedAt: null, completedAt: null, elapsedMin: 0,
     retryCount: 0,
     itDependsOn: ["STEP_03_TASKS_MANIFEST"],
     nextStep: null,
     skillsToInvoke: ["execute-task"],
     skillsInvoked: [],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     task: {
       title: $explorer.title // "",
       scope: ($explorer.filesModified // []),
       dependsOn: [],
       invariants: [],
       acceptanceCriteria: $acceptance,
       suggestedModel: $suggestedModel,
       trivial: $trivial,
       explorer: $explorer,
       reviewer: {}
     }
   }')

jq --argjson step "$STEP" \
   --arg now "$NOW" \
   '.steps += [$step] | .totalSteps = (.steps | length) | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Repeat for every prospective task returned by Explorer.

---

## Step 3 — Pass 2: Reviewer (sonnet default, opus for complex, haiku for pure-docs)

Dispatch a Reviewer `Agent`. Model selection:

- **sonnet** (default).
- **opus** for multi-service / multi-invariant / novel-uncertainty tasks.
- **haiku** for pure-docs-or-fixture tasks.

Choose per task (the dispatch may be a batch with per-task model hints, or one dispatch per task — use your judgment on batch cost).

### Reviewer dispatch

```
Agent(
  model: "<sonnet|opus|haiku per task complexity>",
  prompt: "You are the Reviewer. For each task the Explorer produced:
    1. Read each file in explorer.filesToRead via `browzer read` or Read.
    2. Validate/correct Explorer's file mapping (drop false positives, add missed
       files). Record additionalContext about what you changed and why.
    3. Decide TDD applicability:
       - NOT applicable when: pure docs/config/migration, scope is entirely test
         files, operator explicit opt-out, or task type is rename/reformat.
       - APPLICABLE otherwise.
       Record reason (and skipReason when not applicable).
    4. Enumerate test specs that satisfy the task's AC + invariants. Each spec:
         { testId: \"T-N\", file: \"path/__tests__/xyz.test.ts\",
           type: \"red\"|\"green\", description: \"...\", coverageTarget: \"...\" }
       Red specs are authored BEFORE code (test-driven-development); green specs
       AFTER code (write-tests). Every task with TDD applicable must have at
       least one red spec bound to every AC.
  Output ONE JSON per task matching `task.reviewer` shape in the schema ref.

  Per-task input: <task stepId, explorer payload, PRD AC + NFR entries bound
  to this task>
  ",
  isolation: "none"
)
```

Paste `packages/skills/references/subagent-preamble.md` before the instructions above.

### Write each task's `reviewer` via jq + mv

```bash
jq --arg id "$STEP_ID" \
   --argjson reviewer '<reviewer JSON for this task>' \
   --arg now "$NOW" \
   '(.steps[] | select(.stepId==$id)).task.reviewer = $reviewer
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

---

## Step 4 — Emit STEP_03_TASKS_MANIFEST

After every task step has `task.reviewer` filled, compute the manifest:

- **tasksOrder**: array of taskIds in dependency + layer order (Rule 1 below).
- **dependencyGraph**: `{ "TASK_01": [], "TASK_02": ["TASK_01"], ... }` — from each task's `task.dependsOn`.
- **parallelizable**: `[[ "TASK_02", "TASK_03" ]]` — groups whose scope file-sets are disjoint AND whose dependencies are satisfied by the same predecessor batch.
- **totalTasks**: count.

Insert the manifest step BEFORE the first task step — it gets `stepId: STEP_03_TASKS_MANIFEST`:

```bash
MANIFEST=$(jq -n \
  --argjson totalTasks <N> \
  --argjson tasksOrder '[...]' \
  --argjson dependencyGraph '{...}' \
  --argjson parallelizable '[[...],[...]]' \
  '{ totalTasks: $totalTasks, tasksOrder: $tasksOrder,
     dependencyGraph: $dependencyGraph, parallelizable: $parallelizable }')

STEP=$(jq -n \
  --arg id "STEP_03_TASKS_MANIFEST" \
  --arg now "$NOW" \
  --argjson manifest "$MANIFEST" \
  '{
     stepId: $id,
     name: "TASKS_MANIFEST",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "default path" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0,
     itDependsOn: ["STEP_02_PRD"],
     nextStep: "STEP_04_TASK_01",
     skillsToInvoke: ["generate-task"],
     skillsInvoked: ["generate-task"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     tasksManifest: $manifest
   }')

# Insert the manifest between PRD and the first task step.
jq --argjson step "$STEP" \
   --arg now "$NOW" \
   '.steps = ([.steps[] | select(.name!="TASK")] + [$step] + [.steps[] | select(.name=="TASK")])
    | .updatedAt = $now
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

---

## Step 5 — Grouping rules (applied during Explorer scoping)

The Explorer's task boundaries should honor these rules. The Reviewer re-validates.

**Rule 1 — Layer order.** Lower layers ship before higher consumers: shared → contracts → data → core → api → workers → client → tests → observability+docs → edge.

**Rule 2 — ~30-file soft cap per task.** Split at layer boundaries when exceeded.

**Rule 3 — Orphan-free.** A new symbol ships with its first consumer (or in an earlier task that a later task explicitly depends on).

**Rule 4 — Merge-safe on main.** Each task, merged in order, leaves the repo runnable.

**Rule 5 — Forward dependencies only.** Task N depends only on tasks with index < N.

**Rule 6 — Repo invariants as constraints.** Every "must"/"never"/"always"/"invariant" surfaced by browzer (or fallback reads of CLAUDE.md / AGENTS.md) is stored in `task.invariants[]` with `rule` + `source`.

**Rule 7 — Delivered value per task.** Each task ends demoable (passing test, curl, rendered page behind flag).

**Rule 8 — Merging is the default; splitting requires justification.** Target median files-per-task ≥ 10 (preferred ≥ 15 for PRDs with ≥15 files). Split-preserving conditions: (a) incompatible invariants, (b) different `suggestedModel` tier, (c) opposite reversibility profiles (reversible vs. destructive migration), (d) would exceed the ~30-file cap.

Cross-layer merges require a feature-flag gate stated in the task's `invariants[]`.

**Trivial flag** (`task.trivial: true`): valid only when scope is ≤ 3 files, single layer, single package, no cross-invariant, deterministic outcome (rename, constant split, one-line config). Never for authz, billing, migrations, or any invariant-bearing file.

---

## Step 6 — Review gate (when `config.mode == "review"`)

```bash
MODE=$(jq -r '.config.mode // "autonomous"' "$WORKFLOW")
```

- `autonomous` → skip this step.
- `review` → flip STEP_03_TASKS_MANIFEST + each task step to `AWAITING_REVIEW`; render `../../references/renderers/tasks-manifest.jq`, then `../../references/renderers/task.jq` for each task step in sequence. For each, enter the gate loop (Approve / Adjust / Skip / Stop). Translate operator edits to jq ops on `.task.scope`, `.task.reviewer.testSpecs`, `.task.invariants`, etc. Append to `reviewHistory[]` per the schema §7.

---

## Step 7 — Validation before emitting

Reject the task set if any of these trip:

- [ ] STEP_03_TASKS_MANIFEST exists and is COMPLETED.
- [ ] Every task step has `task.explorer` AND `task.reviewer` populated.
- [ ] No file path appears in more than one task's `task.scope` (silent edit conflict killer).
- [ ] Every `task.dependsOn` entry references a task that appears earlier in `tasksOrder`.
- [ ] Every task with `task.reviewer.tddDecision.applicable == true` has at least one red test spec bound to every AC.
- [ ] Layer order holds (no consumer before producer; no client-only task preceding the API it consumes unless behind a flag).

Tiered thresholds (reject the whole set if tripped):

- [ ] Total files ≥ 15 AND median files-per-task < 10 AND < 50% `trivial: true` → Rule 8 under-applied.
- [ ] Total files ≥ 45 AND median < 15 → consolidate further.
- [ ] > 30% of tasks carry `trivial: true` → PRD is a bag of trivial changes, surface to operator.

Fix in place before emitting. If cannot fix without losing scope, ask the operator.

---

## Step 8 — Output contract

After all task steps + manifest are written and validated, emit **one line**:

```
generate-task: updated workflow.json STEP_03_TASKS_MANIFEST + N task steps; status COMPLETED
```

With staleness warning appended:

```
generate-task: updated workflow.json STEP_03_TASKS_MANIFEST + N task steps; status COMPLETED; ⚠ index N commits behind HEAD
```

On failure:

```
generate-task: stopped at <stepId> — <one-line cause>
hint: <single actionable next step>
```

Nothing else. No summary table. No inline task bodies. No "Next steps" block.

---

## Non-negotiables

- **Output language: English.** All JSON fields, task titles, scopes, test specs in English. Conversational wrapper follows operator's language.
- `workflow.json` is mutated ONLY via `jq | mv`. Never with `Read`/`Write`/`Edit`.
- No legacy `.meta/activation-receipt.json` or `TASK_NN.md` files. The schema is the receipt.
- Explorer makes ZERO technical decisions. Reviewer owns TDD applicability + test specs.
- Don't invent paths — if `explore` found nothing, leave `filesModified` empty and mark the task's `task.explorer.filesModified` as such; Reviewer may correct.
- Don't over-split. Rule 8 is load-bearing.
- Don't invent invariants. If neither `browzer search` nor CLAUDE.md fallback surfaces it, don't impose it.

## Related skills

- `generate-prd` — previous step; source of the PRD payload.
- `execute-task` — next step; dispatches agents per task's `explorer.skillsFound` + TDD flag.
- `orchestrate-task-delivery` — master router driving the full pipeline.
- `../../references/workflow-schema.md` — authoritative schema.
- `../../references/renderers/tasks-manifest.jq`, `task.jq` — renderers invoked in review mode.
- `../../references/subagent-preamble.md` — mandatory preamble for Explorer + Reviewer dispatches.
