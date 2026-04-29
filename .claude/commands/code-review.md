---
name: code-review
description: "Post-implementation team review of a feature's diff. Spawns 4 mandatory agents in parallel — senior-engineer (cyclomatic complexity, DRY, clean code, best practices), software-architect (system design, race conditions, clean architecture, caching, performance), qa (regressions, edge cases, butterfly-effect breakage), regression-tester (runs scoped tests over modified files + their browzer deps) — plus domain specialists discovered via /find-skills. Every agent gets the diff + browzer deps (forward + reverse) + browzer mentions and may run browzer explore to detect prior art / duplication. Read-only — `receiving-code-review` applies fixes next. Triggers: code review, review this feature, audit my changes, review the diff, post-implementation review, team review, peer review, find issues in this PR."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(npx *), Bash(jq *), Bash(mv *), Bash(date *), Bash(find *), Bash(grep *), Read, Write, Edit, AskUserQuestion, Agent
---

# code-review — team review for the shipped feature

Runs AFTER all TASK steps complete and BEFORE `receiving-code-review` / `write-tests` / `update-docs` / `feature-acceptance` / `commit`. Spawns 4 mandatory parallel agents + domain specialists to review the changed scope and records findings into `workflow.json` at `STEP_<NN>_CODE_REVIEW`. Applies zero corrections — `receiving-code-review` consumes the findings next and dispatches per-domain fix agents.

**Every agent receives**: the diff (changed files), `browzer deps` (forward + reverse) for each changed file, `browzer mentions` reverse traversal so the agent sees which docs/entities reference the touched code, AND permission to run `browzer explore` to detect prior art / duplicated implementations elsewhere in the repo. This context is non-negotiable — the butterfly-effect class of bugs (changing a constant in file A breaks file B 4 imports away) is invisible without the dep + mentions snapshot.

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

Stamp `startedAt` BEFORE doing any work (per workflow-schema §5.1) — this is what the orchestrator's roll-up reads to compute `elapsedMin`. The skill's final `status: "COMPLETED"` write later sets `completedAt`; the gap between them is the actual cost of the review.

## Phase 1 — Baseline (reuse upstream gates first)

Quality gates already ran inside every completed `TASK` step; re-running them in code-review is duplicate work. Reuse first, top-up only what's missing.

```bash
REUSED=$(browzer workflow query reused-gates --workflow "$WORKFLOW")
```

`query reused-gates` returns a JSON array of gate keys that ran non-failingly across every completed TASK step (e.g. `["lint", "tests", "typecheck"]`). It mirrors the legacy jq pipeline (`select(.value != null and .value != "" and .value != "fail")`) but goes through schema-validated Go code with audit-line emission. Run `browzer workflow query --help` for the full registry.

For every gate present in `REUSED` AND covering the same affected package set as this code-review, mark it `baseline.reusedGates[]` and skip the re-run. For any gate not covered (lint not run, typecheck not run, tests not run, or the upstream run was scoped narrower than this review), run it fresh and add it to `baseline.freshGates[]`.

Record the disposition under `codeReview.baseline`:

```jsonc
"baseline": {
  "source": "workflow-json" | "fresh-run" | "hybrid",
  "reusedGates": ["lint", "typecheck", "tests"],
  "freshGates": [],
  "duration": "<wall-clock>"
}
```

When `freshGates[]` is non-empty, run them **scoped to the affected packages**. Repo-wide gates are the exception, not the default — see `references/subagent-preamble.md` §Step 2 for the full contract (discovery order, toolchain mapping, progressive-tracker handling).

Compute the affected-package set from the feature's changed files:

```bash
# Union of files touched by all completed TASK + RECEIVING_CODE_REVIEW + WRITE_TESTS steps:
CHANGED=$(browzer workflow query changed-files --workflow "$WORKFLOW" | jq -r '.[]')

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

When EVERY gate is reusable, no fresh run happens at all: set `baseline.source: "workflow-json"`, `baseline.duration: "0s (reused)"`, and proceed straight to Phase 2.

## Phase 2 — Scope + domain analysis

Read the changed-file set by aggregating task executions:

```bash
CHANGED=$(browzer workflow query changed-files --workflow "$WORKFLOW")
```

Returns a deduped+sorted JSON array.

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
    (a) basic        — 4 mandatory members                         (~<calc_basic> tokens)
    (b) recommended  — mandatory + <N> recommended                 (~<calc_reco> tokens)
    (c) custom       — specify members explicitly                  (cost computed after selection)
```

