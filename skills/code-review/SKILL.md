---
name: code-review
description: "Post-implementation review before update-docs + feature-acceptance. Spawns a dynamic team (or parallel agents + consolidator) with mandatory members (Senior Engineer, QA, Mutation Testing) plus domain specialists discovered via /find-skills. Mandatory Senior Engineer audits cyclomatic complexity per changed file. Mandatory Mutation Testing agent runs Stryker/mutmut/go-mutesting and records tests-to-update (does NOT alter tests). ALWAYS prompts operator for dispatch mode (agent-teams vs parallel+consolidator when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) and review tier (basic/recommended/custom) with per-tier token cost. Writes STEP_<NN>_CODE_REVIEW with findings[] to workflow.json. Zero corrections — fix-findings handles that next."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(npx *), Bash(jq *), Bash(mv *), Bash(date *), Bash(find *), Bash(grep *), Read, Write, Edit, AskUserQuestion, Agent
---

# code-review — team review for the shipped feature

Runs AFTER all TASK steps complete and BEFORE `update-docs` / `feature-acceptance` / `commit`. Spawns a dynamic team (or parallel agents + consolidator) to review the changed scope, records findings into `workflow.json` at `STEP_<NN>_CODE_REVIEW`. Applies zero corrections — `fix-findings` (the orchestrator's internal loop) handles that next.

Output contract: `../../README.md` §"Skill output contract". One confirmation line on success.

---

## Phase 0 — Prerequisites

Read `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` from `~/.claude/settings.json`:

```bash
TEAMS_FLAG=$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' ~/.claude/settings.json 2>/dev/null)
```

- Set to `"1"` → record `agentTeamsEnabled: true`. Both dispatch modes available.
- Unset / empty / any other value → `agentTeamsEnabled: false`. Only `parallel-with-consolidator` offered.

Resolve `FEAT_DIR` from args or newest `docs/browzer/feat-*/` and bind `WORKFLOW="$FEAT_DIR/workflow.json"`.

Derive the next monotonic step id:

```bash
NN=$(jq '.steps | length + 1' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_CODE_REVIEW"
```

## Phase 1 — Baseline

Run the repo's declared quality gate. Prefer scoped flags where available:

```bash
# pnpm turbo:
pnpm turbo lint typecheck test --filter=<affected pkgs>

# or fall back to the repo's full gate:
pnpm turbo lint typecheck test
```

Record baseline counts (pass/fail per gate, test counts) for reference — the dispatched agents will re-run gates scoped to their domain slice.

## Phase 2 — Scope + domain analysis

Read the changed-file set by aggregating task executions:

```bash
CHANGED=$(jq '[.steps[] | select(.name=="TASK") | .task.execution.files.modified + .task.execution.files.created] | add | unique' "$WORKFLOW")
```

Classify each file into a domain per this taxonomy (identical to `.claude/skills/browzer-review` Step 2):

| Signal (path / content)                                           | Domain          | `find-skills` query            |
| ----------------------------------------------------------------- | --------------- | ------------------------------ |
| `apps/api`, `apps/auth`, `apps/rag`, `apps/gateway`, Fastify code | Fastify Backend | "http route handler middleware" |
| `apps/web`, `next.config.*`, App Router files, RSC                | Next.js / Web   | "nextjs react server components" |
| `apps/worker`, `packages/queue`, BullMQ consumers                 | Queue / Worker  | "queue worker job consumer"    |
| `apps/rag`, `packages/core/src/search`, embeddings, reranker      | RAG / Retrieval | "rag vector embedding retrieval" |
| `packages/core/src/store`, Cypher, Neo4j driver                   | Neo4j / Graph   | "neo4j cypher graph"           |
| `apps/auth`, `packages/db`, better-auth plugins                   | Auth / Identity | "auth session oauth rbac"      |
| `packages/db`, `outbox_usage_delta`, Stripe                       | Billing / Outbox | "billing quota outbox"        |
| Input validation, auth headers, tenant scoping, `timingSafeEqual` | Security        | "owasp security"               |
| Dockerfile, docker-compose, Railway                               | Infra / Build   | "docker deploy infra ci"       |
| `*.test.ts`, vitest config                                        | Testing         | "testing strategies tdd"       |
| Hot path perf, bundle size                                        | Performance     | "performance optimization"     |
| Langfuse, Pino, metrics                                           | Observability   | "observability tracing metrics" |

Weight each domain: **Heavy** (5+ files or core logic), **Medium** (2-4 files), **Light** (1 file).

For each Heavy domain, invoke `/find-skills <query>` and record the top-ranked skill in `codeReview.recommendedMembers[]`.

## Phase 3 — Operator prompts (ALWAYS fire, even in autonomous flow)

Both prompts fire BEFORE the review gate — they are financial decisions the operator must explicitly consent to.

### Prompt 1 — dispatch mode (only if `agentTeamsEnabled`)

```
AskUserQuestion:
  Agent Teams is enabled. Dispatch mode?
    (a) agent-teams — dynamic team, round-table discussion
    (b) parallel-with-consolidator — N agents in parallel, 1 consolidator merges findings
```

If `agentTeamsEnabled: false`, skip this prompt and set `dispatchMode: "parallel-with-consolidator"` silently.

### Prompt 2 — review tier (always)

Compute per-tier token estimates. Baseline: ~2500 tokens per mandatory agent; ~2500 per recommended; apply 1.2× overhead for consolidator mode.

```
AskUserQuestion:
  Review tier? (estimated token cost shown per option)
    (a) basic        — 3 mandatory members                         (~<calc_basic> tokens)
    (b) recommended  — mandatory + <N> recommended                  (~<calc_reco> tokens)
    (c) custom       — specify members explicitly                   (cost computed after selection)
```

Where `<calc_basic>` ≈ 3 × 2500 × 1.2 = 9000 tokens; `<calc_reco>` ≈ (3 + N_recommended) × 2500 × 1.2.

When operator picks `custom`, collect the member list via free-form text, validate each against known domain skills, re-quote the cost, confirm.

## Phase 4 — Team composition

### Mandatory (always present, all three)

- **senior-engineer** — reviews code quality, invariants, blast radius. MUST audit cyclomatic complexity per changed file with a configurable threshold (default 10). Records `cyclomaticAudit[]` entries.
- **qa** — reviews test coverage, edge cases, regression risk.
- **mutation-testing** — runs Stryker (JS/TS) / mutmut (Python) / go-mutesting (Go) against the changed scope, records `mutationTesting.score` + `testsToUpdate[]`. MUST NOT alter any test file — only records findings.

### Recommended (operator-selected in Prompt 2)

- **security** (if Auth/Security/Billing domains Heavy)
- **performance** (if Performance/RAG/Queue domains Heavy)
- **accessibility** (if Next.js/Web domain Heavy)
- Domain specialists discovered via `/find-skills` and stored in `recommendedMembers[]`

Full role briefs in `references/mandatory-members.md`.

## Phase 5 — Execute

### parallel-with-consolidator

1. Baseline already captured in Phase 1.
2. Dispatch N agents in ONE response turn — N `Agent(...)` tool uses, each a focused role. Paste `../../references/subagent-preamble.md` §Step 1-5 verbatim into each prompt, then append:

   ```
   Role: <role name>.
   Scope: <file slice assigned to this role>.
   Invariants: <PRD NFRs + task invariants relevant to this role>.
   Contract: return findings as JSON matching
     { id, domain, severity, category, file, line, description,
       suggestedFix, assignedSkill, status: "open" }
   Do NOT alter any code or test file. You are read-only.
   ```

3. Each agent's first action is `/find-skills <domain>` to load its top-ranked domain skill, then review its scope slice.
4. **Consolidator** agent (sonnet) dispatched AFTER all role agents return. Prompt: merge findings, dedupe identical or near-identical reports, assign severity if any role didn't, resolve conflicts (prefer the more specific finding). Writes the final `codeReview.findings[]` array into `workflow.json`.

### agent-teams (when `dispatchMode: "agent-teams"`)

1. Same Phase 1 baseline.
2. Team spawned with mandatory + chosen tier members. Use the native Claude Code Agent Teams API; if unavailable, degrade to `parallel-with-consolidator`.
3. Round-table pattern per `.claude/skills/browzer-review` §Step 4 — each member reviews, then cross-comments.
4. Findings recorded as above.

## Phase 6 — Write STEP_<NN>_CODE_REVIEW to workflow.json

Assemble the `codeReview` payload per schema §4. Then append as a new step:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STEP=$(jq -n \
  --arg id "$STEP_ID" \
  --arg now "$NOW" \
  --argjson codeReview "$CODE_REVIEW_PAYLOAD" \
  '{
     stepId: $id,
     name: "CODE_REVIEW",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "post-implementation review" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0,
     itDependsOn: [.steps[] | select(.name=="TASK") | .stepId] | unique,
     nextStep: null,
     skillsToInvoke: ["code-review"],
     skillsInvoked: ["code-review"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     codeReview: $codeReview
   }')

jq --argjson step "$STEP" \
   --arg now "$NOW" \
   '.steps += [$step]
    | .currentStepId = $step.stepId
    | .totalSteps = (.steps | length)
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

### Review-gate pass-through (when `config.mode == "review"`)

The always-ask prompts in Phase 3 run regardless of mode. In addition, when `.config.mode == "review"`, flip `status` to `AWAITING_REVIEW` before Phase 6's final `status: COMPLETED` write, render `../../references/renderers/code-review.jq` for the operator, and enter the gate loop (Approve / Adjust / Skip / Stop) per `../../references/workflow-schema.md` §7. Operator-requested adjustments translate to jq ops on `findings[]` (e.g. "downgrade F-3 to low" → `(.steps[] | select(.stepId==$id) | .codeReview.findings[] | select(.id=="F-3")).severity = "low"`).

## Phase 7 — Zero corrections (handoff)

`code-review` NEVER alters code or tests. Ask the operator whether to proceed:

```
AskUserQuestion:
  Review complete — <N> findings recorded (severity H/M/L: <counts>).
  Proceed to fix-findings?
    (a) yes — let the orchestrator dispatch per-finding corrections
    (b) review findings first — open /tmp/code-review-<STEP_ID>.md
    (c) stop — I want to triage manually
```

If `(a)`, append `{action: "handoff-to-fix-findings"}` to the step's `reviewHistory[]`. If `(b)`, render `code-review.jq` to `/tmp/code-review-$STEP_ID.md`, then re-ask. If `(c)`, flip status to `STOPPED`, emit stop line.

## Phase 8 — Completion

Success:

```
code-review: updated workflow.json <STEP_ID>; findings <N>; status COMPLETED
```

Failure:

```
code-review: stopped at <STEP_ID> — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output:** findings list, cyclomatic tables, mutation score breakdowns. All of that data lives in the JSON.

---

## Non-negotiables

- **Output language: English.** All JSON payload fields in English. Conversational wrapper follows operator's language.
- No corrections applied. Read-only review.
- Prompt 2 (review tier) ALWAYS fires, even in autonomous flow.
- Mandatory members always present: senior-engineer, qa, mutation-testing.
- Cyclomatic audit ALWAYS conducted by senior-engineer, with threshold + per-file verdict.
- Mutation testing NEVER alters test files — only records `testsToUpdate[]`.
- `workflow.json` is mutated ONLY via `jq | mv`. Never with `Read`/`Write`/`Edit`.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — the master pipeline invokes this skill AFTER all `TASK` steps complete (phase 4 in spec §8.1). The orchestrator then runs the internal `fix-findings` loop to apply corrections (phase 5).
- **Standalone** — operator invokes directly to re-review after iterating on fixes. Re-invocation writes a new `CODE_REVIEW` step (with a new NN index); the old one stays as a historical record.

---

## Related skills and references

- `execute-task` — runs before; produces the files this skill reviews.
- `fix-findings` — internal loop in `orchestrate-task-delivery` (not a standalone skill); consumes `codeReview.findings[]` to dispatch corrections.
- `update-docs` — runs after fix-findings; patches docs affected by the final file set.
- `feature-acceptance` — runs after update-docs; verifies AC / NFR / metrics.
- `../../references/subagent-preamble.md` — paste into every dispatched agent's prompt.
- `../../references/workflow-schema.md` — authoritative schema (`codeReview`, `cyclomaticAudit`, `mutationTesting`).
- `../../references/renderers/code-review.jq` — markdown renderer invoked in review mode.
- `references/mandatory-members.md` — role briefs for senior-engineer, qa, mutation-testing.
- `.claude/skills/browzer-review` — user-level reference; the 360° review pattern this skill replicates inside the plugin.
