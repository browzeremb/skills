# Explorer pass — Step 2 of generate-task

## Dispatch

Dispatch a single **haiku** `Agent` with the preamble from `references/subagent-preamble.md` prepended verbatim. The Explorer makes **zero technical decisions** — it only reports the shape of the repo.

```
Agent(
  model: "haiku",
  prompt: "<subagent-preamble verbatim>

  You are the Explorer. Zero technical decisions. For each prospective task in
  the PRD below:

  1. Map files likely to be modified. Use `browzer explore <query> --anchors --json`
     so each entry comes back with a stable `anchor` string (a 40–80-char unique
     snippet line that survives line-number drift). Drop `lineRange` from the
     payload — it rots between Pass 1 and execute-time.
  2. Map files required for context (use `browzer read` for top matches).
  3. Compute dep graph via `browzer deps <path> --json` (forward) and
     `browzer deps <path> --reverse --json` (blast radius).
  4. Confirm file extensions and config shapes that the PRD names by Read-ing at
     least one concrete file per family before claiming the family in your payload.
     Common landmines: i18n files (.yml vs .json vs .yaml), config (TS vs JS vs MJS),
     test runners (vitest.config.ts vs jest.config.js). Emit `assets[]` per task
     with one entry per confirmed family: { path, ext, confirmedAt }.
  5. Classify domains per the taxonomy below.
  6. For each detected domain, invoke `/find-skills <domain>` and capture the
     top-ranked skill path + name.

  Output ONE JSON per prospective task matching `task.explorer` shape in
  references/workflow-schema.md §4. Per-file entries carry `path` + `anchor` +
  optional `imports`/`importedBy` — NOT line numbers. DO NOT make implementation
  decisions. DO NOT write tests. DO NOT propose code.

  CLI auto-projection: the rich shape you emit for reasoning —
  `filesModified: [{ path, anchor, new, imports, importedBy }, …]`,
  `filesToRead: [{ path, reason }, …]`, `depsGraph[<file>]: { forward, reverse }`
  — IS NOT what the schema persists. `browzer workflow append-step` /
  `append-steps` flattens these to the lean shape (`[…paths]` and
  `depsGraph[<file>]: { imports, importedBy }`) automatically before the CUE
  pass. The `reason`/`anchor` strings reach the Reviewer via the same payload;
  they're stripped only at persistence time, so you do NOT need to pre-flatten.
  Operators / CI can opt OUT with `BROWZER_EXPLORER_LEGACY_REJECT=1` to verify
  no skill is silently relying on the projection — the post-mutation audit
  line carries `explorerProjected=true` whenever the projection actually fired.

  PRD: <inline PRD payload>
  Brainstorm (if any): <inline BRAINSTORM payload>
  ",
  isolation: "none"
)
```

## Domain taxonomy

Match file-path heuristics to assign domains:

| File-path signal | Domain |
|---|---|
| HTTP route handlers / controllers / server middleware | `fastify-backend` |
| Web/UI source / framework component files | `nextjs-web` |
| Background-job consumers, queue workers | `queue-worker` |
| Embedding pipelines, retrievers, vector-store clients | `rag-retrieval` |
| Graph DB clients and query files | `neo4j-graph` |
| Auth services, RBAC, session storage | `auth-identity` |
| Billing / quota / outbox / payments | `billing-outbox` |
| Tenancy, timingSafeEqual, api-key | `security` |
| Containerfiles, CI workflows, infra-as-code | `infra-build` |
| `*.test.ts`, `vitest.config` | `testing` |
| bench, perf | `performance` |
| Tracing instrumentation, structured loggers, metrics emitters | `observability` |

## Write prospective tasks after Explorer returns

For each prospective task in Explorer's output, build a `TASK` step JSON, then
append the **whole batch in one advisory-lock window** via `append-steps`
(plural — PR 5 verb; see
`../orchestrate-task-delivery/references/pipeline-phases.md` §append-steps).
One CUE validation pass across the array, one `tmp+rename` — saves N–1 daemon
round-trips vs N sequential `append-step` calls. Step IDs:
`STEP_04_TASK_01`, `STEP_05_TASK_02`, … (monotonic step index NN; monotonic
task MM). `task.reviewer` is left empty for Pass 2 to fill.

The block below has placeholders for `<explorer JSON for this task>` and
`<per-task AC derived from PRD>` — substitute per-task before running the
loop. The whole block is `# samples-eval: skip`-ged because those placeholders
are not deterministic JSON.