Where `<calc_basic>` = `4 × per_agent_cost(SCOPE_TIER) × 1.2` and `<calc_reco>` = `(4 + N_recommended) × per_agent_cost(SCOPE_TIER) × 1.2`. **Always disclose the underlying SCOPE_TIER** in the prompt copy so the operator sees why the estimate is what it is — a static figure mis-leads on non-trivial scopes.

**Auto-default skip** (collapses 3-way to a 2-way prompt for the long tail of small refactors): when `SCOPE_TIER == small` AND `heavyDomainCount == 1` AND `mediumDomainCount ≤ 2`, set `tier: "recommended"` silently and prompt only:

```
AskUserQuestion: tier `recommended` auto-selected based on scope (small, 1 heavy domain, ≤2 medium).
  (a) approve  (b) customize
```

If operator picks `customize`, fall back to the full 3-way prompt above. Record the auto-default in `codeReview.tierSelection: { mode: "auto", reason: "small + 1 heavy + ≤2 medium" }` so the workflow.json shows it wasn't a 3-way operator pick.

When operator picks `custom`, collect the member list via free-form text, validate each against known domain skills, re-quote the cost using the same formula, confirm.

## Phase 4 — Team composition

### Mandatory (always present, all four)

All four mandatory agents receive the same context bundle BEFORE reviewing:

1. **Diff** — every file in `CHANGED` plus the unified diff against `$BASE_REF`.
2. **`browzer deps <file>` (forward + reverse) for each changed file** — pre-computed by the orchestrator and saved to `/tmp/code-review-deps-<file>.json`. The reverse list is the blast-radius surface; the forward list is what the file leans on.
3. **`browzer mentions <file>` for each changed file** — the doc/entity reverse-traversal surface (`File ← RELEVANT_TO ← Entity ← MENTIONS ← Chunk ← HAS_CHUNK ← Document`).
4. **A standing licence to run `browzer explore "<symbol or behaviour>"`** any time a finding hinges on "is this already implemented elsewhere?". Duplicated implementations are findings the senior-engineer files; the licence makes this verifiable rather than a guess.

Agent briefs:

- **senior-engineer** — code quality + craft. Owns:
  - **Cyclomatic complexity** per changed file (default threshold 10). Records `cyclomaticAudit[]` entries.
  - **DRY / duplication.** When the same pattern (cast, validation, fetch wrapper, header parsing, error handler, session shape) appears across **3+ files** in the diff OR is detected via `browzer explore` elsewhere in the repo, emit `codeReview.duplicationFindings[]: { pattern, files, suggestedExtraction }` AND a regular finding recommending extraction.
  - **Clean code & best practices** — naming, function length, single responsibility, magic numbers, dead code, log-vs-throw discipline, error handling shape, return-type honesty.
  - **AC-calibration audit.** Scan PRD `acceptanceCriteria[]` + `nonFunctionalRequirements[]` for numeric thresholds (`<=\s*\d+\s*(s|ms|seconds|minutes|m)\b` and symmetric); grep the diff for related constants (`*_TIMEOUT_MS`, `*_BUDGET_*`, `MAX_*_MS`, hardcoded literals); when a code constant is mismatched against the AC by **>2×** in either direction, emit `severity: medium, category: ac-calibration`. Catches "AC says ≤5s, harness uses 10000ms" before feature-acceptance has to.

  Severity: invariant-violation → high. Cyclomatic > 2× threshold → high. Cyclomatic between 1× and 2× → medium. Style / naming → low.

- **software-architect** — system design + non-functional concerns. Owns:
  - **Race conditions / TOCTOU** — concurrent writes, validate-then-create ordering, missing locks, stale reads, double-spend windows.
  - **Clean architecture** — layer boundaries, dependency direction, leaky abstractions, accidental cross-cutting coupling, missing seams (interfaces, ports/adapters where the change argues for one).
  - **Caching** — cache-keys correctness, invalidation, stampede risk, TTL sanity, cache-aside vs write-through fit, observable read amplification regressions.
  - **Performance** — N+1, unbounded loops over external state, sync I/O on hot paths, allocation in tight loops, missing pagination, p99 implications of the change. Don't speculate — cite a specific file:line and propose a concrete experiment.

  Severity: race condition with money/data integrity stakes → high. Missing cache invalidation that produces stale tenant-visible data → high. Layer violations affecting testability → medium. Perf regressions ≥2× without justification → medium.

