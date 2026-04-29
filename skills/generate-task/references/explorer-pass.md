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

For each prospective task in Explorer's output, append a `TASK` step to `workflow.json`.
Step IDs: `STEP_04_TASK_01`, `STEP_05_TASK_02`, … (monotonic step index NN; monotonic task MM).
`task.reviewer` is left empty for Pass 2 to fill:

```bash
source references/jq-helpers.sh   # or source packages/skills/references/jq-helpers.sh

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
       title: $explorer.title,
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

echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

Repeat for every prospective task.

## Banned dispatch-prompt patterns (Explorer)

Do NOT include in the Explorer prompt:
- Instructions to write code or propose solutions.
- References to specific line numbers (anchor strings survive drift; line numbers do not).
- Requests to validate test coverage (that is the Reviewer's job).
- "Use training data to guess" — always `browzer explore` first.