<!-- # samples-eval: skip -->
```bash
source scripts/jq-helpers.sh   # or source packages/skills/scripts/jq-helpers.sh

# Build one TASK step JSON per prospective task into "$FEAT_DIR/.task-steps-batch/".
# Each per-task `EXPLORER` is the haiku Explorer's JSON for that task; each
# `ACCEPTANCE` is the slice of PRD acceptanceCriteria scoped to it.
mkdir -p "$FEAT_DIR/.task-steps-batch"
TASK_INDEX=1
while IFS= read -r EXPLORER; do
  TID=$(printf 'TASK_%02d' "$TASK_INDEX")
  SID=$(printf 'STEP_%02d_%s' $((TASK_INDEX + 3)) "$TID")
  ACCEPTANCE='<per-task AC derived from PRD>'   # jq-select against $FEAT_DIR/.prd.json
  jq -n \
    --arg id "$SID" \
    --arg tid "$TID" \
    --arg now "$NOW" \
    --argjson explorer "$EXPLORER" \
    --argjson acceptance "$ACCEPTANCE" \
    --arg suggestedModel "sonnet" \
    --argjson trivial false \
    '{
       stepId: $id,
       name: "TASK",
       taskId: $tid,
       status: "PENDING",
       applicability: { applicable: true, reason: "default path" },
       startedAt: $now, completedAt: null, elapsedMin: 0,
       retryCount: 0,
       itDependsOn: ["STEP_03_TASKS_MANIFEST"],
       nextStep: "",
       skillsToInvoke: ["execute-task"],
       skillsInvoked: [],
       owner: null,
       worktrees: { used: false, worktrees: [] },
       warnings: [],
       reviewHistory: [],
       dispatches: [],
       task: {
         title: $explorer.title,
         # task.scope mirrors the lean filesModified list. When the Explorer
         # emits the rich shape, the CLI's append-step projection flattens
         # task.explorer.filesModified to strings before persistence — but
         # task.scope is ALREADY a plain string list per the schema, and the
         # projection doesn't rewrite task.scope. So flatten here too.
         scope: (($explorer.filesModified // []) | map(if type=="object" then .path else . end)),
         dependsOn: [],
         invariants: [],
         acceptanceCriteria: $acceptance,
         suggestedModel: $suggestedModel,
         trivial: $trivial,
         # `#TaskExplorer` is a closed CUE struct — strip non-schema keys
         # (e.g. `title`, which lives at `task.title` not `task.explorer.title`).
         # Rich filesModified / filesToRead / depsGraph shapes are preserved
         # when present — the CLI auto-projects them lean before the CUE pass
         # and emits explorerProjected=true on the audit line.
         explorer: ($explorer | del(.title) | {
           model:         (.model // null),
           filesModified: (.filesModified // []),
           filesToRead:   (.filesToRead   // []),
           domains:       (.domains       // []),
           skillsFound:   (.skillsFound   // [])
         } + (if .completedAt then {completedAt: .completedAt} else {} end)
           + (if .depsGraph   then {depsGraph:   .depsGraph}   else {} end)),
         execution: {
           gates: { baseline: {}, postChange: {}, regression: [] },
           scopeAdjustments: [],
           agents: [],
           invariantsChecked: [],
           nextSteps: ""
         }
       }
     }' > "$FEAT_DIR/.task-steps-batch/$SID.json"
  TASK_INDEX=$((TASK_INDEX + 1))
done < <(echo "$EXPLORER_TASKS" | jq -c '.[]')

# Single advisory-lock window, single CUE pass. Empty array (no prospective
# tasks) is rejected with a loud error — fail-fast vs writing a no-op.
jq -s '.' "$FEAT_DIR/.task-steps-batch"/*.json \
  | browzer workflow append-steps --await --workflow "$WORKFLOW"
```

Fallback for the singular case (one prospective task, or recovery patches that
add a single TASK step post-manifest): use `append-step` instead — see
`../orchestrate-task-delivery/references/pipeline-phases.md` §append-step.

## Banned dispatch-prompt patterns (Explorer)

Do NOT include in the Explorer prompt:
- Instructions to write code or propose solutions.
- References to specific line numbers (anchor strings survive drift; line numbers do not).
- Requests to validate test coverage (that is the Reviewer's job).
- "Use training data to guess" — always `browzer explore` first.
