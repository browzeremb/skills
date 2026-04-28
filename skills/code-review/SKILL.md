---
name: code-review
description: "Post-implementation review before update-docs + feature-acceptance. Spawns a dynamic team (or parallel agents + consolidator) with mandatory members (Senior Engineer, QA, Mutation Testing) plus domain specialists discovered via /find-skills. Mandatory Senior Engineer audits cyclomatic complexity per changed file. Mandatory Mutation Testing agent runs Stryker/mutmut/go-mutesting and records tests-to-update (does NOT alter tests). ALWAYS prompts operator for dispatch mode (agent-teams vs parallel+consolidator when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) and review tier (basic/recommended/custom) with per-tier token cost. Writes STEP_<NN>_CODE_REVIEW with findings[] to workflow.json. Zero corrections — fix-findings handles that next."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(npx *), Bash(jq *), Bash(mv *), Bash(date *), Bash(find *), Bash(grep *), Read, Write, Edit, AskUserQuestion, Agent
---

# code-review — team review for the shipped feature

Runs AFTER all TASK steps complete and BEFORE `update-docs` / `feature-acceptance` / `commit`. Spawns a dynamic team (or parallel agents + consolidator) to review the changed scope, records findings into `workflow.json` at `STEP_<NN>_CODE_REVIEW`. Applies zero corrections — `fix-findings` (the orchestrator's internal loop) handles that next.

Output contract: emit ONE confirmation line on success. One confirmation line on success.

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
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_CODE_REVIEW"
```

## Phase 1 — Baseline

Run the repo's declared quality gate **scoped to the affected packages**. Repo-wide gates are the exception, not the default — see `references/subagent-preamble.md` §Step 2 for the full contract (discovery order, toolchain mapping, progressive-tracker handling).

Compute the affected-package set from the feature's changed files:

```bash
# Union of files touched by all completed TASK steps:
CHANGED=$(jq -r '[.steps[] | select(.name=="TASK") | .task.execution.files.modified // [], .files.created // []] | flatten | unique | .[]' "$WORKFLOW")

# Owning packages (example for pnpm monorepos — adapt per toolchain):
PKGS=$(echo "$CHANGED" | awk -F/ '{print "@<scope>/"$2}' | sort -u | paste -sd,)  # adjust the @<scope> prefix to match the repo
```

Then run the scoped gate:

```bash
# Run the repo's actual gate command — examples for common stacks below:
pnpm turbo lint typecheck test --filter="{$PKGS}" 2>&1 | tail -30

# Yarn classic: yarn lint <paths>  |  Nx: nx affected:lint  |  Go: go test ./<pkgs>/...
# (see preamble §Step 2 for other toolchains)
```

Repo-wide fallback (`pnpm turbo lint typecheck test` with no filter) is acceptable only when the change spans so many packages that the filter set would equal the full workspace — and even then, record the decision in `codeReview.notes` as `"repo-wide baseline used because <N> packages affected"`.

Record baseline counts (pass/fail per gate, test counts, duration) for reference — the dispatched agents will re-run gates scoped to their domain slice.

## Phase 2 — Scope + domain analysis

Read the changed-file set by aggregating task executions:

```bash
CHANGED=$(jq '[.steps[] | select(.name=="TASK") | .task.execution.files.modified + .task.execution.files.created] | add | unique' "$WORKFLOW")
```

Classify each file into a domain per this taxonomy (identical to `.claude/skills/browzer-review` Step 2):

| Signal (path / content)                                           | Domain          | `find-skills` query            |
| ----------------------------------------------------------------- | --------------- | ------------------------------ |
| HTTP route handlers, controllers, server-side middleware                | Backend          | "http route handler middleware"   |
| Web/UI source files, component files, client-side rendering layer       | Frontend / Web   | "components rendering routing"    |
| Background-job consumers, queue workers, scheduler entrypoints          | Queue / Worker   | "queue worker job consumer"       |
| Embedding pipelines, retrievers, vector-store clients, rerankers        | RAG / Retrieval  | "rag vector embedding retrieval"  |
| Graph DB clients, query files (Cypher / SPARQL / similar)               | Graph DB         | "graph database query"            |
| Auth services, session storage, RBAC / OAuth code                       | Auth / Identity  | "auth session oauth rbac"         |
| Billing / quota / outbox / payments-integration code                    | Billing / Outbox | "billing quota outbox"            |
| Input validation, auth headers, tenant scoping, `timingSafeEqual` | Security        | "owasp security"               |
| Build / deploy config (containerfiles, CI workflows, infra-as-code) | Infra / Build  | "docker deploy infra ci"       |
| `*.test.ts`, vitest config                                        | Testing         | "testing strategies tdd"       |
| Hot path perf, bundle size                                        | Performance     | "performance optimization"     |
| Tracing instrumentation, structured loggers, metrics emitters       | Observability  | "observability tracing metrics" |

Weight each domain: **Heavy** (5+ files or core logic), **Medium** (2-4 files), **Light** (1 file).

For each Heavy domain, invoke `/find-skills <query>` and record the top-ranked skill in `codeReview.recommendedMembers[]`.

## Phase 3 — Operator prompts (fire by default; skip when operator pre-registers)

Both prompts fire BEFORE the review gate — they are financial decisions the operator must explicitly consent to.

**Pre-registered skip path (autonomous mode + dispatch args):** if the invocation args explicitly name `dispatchMode: <value>` AND `tier: <value>` AND `.config.mode == "autonomous"`, skip both prompts. Use the pre-registered values, record them under `codeReview.preRegistered: true` with the source phrase from the args, and proceed. This honors the orchestrator's autonomous contract — re-prompting silently downgrades autonomous to interactive without operator consent.

If only one of the two values is pre-registered, fire the prompt for the missing one. If neither is pre-registered, both prompts fire as below.

### Prompt 1 — dispatch mode (only if `agentTeamsEnabled`)

```
AskUserQuestion:
  Agent Teams is enabled. Dispatch mode?
    (a) agent-teams — dynamic team, round-table discussion
    (b) parallel-with-consolidator — N agents in parallel, 1 consolidator merges findings
```

If `agentTeamsEnabled: false`, skip this prompt and set `dispatchMode: "parallel-with-consolidator"` silently.

### Prompt 2 — review tier (always)

Compute per-tier token estimates from the **scope-aware** formula `changedFileCount × perAgentTokens × 1.2`, not from a flat per-agent baseline. The static figure used in the v1 spec under-estimates real runs by 3–5× on non-trivial scopes. The flat 2500-tokens/agent number from the v1 spec under-estimated real runs by 5–10× because it ignored how much code each reviewer actually reads.

Inputs:

```bash
CHANGED_FILE_COUNT=$(git diff --name-only "$BASE_REF"...HEAD -- ':!*.lock' ':!*-lock.json' | wc -l | tr -d ' ')
LINES_CHANGED=$(git diff --shortstat "$BASE_REF"...HEAD | grep -oE '[0-9]+ insert|[0-9]+ delet' | grep -oE '[0-9]+' | awk '{s+=$1} END {print s+0}')
SCOPE_TIER=$(case "$CHANGED_FILE_COUNT" in
  ([0-3]) echo small ;;
  ([4-9]|1[0-5]) echo medium ;;
  (*) echo large ;;
esac)
```

Per-agent token estimate (read-cost + reasoning-cost, empirical from the 2026-04-24 dogfood run):

| scope tier | files | per-agent tokens | notes |
| ---------- | ----- | ---------------- | ----- |
| `small`    | 1–3   | ~5k              | tight scope, mostly diff-review |
| `medium`   | 4–10  | ~15k             | reads neighbours + tests |
| `large`    | 10+   | ~30k             | reads neighbours + tests + cross-file invariants |

```
AskUserQuestion:
  Review tier? (estimated token cost shown per option — derived from changed-file count × per-agent cost × 1.2 consolidator overhead)
    (a) basic        — 3 mandatory members                         (~<calc_basic> tokens)
    (b) recommended  — mandatory + <N> recommended                  (~<calc_reco> tokens)
    (c) custom       — specify members explicitly                   (cost computed after selection)
```

Where `<calc_basic>` = `3 × per_agent_cost(SCOPE_TIER) × 1.2` and `<calc_reco>` = `(3 + N_recommended) × per_agent_cost(SCOPE_TIER) × 1.2`. **Always disclose the underlying SCOPE_TIER** in the prompt copy so the operator sees why the estimate is what it is — a static "~9k" figure mis-leads on non-trivial scopes (the 2026-04-24 run actually consumed ~111k aggregate for 3 sonnet reviewers on a 10-file scope).

**Auto-default skip** (collapses 3-way to a 2-way prompt for the long tail of small refactors): when `SCOPE_TIER == small` AND `heavyDomainCount == 1` AND `mediumDomainCount ≤ 2`, set `tier: "recommended"` silently and prompt only:

```
AskUserQuestion: tier `recommended` auto-selected based on scope (small, 1 heavy domain, ≤2 medium).
  (a) approve  (b) customize
```

If operator picks `customize`, fall back to the full 3-way prompt above. Record the auto-default in `codeReview.tierSelection: { mode: "auto", reason: "small + 1 heavy + ≤2 medium" }` so the workflow.json shows it wasn't a 3-way operator pick.

When operator picks `custom`, collect the member list via free-form text, validate each against known domain skills, re-quote the cost using the same formula, confirm.

## Phase 4 — Team composition

### Mandatory (always present, all three)

- **senior-engineer** — reviews code quality, invariants, blast radius. MUST audit cyclomatic complexity per changed file with a configurable threshold (default 10). Records `cyclomaticAudit[]` entries.
- **qa** — reviews test coverage, edge cases, regression risk.
- **mutation-testing** — runs Stryker (JS/TS) / mutmut (Python) / go-mutesting (Go) against the changed scope, records `mutationTesting.score` + `testsToUpdate[]`. MUST NOT alter any test file. Detect installation FIRST via a `--version`/`--help` probe; **never silently downgrade to a qualitative read** (the legacy `tool: "qualitative-read (Stryker not executed)"` value is banned). Decision matrix:

  | Detection | Auto-action | Operator prompt |
  | --- | --- | --- |
  | Runner installed | Dispatch agent normally | none |
  | Runner missing, scope ≤10 files AND all under presentation-only paths (UI components, pages, view-only modules with no business logic) | Skip with `mutationTesting: { skipped: true, reason: "ui-only-scope-carve-out", scope: "<files>" }` | none |
  | Runner missing, any other scope | Stop and prompt: `install` (bootstrap runner + dispatch) / `skip` (record `skipped: true, reason: "operator-skipped"`) / `fail` (transition step to `STOPPED`) | Stryker install / skip / fail |

  Bootstrap commands: `npx stryker init` (JS/TS) · `pip install mutmut` (Python) · `go install github.com/avito-tech/go-mutesting/...` (Go). Carve-out details and runner-specific configs in `references/mutation-runners.md`.

### Recommended (operator-selected in Prompt 2)

- **security** (if Auth / Security / Billing domains are Heavy in the change set)
- **performance** (if Performance / Retrieval / Queue domains are Heavy in the change set)
- **accessibility** (if a web/UI domain is Heavy in the change set)
- Domain specialists discovered via `/find-skills` and stored in `recommendedMembers[]`

Full role briefs in `references/mandatory-members.md`.

### Category ownership (mandatory in every dispatch)

The 2026-04-27 dogfood retro logged a finding that all three parallel reviewers (senior-engineer + qa + frontend-specialist) flagged independently — F-1, a double-blank-line cosmetic — `consensusScore: 3` with zero unique signal across the three reports. Triple-flagging cosmetic findings burns roughly 20k tokens on every run for no review value. The fix is exclusive ownership of finding categories so other reviewers stay in their lane.

| Category                       | Owner role           | Other roles MUST skip                  |
| ------------------------------ | -------------------- | -------------------------------------- |
| lint-cosmetic / style          | senior-engineer      | qa, frontend-*, security, others       |
| test coverage / regression     | qa                   | senior-engineer, frontend-*, others    |
| a11y / perf / bundle / Vite    | frontend-specialist  | senior-engineer, qa, others            |
| auth / data leak / tenancy     | security             | senior-engineer, qa, others            |
| mutation kill rate             | mutation-testing     | (cannot be assigned to any other role) |

In Phase 5 the consolidator dedupes any cross-lane finding. If the same finding ID appears in N>1 reviewers' outputs the consolidator records `crossLaneOverlap: true` on that finding, and the off-lane reviewers' out-of-lane output is treated as advisory: it does NOT count toward `consensusScore`.

## Phase 5 — Execute

### parallel-with-consolidator

1. Baseline already captured in Phase 1.
2. Dispatch N agents in ONE response turn — N `Agent(...)` tool uses, each a focused role. Paste `references/subagent-preamble.md` §Step 0-5 verbatim into each prompt (Step 0 is the BLOCKING domain-skill load), then append:

   ```
   Role: <role name>.
   Scope: <file slice assigned to this role>.
   Invariants: <PRD NFRs + task invariants relevant to this role>.
   Skills to invoke (BLOCKING — call each via Skill(...) BEFORE reviewing, per
   preamble Step 0, in relevance order high → medium → low):
     <recommendedMembers[].skill list for this lane>
   Contract: return findings as JSON matching
     { id, domain, severity, category, file, line, description,
       suggestedFix, assignedSkill, status: "open" }
   Also include in your output a top-level `skillsLoaded: ["<path>", ...]` array
   listing every skill you actually invoked via Skill() before reviewing.
   Do NOT alter any code or test file. You are read-only.
   ```

3. Each agent's FIRST tool call MUST be `Skill(<top recommendedMembers[].skill for this lane>)` (preamble Step 0). Reviewing without loading the lane skill is a contract violation; the consolidator drops findings from agents whose `skillsLoaded[]` is empty when the dispatch listed at least one skill.

   Append the lane reminder to every reviewer's prompt:

   ```
   Stay in your lane: own only <category-from-ownership-table>. If you spot a
   finding outside your lane, do NOT report it — the <owning-role> reviewer
   will catch it. Cross-lane noise lowers consensus score and burns tokens.
   ```

4. **Consolidator** agent (sonnet) dispatched AFTER all role agents return. Prompt: merge findings, dedupe identical or near-identical reports, assign severity if any role didn't, resolve conflicts (prefer the more specific finding). On any cross-lane overlap (the same finding ID from N>1 reviewers), set `crossLaneOverlap: true` on the finding and exclude off-lane reports from `consensusScore`. **Enforce the Step-0 contract**: for each reviewer output, check that `skillsLoaded[]` is non-empty whenever the dispatched lane carried at least one skill; if violated, drop that reviewer's findings, append `codeReview.contractViolations[]: { role, dispatchedSkills, skillsLoaded: [], reason: "step-0-skipped" }`, and re-dispatch that single lane once. After re-dispatch, if still violated, surface the violation in the final summary and proceed without the lane's signal. Writes the final `codeReview.findings[]` array into `workflow.json`.

### agent-teams (when `dispatchMode: "agent-teams"`)

1. Same Phase 1 baseline.
2. Team spawned with mandatory + chosen tier members. Use the native Claude Code Agent Teams API.
3. **Degrade contract.** The only acceptable trigger for downgrading to `parallel-with-consolidator` is the native Agent Teams API being UNREACHABLE — 5xx, connection error, missing capability. **Cost-saving heuristics are NOT a valid trigger**, even when parallel would estimate cheaper for the current scope. Soft cost-side downgrades violate the operator's autonomous-mode contract (the 2026-04-27 retro logged exactly this drift: the orchestrator silently degraded for "marginal value over parallel" and the operator's intent vanished from the audit trail). If the runtime believes parallel would be cheaper, it MUST prompt the operator BEFORE downgrading:

   ```
   AskUserQuestion:
     agent-teams selected, but for this scope (<files> files, <lines> lines)
     parallel-with-consolidator is estimated <X>k tokens cheaper. Proceed
     with agent-teams or downgrade?
       (a) keep agent-teams      (b) downgrade to parallel
   ```

   When the API IS unreachable, preserve operator intent:
   - Tell the operator out-loud: `agent-teams unavailable — degrading to parallel-with-consolidator`.
   - Record `dispatchMode: "agent-teams-degraded-to-parallel"` (NOT plain `parallel-with-consolidator`) so workflow.json shows the operator picked agent-teams and the runtime fell back.
   - Set `degrade: { from: "agent-teams", reason: "Teams API unreachable", at: "<ISO>" }` under `codeReview` (mandatory, not optional, so the audit trail is complete).
4. Round-table pattern per `.claude/skills/browzer-review` §Step 4 — each member reviews, then cross-comments. Apply the same category-ownership table from Phase 4 — round-table reviewers stay in their lane too; cross-comments don't open new lanes.
5. Findings recorded as above.

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

The always-ask prompts in Phase 3 run regardless of mode. In addition, when `.config.mode == "review"`, flip `status` to `AWAITING_REVIEW` before Phase 6's final `status: COMPLETED` write, render `references/renderers/code-review.jq` for the operator, and enter the gate loop (Approve / Adjust / Skip / Stop) per `references/workflow-schema.md` §7. Operator-requested adjustments translate to jq ops on `findings[]` (e.g. "downgrade F-3 to low" → `(.steps[] | select(.stepId==$id) | .codeReview.findings[] | select(.id=="F-3")).severity = "low"`).

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
- Prompt 2 (review tier) fires by default; skipped when `tier: <value>` is pre-registered in invocation args alongside `.config.mode == "autonomous"` (see Phase 3 pre-registered skip path).
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
- `references/subagent-preamble.md` — paste into every dispatched agent's prompt.
- `references/workflow-schema.md` — authoritative schema (`codeReview`, `cyclomaticAudit`, `mutationTesting`).
- `references/renderers/code-review.jq` — markdown renderer invoked in review mode.
- `references/mandatory-members.md` — role briefs for senior-engineer, qa, mutation-testing.
- `.claude/skills/browzer-review` — user-level reference; the 360° review pattern this skill replicates inside the plugin.