- **qa** — regression hunting + edge cases + butterfly-effect risk. Owns:
  - **Regressions** — does the diff remove pre-existing tests, change a public-surface behaviour without updating callers, or modify a serialization shape that downstream consumers will silently misread? Read both sides of every changed boundary.
  - **Edge cases** — empty / null / undefined / boundary / negative / very-long / concurrent / failure-mode inputs against every modified branch.
  - **Butterfly-effect** — for each changed constant, type, or shared helper, walk the **reverse-deps** list AND the **mentions** list and flag callers/docs whose assumptions the change quietly invalidates. (Example: `MAX_RETRY = 3 → 5` looks safe until reverse-deps shows a backoff calculator that assumed `MAX_RETRY <= 4`.) Emit `category: butterfly-effect` with the file pair and the broken assumption stated explicitly.
  - **Cross-tenant / cross-org leak risk** — any code path that swaps/aggregates tenant state without re-scoping is a high-severity finding.

  Severity: silent behaviour drift on a public surface → high. Butterfly-effect with active blast-radius (the dependent file is in the same diff or in active feature work) → high. Missing edge-case on a low-risk path → low.

- **regression-tester** — empirical verification, not just review. Owns:
  - **Compute the test-blast-radius set** = changed files ∪ reverse-deps of changed files. Limit to files within test discoverability (no node_modules, no generated dirs).
  - **Run the repo's test command scoped to the radius** — invoke the actual runner (vitest / jest / pytest / go test / cargo test / etc.) targeting the test files that cover the radius. Do NOT run the whole suite blindly; that's the baseline gate's job.
  - **Record per-radius-file pass/fail** in `codeReview.regressionRun`:

    ```jsonc
    "regressionRun": {
      "tool": "vitest" | "pytest" | "go test" | "cargo test" | "jest" | "...",
      "scope": "blast-radius",
      "filesInRadius": <int>,
      "testFilesExecuted": <int>,
      "passed": <int>,
      "failed": <int>,
      "duration": "<wall-clock>",
      "failures": [{ "testFile": "<path>", "testName": "<id>", "error": "<one-line>" }]
    }
    ```

  - When `failed > 0`, file ONE finding per failure with `severity: high, category: regression` and the failing test's identifier in `description`. Do NOT swallow failures into the summary.
  - When the repo has no test setup (write-tests' detector returns `hasTestSetup: false`), record `regressionRun: { skipped: true, reason: "no-test-setup" }` and proceed without filing findings.
  - **Read-only.** This agent does NOT alter tests or code. If the regression-tester thinks a test should be added/changed, it files a finding for `qa` lane (or `senior-engineer`) — write-tests handles authoring after `receiving-code-review` closes findings.

  Severity: every failing test is a high-severity finding. No test infrastructure → not a finding (write-tests bootstraps later) but record the skip.

### Recommended (operator-selected in Prompt 2)

- **security** (if Auth / Security / Billing domains are Heavy in the change set)
- **accessibility** (if a web/UI domain is Heavy in the change set)
- Domain specialists discovered via `/find-skills` and stored in `recommendedMembers[]`

Performance is now folded into `software-architect` (no separate recommended slot). Full role briefs in `references/mandatory-members.md`.

### Category ownership (mandatory in every dispatch)

Triple-flagging the same finding across three reviewers burns ~20k tokens per run for no review value. The fix is exclusive ownership of finding categories so other reviewers stay in their lane.

| Category                                 | Owner role          | Other roles MUST skip                                |
| ---------------------------------------- | ------------------- | ---------------------------------------------------- |
| cyclomatic / DRY / clean code / style    | senior-engineer     | software-architect, qa, regression-tester, others    |
| race conditions / clean architecture     | software-architect  | senior-engineer, qa, regression-tester, others       |
| caching / performance                    | software-architect  | senior-engineer, qa, regression-tester, others       |
| edge cases / butterfly-effect / regressions (review) | qa          | senior-engineer, software-architect, others          |
| failing tests in blast radius (run)      | regression-tester   | (cannot be assigned to any other role)               |
| auth / tenancy / data leak               | security            | senior-engineer, software-architect, qa, others      |
| a11y / bundle size                       | frontend-specialist | senior-engineer, software-architect, others          |

In Phase 5 the consolidator dedupes any cross-lane finding. If the same finding ID appears in N>1 reviewers' outputs the consolidator records `crossLaneOverlap: true` on that finding, and the off-lane reviewers' out-of-lane output is treated as advisory: it does NOT count toward `consensusScore`.

## Phase 5 — Execute

### Consolidator: in-line is the default for small + medium scopes

For `SCOPE_TIER ∈ {small, medium}`, the consolidator's job (cross-lane dedup, severity normalisation, contract-violation audit, `severityCounts` derivation) is mechanical jq-merge work. Dispatching a separate sonnet agent for it costs ~30k tokens + ~120s wall-clock for output that the orchestrator can compute inline in seconds. **Default to in-line consolidation** for these tiers; reserve a dispatched consolidator agent for `large` only, where qualitative synthesis (theme extraction, blast-radius narrative, conflict resolution between divergent reviewer worldviews) earns its cost.

Record the choice on every run:

```jsonc
"consolidator": { "mode": "in-line" | "dispatched-agent", "reason": "string" }
```

Acceptable reasons: `"scope tier ≤ medium → mechanical merge"`, `"scope tier large → qualitative synthesis"`, or an explicit operator override.

### parallel-with-consolidator

1. Baseline already captured in Phase 1.
2. **Pre-compute the per-agent context bundle** (one-shot before dispatch — every mandatory agent shares the same artefacts):

   ```bash
   for F in $CHANGED; do
     SLUG=$(echo "$F" | tr '/' '_')
     browzer deps "$F"           --json --save "/tmp/cr-deps-$SLUG.json"
     browzer deps "$F" --reverse --json --save "/tmp/cr-rdeps-$SLUG.json"
     browzer mentions "$F"       --json --save "/tmp/cr-mentions-$SLUG.json"
   done
   ```

   Reference these paths in each agent's prompt (do NOT inline the JSON — the agent reads what it needs). The orchestrator that runs this skill is responsible for the snapshot; agents do not re-run `browzer deps` for files in `CHANGED` (they may run `browzer explore` for prior-art lookups).

3. Dispatch N agents in ONE response turn — N `Agent(...)` tool uses, each a focused role. Cap each reviewer's emit at 10 findings — when a single lane would produce more, that's signal the lane scope is too broad, not that the dispatcher should accept the firehose. Split the lane (or escalate to `large` tier so the consolidator earns its keep). Paste `references/subagent-preamble.md` §Step 0-5 verbatim into each prompt (Step 0 is the BLOCKING domain-skill load), then append:

   ```
   Role: <role name>.
   Scope: <file slice assigned to this role>.
   Invariants: <PRD NFRs + task invariants relevant to this role>.

   Context bundle (read before reviewing):
     - Diff:                git diff $BASE_REF...HEAD -- <scope files>
     - Forward deps:        /tmp/cr-deps-<slug>.json (one per changed file)
     - Reverse deps (blast): /tmp/cr-rdeps-<slug>.json (one per changed file)
     - Mentions (docs/entities): /tmp/cr-mentions-<slug>.json (one per changed file)
     - Prior-art lookup:    you MAY run `browzer explore "<symbol/behaviour>"`
                            whenever a finding hinges on duplicated implementation
                            elsewhere in the repo.

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

4. **Consolidator pass.**
   - **Small / medium scope (default in-line)** — orchestrator merges findings inline: dedupe identical or near-identical reports, normalise severity, resolve conflicts (prefer the more specific finding), set `crossLaneOverlap: true` on cross-lane duplicates, and write `codeReview.findings[]` directly via jq + mv. No dispatch.
   - **Large scope** — dispatch one sonnet `Agent` AFTER all role agents return. Prompt: same merge work as the in-line path, plus a qualitative synthesis paragraph naming the dominant themes, the highest-leverage fix order, and any cross-cutting risks the per-lane reviewers missed.

   In both modes: **enforce the Step-0 contract**. For each reviewer output, check that `skillsLoaded[]` is non-empty whenever the dispatched lane carried at least one skill; if violated, drop that reviewer's findings, append `codeReview.contractViolations[]: { role, dispatchedSkills, skillsLoaded: [], reason: "step-0-skipped" }`, and re-dispatch that single lane once. After re-dispatch, if still violated, surface the violation in the final summary and proceed without the lane's signal.

5. **Always populate `severityCounts`** before writing the step:

   ```bash
   SEVERITY_COUNTS=$(jq '
     [.findings[].severity] | group_by(.)
     | map({key: .[0], value: length}) | from_entries
     | { high: (.high // 0), medium: (.medium // 0), low: (.low // 0) }
   ' <<< "$CODE_REVIEW_PAYLOAD")
   ```

   The `summary` text MAY repeat the counts narratively, but the structured field is what retro-analysis reads — leaving it null while the summary cites "8H/15M/7L" is a contract violation.

### agent-teams (when `dispatchMode: "agent-teams"`)

This branch uses Claude Code's **Agent Teams** feature (https://code.claude.com/docs/en/agent-teams) — a team lead + N teammates with their own context windows, a shared task list, and direct teammate-to-teammate messaging. It is structurally different from `parallel-with-consolidator`: teammates round-table, challenge each other, and converge through dialogue rather than reporting independent findings to a synthesizer. **Do not implement this branch by spawning N parallel `Agent(...)` calls + a consolidator** — that is the parallel branch. Operator intent is the contract here: when the operator picks `agent-teams`, executing the parallel pattern instead is a silent downgrade and a contract violation, even when no dialogue would have happened.

1. Same Phase 1 baseline.
2. **Pre-flight (mandatory)** — confirm Agent Teams is actually usable in the current Claude Code session. The Phase 0 `agentTeamsEnabled` flag only proves the env var is set; it does NOT prove the host CLI can spawn teammates. Probe:
   - `claude --version` is ≥ `2.1.32` (per the doc's Note).
   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` resolves at runtime (re-check the merged settings, not just `~/.claude/settings.json`).
   - If either check fails, follow the `degrade contract` below — do NOT silently fall back to parallel.
3. **Spawn the team in ONE turn.** Issue a single natural-language team-creation request to the host (per the doc's "Start your first agent team" pattern). The request MUST encode:
   - Mandatory members: `senior-engineer`, `software-architect`, `qa`, `regression-tester` (one teammate each, named by the role).
   - Recommended members from `recommendedMembers[]` (one teammate each).
   - Each teammate's spawn prompt = `references/subagent-preamble.md` §Step 0–5 verbatim + role + lane + skill list (same content as the parallel branch's per-agent prompt).
   - Subagent definitions referenced by name (per doc §"Use subagent definitions for teammates") so each teammate honors its tools allowlist + model.
   - Lane discipline: every teammate is told `Stay in your lane: own only <category-from-ownership-table>. Use teammate-to-teammate messaging to challenge findings outside your lane rather than reporting them yourself.`
   - Round-table contract (verbatim in the team request): `After each teammate posts initial findings, every teammate MUST read the others' findings via the shared task list, send at least one challenge or confirmation message to a peer in their adjacent lane, and revise their findings based on the dialogue. The lead synthesizes only after all round-trip messages are delivered.`
   - Plan-approval gate (per doc §"Require plan approval"): require each teammate to submit a review plan to the lead before reading the diff. The lead's approval criteria: "approve if the plan covers the assigned lane completely; reject if it overlaps another lane".

   Template for the team-creation request (lead = the skill's orchestrator turn itself):

   ```text
   Create an agent team to review this feature. The team lead is me. Spawn
   <N> teammates with these roles (use subagent definitions where named):
     - senior-engineer    (Stay in lane: cyclomatic / DRY / clean code / style)
     - software-architect (Stay in lane: race conditions / clean architecture / caching / performance)
     - qa                 (Stay in lane: edge cases / butterfly-effect / regression review)
     - regression-tester  (Stay in lane: run scoped tests over modified files + reverse-deps; do NOT alter tests)
     - <each recommended member>  (Stay in lane: <its category>)

   Each teammate's spawn prompt is the subagent preamble §Step 0–5 followed
   by its lane-specific skill list and the round-table contract. Require
   plan approval before any teammate reads the diff. After initial findings
   are posted, every teammate MUST send at least one challenge or
   confirmation message to a peer in an adjacent lane. The lead synthesizes
   the final findings[] from the converged dialogue, NOT from the initial
   independent reports.

   No teammate may write to workflow.json directly — the lead writes the
   final codeReview.findings[] in Phase 6 after the team converges.
   ```

4. **Drive convergence, not independence.** While the team is running, monitor the shared task list (per doc §"Assign and claim tasks"). If two teammates flag findings in the same lane, the lead messages the off-lane teammate to drop the cross-lane finding. If a teammate goes idle without posting at least one peer-challenge message, the lead nudges it via direct message: `Per the round-table contract, send a challenge or confirmation to a peer in an adjacent lane before idling.` Do NOT collapse the team into "first finding wins" — the convergence dialogue is the entire reason this branch costs more than parallel.
5. **Synthesize findings** AFTER all teammates have posted at least one peer message AND the lead-driven dialogue has reached a stable round (no open challenges). The lead reads each teammate's final report from the team task list, applies the same category-ownership table from Phase 4 (cross-lane overlaps still get `crossLaneOverlap: true`, off-lane reporters drop out of `consensusScore`), and writes the unified `codeReview.findings[]`. Record under `codeReview.agentTeam`:

   ```jsonc
   "agentTeam": {
     "teamId": "<id from the host>",
     "teammates": [{ "name": "senior-engineer", "model": "sonnet", "lane": "style+invariants" }, ...],
     "roundTrips": <integer count of teammate-to-teammate messages observed>,
     "convergedAt": "<ISO>",
     "planApprovals": [{ "teammate": "qa", "approved": true, "at": "<ISO>" }, ...]
   }
   ```

   `roundTrips: 0` is a contract violation — emit `codeReview.contractViolations[]: { mode: "agent-teams", reason: "no round-table dialogue observed" }` and stop the step at `STOPPED`. The orchestrator can re-dispatch with `dispatchMode: "parallel-with-consolidator"` if appropriate.
6. **Clean up the team** after the synthesis write succeeds (per doc §"Clean up the team"): `Clean up the team`. Failure to clean up leaves orphaned teammates that interfere with subsequent skill invocations. Record `agentTeam.cleanedUpAt: "<ISO>"`.

7. **Degrade contract.** The only acceptable trigger for downgrading to `parallel-with-consolidator` is the Agent Teams runtime being UNREACHABLE — version too old, env var unresolved, host returns a hard error spawning the team. **Cost-saving heuristics are NOT a valid trigger**, even when parallel would estimate cheaper for the current scope. Soft cost-side downgrades violate the operator's autonomous-mode contract. If the runtime believes parallel would be cheaper, it MUST prompt the operator BEFORE downgrading:

   ```
   AskUserQuestion:
     agent-teams selected, but for this scope (<files> files, <lines> lines)
     parallel-with-consolidator is estimated <X>k tokens cheaper. Proceed
     with agent-teams or downgrade?
       (a) keep agent-teams      (b) downgrade to parallel
   ```

   When the runtime IS unreachable, preserve operator intent:
   - Tell the operator out-loud: `agent-teams unavailable — degrading to parallel-with-consolidator`.
   - Record `dispatchMode: "agent-teams-degraded-to-parallel"` (NOT plain `parallel-with-consolidator`) so workflow.json shows the operator picked agent-teams and the runtime fell back.
   - Set `degrade: { from: "agent-teams", reason: "<specific cause: version | env-var | spawn-error>", at: "<ISO>" }` under `codeReview` (mandatory, not optional, so the audit trail is complete).

## Phase 6 — Write STEP_<NN>_CODE_REVIEW to workflow.json

Assemble the `codeReview` payload per schema §4. The step's `startedAt` was already stamped at the top of Phase 0 (per workflow-schema §5.1) — this final write only needs to flip status to `COMPLETED`, set `completedAt`, and derive `elapsedMin`:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_AT="${CODE_REVIEW_STARTED_AT:-$NOW}"   # captured at Phase 0
STEP=$(jq -n \
  --arg id "$STEP_ID" \
  --arg startedAt "$STARTED_AT" \
  --arg now "$NOW" \
  --argjson codeReview "$CODE_REVIEW_PAYLOAD" \
  '{
     stepId: $id,
     name: "CODE_REVIEW",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "post-implementation review" },
     startedAt: $startedAt,
     completedAt: $now,
     elapsedMin: ((($now | fromdateiso8601) - ($startedAt | fromdateiso8601)) / 60),
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

echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

If `CODE_REVIEW_STARTED_AT` was not captured (e.g. early-exit path), use the actual Phase 0 timestamp from chat scrollback or — as a last resort — the Phase 5 dispatch timestamp; never write `startedAt = completedAt`.

### Review-gate pass-through (when `config.mode == "review"`)

The always-ask prompts in Phase 3 run regardless of mode. In addition, when `.config.mode == "review"`, flip `status` to `AWAITING_REVIEW` before Phase 6's final `status: COMPLETED` write, render `references/renderers/code-review.jq` for the operator, and enter the gate loop (Approve / Adjust / Skip / Stop) per `references/workflow-schema.md` §7. Operator-requested adjustments translate to jq ops on `findings[]` (e.g. "downgrade F-3 to low" → `(.steps[] | select(.stepId==$id) | .codeReview.findings[] | select(.id=="F-3")).severity = "low"`).

## Phase 7 — Zero corrections (handoff)

`code-review` NEVER alters code or tests. Ask the operator whether to proceed:

```
AskUserQuestion:
  Review complete — <N> findings recorded (severity H/M/L: <counts>).
  Proceed to receiving-code-review?
    (a) yes — let receiving-code-review dispatch per-finding corrections
    (b) review findings first — open /tmp/code-review-<STEP_ID>.md
    (c) stop — I want to triage manually
```

If `(a)`, append `{action: "handoff-to-receiving-code-review"}` to the step's `reviewHistory[]`. If `(b)`, render `code-review.jq` to `/tmp/code-review-$STEP_ID.md`, then re-ask. If `(c)`, flip status to `STOPPED`, emit stop line.

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

**Banned from chat output:** findings list, cyclomatic tables, regression-run breakdowns. All of that data lives in the JSON.

---

## Non-negotiables

- **Output language: English.** All JSON payload fields in English. Conversational wrapper follows operator's language.
- No corrections applied. Read-only review.
- Prompt 2 (review tier) fires by default; skipped when `tier: <value>` is pre-registered in invocation args alongside `.config.mode == "autonomous"` (see Phase 3 pre-registered skip path).
- Mandatory members always present: senior-engineer, software-architect, qa, regression-tester.
- Cyclomatic audit ALWAYS conducted by senior-engineer, with threshold + per-file verdict.
- Every mandatory agent receives diff + `browzer deps --reverse` + `browzer mentions` and may run `browzer explore` to detect prior art.
- Regression-tester runs scoped tests; never alters them. Mutation testing belongs to `write-tests` and runs AFTER `receiving-code-review` closes findings.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — the master pipeline invokes this skill AFTER all `TASK` steps complete. The orchestrator then chains to `receiving-code-review` to apply corrections, then `write-tests` for green coverage + mutation testing.
- **Standalone** — operator invokes directly to re-review after iterating on fixes. Re-invocation writes a new `CODE_REVIEW` step (with a new NN index); the old one stays as a historical record.

---

## Related skills and references

- `execute-task` — runs before; produces the files this skill reviews.
- `receiving-code-review` — runs after; consumes `codeReview.findings[]` and dispatches per-domain fix agents.
- `write-tests` — runs after `receiving-code-review`; authors green tests for the final file set + runs mutation testing.
- `update-docs` — runs after `write-tests`; patches docs affected by the final file set.
- `feature-acceptance` — runs after update-docs; verifies AC / NFR / metrics.
- `references/subagent-preamble.md` — paste into every dispatched agent's prompt.
- `references/workflow-schema.md` — authoritative schema (`codeReview`, `cyclomaticAudit`, `regressionRun`).
- `references/renderers/code-review.jq` — markdown renderer invoked in review mode.
- `references/mandatory-members.md` — role briefs for senior-engineer, software-architect, qa, regression-tester.

## Render-template surface

Downstream skills (`receiving-code-review`, `write-tests`, `commit`, `feature-acceptance`) consume a compressed code-review summary via `browzer workflow get-step <step-id> --render code-review`. The template emits one screen of context (mode, tier, scope, reviewers, severity counts, top-priority highs, themes) suitable for embedding in subagent dispatch prompts without sending the full findings payload.
