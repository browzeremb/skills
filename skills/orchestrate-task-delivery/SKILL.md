---
name: orchestrate-task-delivery
description: "Master orchestrator for implementing any feature, bugfix, or change in a Browzer-indexed repo. Use proactively whenever the user wants to build, ship, fix, or refactor anything that touches more than a few files — even if they just say 'add X', 'implement Y', 'can we build Z', or 'fix this'. Drives the full dev workflow: brainstorming (when input is vague) → generate-prd → generate-task → execute-task → update-docs → commit. Auto-injects quality phases (test-driven-development → write-tests → verification-before-completion) when the repo has a test setup. Grounds every decision in browzer explore/search/deps before touching code. Delegates all implementation to specialist subagents with the right model (opus for architecture, sonnet for features, haiku for lookups). Also trigger on mid-workflow entries: 'execute TASK_03', 'update the docs for this change', 'commit what I staged', 'ship this end-to-end', 'write a PRD for X', 'break this into tasks', 'run the first task' — even when the user does not name the workflow explicitly. Skip only for trivial ≤3-file read-only lookups or direct questions that require no code change."
---

You are the task orchestrator for this repository. Your job: **route → ground in browzer context → invoke the right skill → validate shape → move to the next phase**. You do not implement. You do not hold large prompts in your head — the skills do.

## Turn-end contract — read this BEFORE starting the flow

This orchestrator drives a continuous chain. Most of your responses MUST contain a `tool_use` block. The ONLY valid terminal responses (responses with no `tool_use`, ending the turn and returning control to the operator) are:

1. **Final success line** emitted once at end-of-chain: `orchestrate-task-delivery: shipped TASK_01..TASK_NN via 5-phase flow (commit <SHA>)`.
2. **Explicit stop line** when a Step 6 stop-condition fires OR Step 4 validation fails twice: `orchestrate-task-delivery: stopped at phase <N> — <reason>` + `hint:` line.
3. **One-question-max clarification** from the "When to ask vs. act" section, inside its budget.

**Everything else is non-terminal.** When a sub-skill's `Skill(...)` call returns — e.g. `generate-prd: wrote PRD.md`, `generate-task: wrote N TASK files`, `execute-task: HANDOFF_NN.json written` — that return value is a **tool result**, not a turn-end signal. Your next response to that tool result MUST contain a `tool_use` block: the next-phase `Skill(...)`, a `TodoWrite` update, or a `Read(...)` of the report JSON if Step 4 validation requires it. Then immediately another `Skill(...)` in the response after that.

**Anti-pattern this contract exists to prevent.** The sub-skill returns its one-line confirmation. You parse the tool result, quote the confirmation as plain text, and end your response with nothing else. That quote-as-final-text is a silent pause — the operator now has to type "continue" to unstick the flow. **This is the bug, not a checkpoint.** Every mid-flow turn where you emit only the sub-skill's confirmation and stop is a routing failure the operator has to paper over with a nudge. You were explicitly told "I'll chain to the next phase" — do it: the chain happens at the tool-result boundary, not at some later operator prompt.

**Self-check before emitting any response.** Ask: "Does this response correspond to clause 1, 2, or 3 above?" If no, the response MUST contain at least one `tool_use`. If you catch yourself about to emit a response with only text and no tool call, and it's not one of the three terminal cases, go back and add the next-phase `Skill(...)` call before emitting. The natural urge to end the turn after a rich tool result ("the sub-skill said it's done, so I'm done") is the exact bias this contract overrides. "generate-prd: wrote PRD" means phase 1/6 is done — phases 2–6 are still ahead, in this same driven flow, starting immediately.

**When you DO quote the confirmation as text.** Fine — but the SAME response that quotes it MUST also contain the next `Skill(...)` tool_use. Quote-then-tool-use in one response is the pattern; quote-alone is the anti-pattern.

---

## Per-task invocation contract — apply to every TASK_NN

Step 3 below lists the phases in order, but phases are silently skippable if the orchestrator "forgets" or conflates them into a single subagent dispatch. This contract is the forcing function: for every TASK_NN in the plan, execute the per-task sequence and, **whenever you skip any step, write a TodoWrite entry stating the skip reason with the specific criterion from the skip-list BEFORE invoking the next phase**. A missed quality phase is detected after-the-fact as a missing TodoWrite line — a retro that catches one will cite this section.

### Per-task sequence when task has `**Trivial:** false`

1. **Phase 2.5 — pre-execute (TDD).** Invoke `test-driven-development` UNLESS: (a) task Scope is entirely test files (nothing new to write red tests for); (b) task is pure config / docs / migration (no testable logic); (c) operator explicitly passed `enabled: false` in the orchestrator invocation. Skip → TodoWrite `"TASK_NN phase 2.5 skipped: <one of a/b/c>"`. "Convenient to fuse with execute-task" is NOT a valid skip reason; that's exactly the retro-flagged mistake.

2. **Phase 3 — execute.** Invoke `execute-task`. Wait for `.meta/HANDOFF_NN.json` on disk. Read it (Step 4 gate) before moving on.

3. **Phase 3.5 — green tests.** Invoke `write-tests` in `green` mode with `files: <HANDOFF_NN.files.modified>` UNLESS: (a) `HANDOFF_NN.files.modified` is empty; (b) all modified files ARE test files (already covered); (c) task is pure config / docs. Skip → TodoWrite with reason. Note: TDD may already have authored the tests — `write-tests` in green mode is for _complementary coverage_ beyond the red set, not a duplicate of TDD.

4. **Phase 3.75 — verify.** Invoke `verification-before-completion` with the same files UNLESS: (a) task is Trivial:true (already handled by Trivial fast path); (b) repo has no mutation testing tool configured (the skill self-detects and self-skips mutation; blast-radius gates still run). "Mutation run would take >30min" is a legitimate `--skip-mutation` argument but MUST be an EXPLICIT decision — either the operator requested it, or you measured it once this session and logged to TodoWrite. The orchestrator alone silently pre-empting mutation is the retro-flagged failure mode (the test-debt task in the retro had Stryker configured and mutation was skipped with no justification).

5. **Phase 4 — docs propagation.** Invoke `update-docs` with `files: <HANDOFF_NN.files.modified>` UNLESS `HANDOFF_NN.files.modified` is empty. **Run this BEFORE the next TASK_N+1's Phase 2.5 invocation, not batched at end-of-chain.** Docs referenced by a changed file go stale the moment the change lands; per-task docs propagation is the whole reason this phase exists. Batching at end increases the chance the docs update is forgotten entirely — the retro documented update-docs being silently skipped across 3 code-touching tasks because it was deferred until there was no natural trigger.

6. **Phase 5 — commit.** Per task-level granularity declared in PRD §13. Default: one commit per task.

### Per-task sequence when task has `**Trivial:** true`

Skip 2.5 / 3.5 / 3.75 / 4. Run the inline-edit fast path (≤15 lines, single-layer, deterministic — see "Trivial-task fast path" below), then commit directly. Still emit `HANDOFF_NN.json` per the preamble — automation consumers depend on its schema being present.

### Self-audit GATE before dispatching TASK_N+1

Before `Skill(test-driven-development)` or `Skill(execute-task)` for TASK_N+1, answer these three in your TodoWrite plan (a single entry per task closure is fine):

- **HANDOFF_N exists on disk?** (mandatory; if no, go back to Phase 3 for TASK_N)
- **TASK_N quality phases ran OR each skip reason logged with criterion?** (mandatory; if no, go back)
- **TASK_N update-docs ran OR HANDOFF_N.files.modified is empty?** (mandatory; if no, go back)

If any answer is "no", that's a missed step — fix it before moving on. The orchestrator's job is **per-task phase completeness**, not just sequential dispatch.

---

## The cardinal rule: orchestrate, never implement

You coordinate. Non-trivial work gets delegated: first to the matching workflow **skill**, which in turn drives specialist **subagents** via the shared brief at `../../references/subagent-preamble.md` (relative to this SKILL.md; same directory tree as the plugin — no absolute path). You stay in the routing and validation layer.

**Delegate to a skill when the user's request maps to any workflow phase:**

| User intent                                                          | Skill to invoke                    | Phase     |
| -------------------------------------------------------------------- | ---------------------------------- | --------- |
| "I have an idea", "help me think about", "what if we…", "rough sketch" | `brainstorming`                  | 0 (pre)   |
| "write a PRD", "spec this feature", "document these requirements"    | `generate-prd`                     | 1/6       |
| "break this into tasks", "generate tasks", "plan the PRs"            | `generate-task`                    | 2/6       |
| "red test first", "tdd this", "write the failing test"               | `test-driven-development`          | 2.5 (pre-execute) |
| "execute TASK_N", "implement this task", "ship the feature"          | `execute-task`                     | 3/6       |
| "write tests for this change", "cover these files"                   | `write-tests`                      | 3.5 (post-execute) |
| "verify before commit", "check blast radius", "mutation test"        | `verification-before-completion`   | 3.75 (pre-docs) |
| "update the docs", "sync docs with this change", post-implementation | `update-docs`                      | 4/5       |
| "commit this", "write the commit message"                            | `commit`                           | 5/5       |
| "sync the workspace", "re-index browzer", "refresh the index"        | `sync-workspace`                   | manual    |

The 5-phase nomenclature refers to the CORE pipeline. Quality phases (0, 2.5, 3.5, 3.75) auto-inject when the repo has a test setup AND the task isn't marked opt-out — they are not separate flows, they are decorations on the core flow. Workspace re-indexing (`sync-workspace`) is **not** a core phase — it runs automatically via the `browzer-sync-on-push` hook on every `git push`. Invoke `sync-workspace` manually only when the user explicitly asks to sync without pushing, or to force a re-index mid-session.

**Do it yourself (no skill, no subagent) only for:**

- Trivial direct questions, lookups, ≤3-file read-only answers.
- Running `browzer status`, `browzer explore`, `browzer search`, `browzer deps` to gather context.
- Routing decisions and TodoWrite planning.
- **Integration glue writes capped at <15 lines**, and only for: a barrel export, a one-line import, a one-line config key. Nothing else qualifies.

**Inline-edit hard cap — no exceptions.** If the change is >15 lines, OR touches a doc / runbook / multi-line markdown block, OR modifies actual logic (not just wiring), you MUST dispatch a haiku-tier subagent. "It's just a quick edit" is the thought that dumps a 124-line runbook into the orchestrator's working set. The haiku dispatch costs ~3 min and keeps your context clean; the inline shortcut costs context budget for the rest of the session.

**Why this matters:** if you try to execute a feature inline, you run 100+ turns doing investigation + implementation + review + commit in one thread. Instead: you stay a lightweight router, the workflow skill spawns the right specialist subagents, and the total cost stays sane.

---

## Preflight — tool availability

Before anything else, confirm the plan/todo tools are loaded. In many sessions they arrive as deferred schemas:

```
ToolSearch(query: "select:TaskCreate,TaskUpdate,TaskList,TodoWrite", max_results: 4)
```

Both name families may coexist depending on harness version (`Task*` is current; `TodoWrite` is a legacy alias). Load whichever the `select:` call returns — they are functionally equivalent for plan tracking. If ToolSearch returns NEITHER family (rare — older harness or stripped-down subagent environment), fall back to recording plan progress as inline prose in your response body. Structured todos are preferred for auditability, but the per-task invocation contract and skip-reason logging still apply in their meaning; the scaffolding just shifts from tool calls to prose. One call, happens once per session, unblocks Step 2.

---

## Step 0 — Load method specialists (default ON)

Before planning, identify which **method domains** your task touches and load the specialist skills the target repo provides for those domains. Most reliably differentiates a routing session from a "model just solves it" session: the model can reason about queues or HTTP routes from general knowledge, but a repo-specific specialist skill encodes **this codebase's** conventions.

**How**: For each domain your task touches (use the vocabulary table below), invoke the `find-skills` skill with the domain-specific query:

```
Skill(skill: "find-skills", args: "<domain keywords from the table>")
```

`find-skills` checks project-local (`.claude/skills/`), personal (`~/.claude/skills/`), and the wider ecosystem via `npx skills find`. It returns installed skills ranked by relevance — extract the **High-tier** matches and invoke them before Step 1. Prefer skills already installed in the repo; only suggest `npx skills add …` if a genuine gap exists and the user confirms.

**MANDATORY — enumerate the vocabulary table row by row before emitting "none".** The declaration has exactly two valid forms:

**Form 1 — matches found** (typical; most non-trivial tasks touch at least one row):

> Specialists loaded: [name1, name2, ...] — matched rows: [queue→bullmq-specialist, infra→docker-expert, ...]

**Form 2 — genuinely no matches** (rare; lookup-only flows, commit-only flows). You MUST enumerate every row of the vocabulary table and explicitly dismiss each with one reason per row:

> Specialists loaded: none — vocabulary audit: queue (no queue/job/consumer signal in scope); cache (no cache/TTL signal); web-framework (no route/middleware/handler); database (no migration/ORM/query); auth (no session/OAuth/JWT); observability (no trace/metric/dashboard); rag (no embed/vector/rerank); infra (no container/compose/CI). No row fired.

The bare "Specialists loaded: none" form WITHOUT per-row enumeration is an audit failure. A retro that finds a missing specialist for a domain the task clearly touched (e.g. `BullMQ queue` work without `bullmq-specialist`, `docker-compose healthcheck` work without `docker-expert`) will cite this exact line of the skill. Be honest about half-matches: "marginally relevant" should tilt toward loading — specialists loaded and unused cost less attention budget than specialists missing when needed. The declaration is auditable evidence Step 0 actually ran; a reviewer reading the TodoWrite plan should see the per-row audit without reconstructing from tool-call history.

**Vocabulary → domain** (repo-agnostic — specialist names vary per repo):

| Vocabulary signal                                             | Probable domain        | `find-skills` query                       |
| ------------------------------------------------------------- | ---------------------- | ----------------------------------------- |
| queue, job, worker, consumer, concurrency, dedup, retry, lock | background processing  | `"queue worker job consumer"`             |
| cache, rate-limit, TTL, pub/sub, in-memory store              | caching / K-V store    | `"cache redis rate-limit"`                |
| route, schema, middleware, handler, controller, validator     | web framework          | `"http route handler middleware"`         |
| migration, ORM, query, transaction, index, connection pool    | database / data access | `"database orm migration query"`          |
| session, OAuth, token, JWT, RBAC, permission, trusted origin  | auth / authz           | `"auth session oauth rbac"`               |
| trace, span, metric, dashboard, log correlation               | observability          | `"observability tracing metrics"`         |
| embed, vector, chunk, retrieval, rerank, hybrid search        | RAG / semantic search  | `"rag vector embedding retrieval"`        |
| container, image, compose, CI, deploy, runtime config         | infra / devops         | `"docker deploy infra ci"`                |

These are **domain patterns, not skill names**. Specific specialist names are discovered per repo via `find-skills`. If no specialist exists for a domain in the target repo, note it and proceed without that hint — don't invent one.

**When to skip** (rare): single-phase Entry-point shortcut AND no nameable domain (e.g. "commit what I have staged" touches no domain from the table above). Log the skip reason as one line in TodoWrite so the omission is on the record.

**Hook bypass logging (non-negotiable)**: if a `PreToolUse:Grep`, browzer-guard, or other repo-installed hook fires telling you to run a `browzer search` / `browzer explore` before continuing, and you decide to proceed without running it, write **one short TodoWrite entry** explaining why before moving on. One line, imperative, concrete. Acceptable reasons: target isn't indexed, query intent doesn't match the hook's domain, explicit human override. Not acceptable: no entry at all. An unjustified bypass is detectable after-the-fact as a missing TodoWrite entry in the session log — and if an audit catches one, the skill loses credibility.

---

## Step 1 — Browzer context (always first)

Before invoking any skill, ground the request in the target repo. Let browzer tell you what this repo is — don't assume.

```bash
browzer status --json                                               # auth + workspace sanity

# Code question → explore
browzer explore "<precise query>" --json --save /tmp/explore.json

# Doc / architecture / ADR / prior art → search
browzer search "<topic>" --json --save /tmp/search.json

# Blast radius before a refactor → deps (--reverse for blast radius only)
browzer deps "<path/to/file.ts>" --reverse --json --save /tmp/deps.json
```

Extract: **file paths**, **line ranges**, **symbol names**, `exports` / `imports` / `importedBy`, `score`, `lines`. Pass this into the skill you invoke — without it, the skill works blind.

Cap **explore/search content queries** at 3–4 per routing turn. `browzer status`, `browzer deps`, and the Step 0 skills-check don't count toward the cap — they're cheap structural probes. Deeper exploration belongs to the skill itself (`generate-task` and `execute-task` each run their own targeted rounds).

**Filesystem-reality checks are allowed.** `ls <path>`, `stat <path>`, `test -f` — these answer "does this exist / what extension / empty dir?" and are fine before `browzer explore`. They are NOT substitutes for **code search**: if the question is "where does `requireAuthz` live?" or "what imports `@browzer/core/rag-client`?", use `browzer explore` / `deps` regardless of what `ls` shows.

---

## Step 2 — Plan with TodoWrite

Write the plan before invoking anything. Include quality phases when the repo has a test setup — run `scripts/detect-test-setup.mjs` once at the top of the session (or `test -f package.json && grep -q '"test"' package.json` as a quick heuristic) so `TDD_ENABLED` / `WRITE_TESTS_ENABLED` / `VERIFICATION_ENABLED` are known state:

```
TodoWrite([
  { content: "browzer context: <what you found>", status: "completed" },
  { content: "test setup probe: <has/none — from detector>", status: "completed" },
  { content: "phase 0 (if input vague): invoke brainstorming", status: "pending" },
  { content: "phase 1: invoke generate-prd with <scope>", status: "in_progress" },
  { content: "phase 2: invoke generate-task (reads PRD from disk)", status: "pending" },
  { content: "phase 2.5 (quality, if test setup): invoke test-driven-development for TASK_01", status: "pending" },
  { content: "phase 3: invoke execute-task TASK_01", status: "pending" },
  { content: "phase 3.5 (quality, if test setup): invoke write-tests (green) with files from HANDOFF_01", status: "pending" },
  { content: "phase 3.75 (quality, if test setup): invoke verification-before-completion with files from HANDOFF_01", status: "pending" },
  { content: "phase 4: invoke update-docs with files from HANDOFF_01", status: "pending" },
  { content: "phase 5: invoke commit", status: "pending" }
])
```

Mark items done as each skill returns. Quality phases are **opt-out**, not opt-in — default is to run them when the detector says test setup exists. Operator can disable per-task (`test-driven-development` accepts `enabled: false`; `verification-before-completion` accepts `--skip-mutation`). If the detector says no test setup, skip all three quality phases and note the skip reason in TodoWrite — don't bootstrap a test framework from the orchestrator layer.

If the user enters mid-flow (they already have a PRD, they're fixing a bug that skips PRD), start at the right phase — do not force them through earlier ones for no reason. Quality phases still inject where they naturally belong (TDD before any `execute-task`, write-tests + verification after).

---

## Step 3 — Invoke the workflow skill

Use `Skill(skill: "<name>")` with a short argument that states the concrete ask. The PRD and task specs are **persisted to disk** under `docs/browzer/feat-<date>-<slug>/` — hand them off by **path**, not by assuming they survive in conversation context.

**Zero-pause between phases.** When a sub-skill returns its one-line confirmation, validate per Step 4 and **invoke the next phase's `Skill(...)` in the same response turn**. Do NOT stop and wait for operator input between phases — in a driven flow the orchestrator IS the operator, and the sub-skills' own chain contracts (e.g. `generate-task` "reply 'go' to start TASK_01") are written for stand-alone invocation, NOT for when the orchestrator is driving. A pause between successful phases is a routing bug, not a checkpoint. Never emit "shall I proceed to <next phase>?" — proceed. Legitimate stops (rare, and each one explicit in this skill already): (a) Step 4 validation fails → re-invoke the same skill with the correction; (b) a Step 6 stop-condition fires; (c) the chain naturally ends (post-`commit` line, or trivial-path direct-commit); (d) a Step 4 ambiguity requires the one-question-max clarification from the "When to ask vs. act" section. Anything outside (a)–(d) that makes you want to stop between phases is the bug — proceed and surface the concern inline in the next turn's TodoWrite entry instead.

Every `# ← AUTO-CHAIN` marker below is load-bearing: when the line above it returns its tool_result, your NEXT tool_use in the SAME response is the line below. Do NOT end your response between an AUTO-CHAIN pair. This annotation style exists because the top-level Turn-end contract was getting attention-diluted — the contract at the call site is the one that fires at the decision boundary.

```
# Phase 0 — only when the input fails generate-prd's saturation check:
Skill(skill: "brainstorming",    args: "<user's vague request verbatim>")
# → tool_result: "brainstorming: wrote BRAINSTORM.md ..."
# ← AUTO-CHAIN (same response): generate-prd call below

Skill(skill: "generate-prd",     args: "<user's feature idea or request>  # OR  brainstorm: docs/browzer/feat-<slug>/BRAINSTORM.md")
# → tool_result: "generate-prd: wrote docs/browzer/feat-<date>-<slug>/PRD.md (N lines)"
# ← AUTO-CHAIN (same response): generate-task call below — DO NOT end your response here with just the confirmation quoted.

Skill(skill: "generate-task",    args: "feat dir: docs/browzer/feat-<date>-<slug>")
# → tool_result: "generate-task: wrote N TASK_NN.md files under <feat>/; receipt at <feat>/.meta/activation-receipt.json"
# ← AUTO-CHAIN (same response OR after Step 4 validation if HANDOFF-style checks needed): per-task loop below, starting with TASK_01

# ════ PER-TASK LOOP START ════ (iterate N times for TASK_01..TASK_N, governed by the Per-task invocation contract)

# Phase 2.5 — quality (only when test setup exists + task's Trivial:false):
Skill(skill: "test-driven-development", args: "task: TASK_NN — spec at docs/browzer/feat-<slug>/TASK_NN.md")
# → tool_result: "test-driven-development: red confirmed, TDD_NN.json written"
# ← AUTO-CHAIN: execute-task below

Skill(skill: "execute-task",     args: "TASK_NN — spec at docs/browzer/feat-<date>-<slug>/TASK_NN.md")
# → tool_result: "execute-task: HANDOFF_NN.json written"
# ← AUTO-CHAIN: write-tests (green) below — unless HANDOFF.files.modified empty; then skip to update-docs check

# Phase 3.5 — quality (green test authoring):
Skill(skill: "write-tests",      args: "files: <paths from HANDOFF_NN>; mode: green; feat dir: docs/browzer/feat-<slug>")
# → tool_result: "write-tests: green, WRITE_TESTS_<ts>.json written"
# ← AUTO-CHAIN: verification-before-completion below

# Phase 3.75 — quality (last-line defence before docs/commit):
Skill(skill: "verification-before-completion", args: "files: <paths from HANDOFF_NN>; feat dir: docs/browzer/feat-<slug>")
# → tool_result: "verification-before-completion: VERIFICATION_<ts>.json written"
# ← AUTO-CHAIN: update-docs below (per Per-task invocation contract — docs propagate PER TASK, not batched)

Skill(skill: "update-docs",      args: "files: <paths from HANDOFF_NN>; feat dir: docs/browzer/feat-<date>-<slug>")
# → tool_result: "update-docs: UPDATE_DOCS_<ts>.json written"
# ← AUTO-CHAIN: commit below (PRD §13 default = one commit per task)

Skill(skill: "commit")
# → tool_result: "commit: <SHA> <subject>"
# ← AUTO-CHAIN: loop back to TDD 2.5 for TASK_(N+1) if tasks remain; else emit final success line per Output contract.

# ════ PER-TASK LOOP END ════

# Workspace re-index happens automatically via the browzer-sync-on-push hook on git push.
# If the chain ends in commit-but-no-push state, emit the sync nudge per §"Post-ship: workspace re-index".
```

Copy each skill's chain-contract line verbatim when invoking the next — `generate-prd`'s confirmation already spells the exact `feat dir:` path, `generate-task`'s the exact `TASK_N — spec at …` string, `execute-task`'s the exact `HANDOFF_NN.json` path. No guessing.

### Quality-phase gating (read once per session)

At the top of the session, probe the test setup:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/detect-test-setup.mjs" --repo . > /tmp/orchestrator-test-setup.json 2>&1 \
  || node "$(find ~/.claude/plugins -type f -name 'detect-test-setup.mjs' 2>/dev/null | head -1)" --repo . > /tmp/orchestrator-test-setup.json
```

Read `/tmp/orchestrator-test-setup.json`. Use `hasTestSetup` to decide:

- `true` → inject `test-driven-development`, `write-tests`, `verification-before-completion` per-task by default.
- `false` → skip all three quality phases; log the reason in TodoWrite (`hint` from the detector output). Core 6 phases still run.

Per-task overrides:

- **`Trivial: true` in task header** → skip `test-driven-development`, `write-tests`, AND `verification-before-completion`; execute inline (direct haiku Agent capped at 15 lines), then `commit` directly — no separate `update-docs` call. Read the flag with: `grep "^\*\*Trivial:\*\*" docs/browzer/feat-<slug>/TASK_NN.md`. Record the skip as one TodoWrite entry: `"TASK_NN — trivial path: inline edit + direct commit, quality phases skipped"`.
- **Operator says "no TDD for this task"** → pass `enabled: false` to `test-driven-development`.
- **Task's Scope is entirely test files** → skip `test-driven-development` (it self-skips via its Phase 2 applicability check, but the orchestrator can short-circuit).
- **Task is pure config / docs / migration** → skip `test-driven-development` AND `write-tests`; verification runs (still useful — lint/typecheck).
- **Mutation run would take >30 min on this repo** → pass `--skip-mutation` to `verification-before-completion`, keep blast-radius regression coverage.

Skills own their own prompts, their own browzer queries, their own subagent dispatch, and their own validation. You do not duplicate that logic here — if you find yourself rewriting what's in a skill, invoke the skill instead.

### Baseline handshake (before first dispatch)

Before invoking the first `Skill(execute-task)` or `Agent(...)` of any batch, capture a repo-wide baseline at **your** layer. Do not assume the repo is green between sessions: config edits, merged PRs, and infra changes silently break gates.

Run the repo's actual quality gates. Discover them from `CLAUDE.md` / `AGENTS.md` / `package.json` scripts / `Makefile`. For a pnpm + Turborepo layout, usually:

```bash
pnpm turbo lint typecheck test --filter='...[origin/main]'
```

Interpret the result:

- **Green** → log counts in TodoWrite ("baseline: 47 tests pass, 0 lint, 0 ts"). Proceed.
- **Red that isn't yours** → STOP and ask: *"baseline is red — X failures in Y. Fix baseline first, skip the affected package, or proceed knowing we can't distinguish new regressions from pre-existing?"*
- **Infra missing** (Postgres / Redis / Docker down, `.env.local` absent) → STOP and ask. Do not silently degrade the gate set to make the baseline "pass".
- **Ambiguous** → STOP and ask which gates to run.

**Re-capture** when an earlier task edited gate-shape files (vitest config, `turbo.json`, CI workflow, schema migrations, new script wired into `lint` / `typecheck`). Those change what "green" means.

**Why at this layer**: `execute-task` captures baseline per task in its own phase, but that disappears when you drop to direct `Agent(...)` or fuse tasks. The orchestrator handshake is the only place that catches broken-state drift across sequential dispatches.

### Baseline ledger — deduplicate identical gate runs within a session

The naive handshake runs `pnpm turbo lint typecheck test` at the orchestrator layer; then the subagent preamble runs the same command at Step 2 of its own flow; then post-change; then `verification-before-completion` runs it again. At ~25s per call on a medium monorepo, a single non-trivial task can burn 100+s on duplicate IDENTICAL runs. Over a 5-task feature that's 8+ minutes of wall-time spent re-confirming facts a previous turn already established. The retro documented exactly this: TASK_03 consumed ~50s on pure baseline duplication.

**Ledger.** Maintain `docs/browzer/feat-<slug>/.meta/baseline-ledger.json` across the session. Schema:

```json
{
  "entries": {
    "<HEAD_SHA>:<package-or-asterisk>:<gate-command>": {
      "status": "green" | "red",
      "counts": { "tests": 1309, "lint": 0, "typecheck": 0 },
      "capturedAt": "<ISO 8601>",
      "capturedBy": "orchestrator" | "subagent-TASK_03" | "verification-before-completion"
    }
  }
}
```

**Consult-before-run.** Before any gate command at the orchestrator layer (baseline handshake, Step 4 re-confirm, Trivial fast-path gate, per-task Phase 3.75 verification), compute the key and read the ledger. If the entry:

- **Exists, `status: green`, HEAD SHA matches HEAD, `capturedAt` < 5 minutes ago** → cite it in TodoWrite (`"TASK_04 baseline: 1309 tests from ledger (captured by subagent-TASK_03 at 14:22:03, HEAD abc1234)"`) and skip the re-run.
- **Exists but HEAD advanced OR `capturedAt` > 5min ago** → stale; re-run, overwrite.
- **Missing** → run, write entry with the appropriate `capturedBy`.

**Invalidate on gate-shape edits.** If a prior task edited `vitest.config.ts`, `turbo.json`, a CI workflow, schema migrations, or a script wired into `lint` / `typecheck` / `test`, delete the ledger (`rm <feat-dir>/.meta/baseline-ledger.json`) before the next handshake — "green" means something different when the gate definition changed.

**Subagent contribution is authoritative.** When `HANDOFF_NN.json.gates.baseline` or `.postChange` is present, the orchestrator MUST treat it as a ledger entry (key: `<HEAD_SHA>:<subagent-package>:<exact-command>`, capturedBy: `subagent-TASK_NN`) and NOT re-run an identical gate within the TTL window. The duplication retro called out the pattern: subagent reports "1309 → 1312 passing" in the HANDOFF, and then the orchestrator re-runs the same `pnpm test` verification at its own layer — that is redundant. Read the HANDOFF, trust the numbers, move on.

**Hard limit.** TTL is intentionally short (5min) because formatter hooks, `pnpm install` runs, or PostToolUse hooks can mutate files between gate runs. If in doubt, re-run — the ledger is a cost-down optimization, never a correctness path. Also: the ledger is NOT a substitute for Step 4 HANDOFF validation — Step 4 reads the HANDOFF regardless; the ledger just prevents the orchestrator from re-running the exact gate the HANDOFF already captured.

**Formatter delegation** — in Browzer-initialized repos the plugin ships a PostToolUse `Edit|Write` hook (`auto-format.mjs`) that runs the repo's formatter in-loop after every edit; **default `HAS_AUTOFORMAT=yes`**. Record it in TodoWrite and strip `biome check` / `prettier` / `ruff format` from every subagent prompt's quality-gates list. Flip to `no` only if: the working tree is not Browzer-initialized (`.browzer/config.json` missing), the operator has `BROWZER_HOOK=off`, or a fresh-session smoke test shows the hook did not fire. The `subagent-preamble.md` §"Formatter delegation" section has the non-Browzer fallback logic.

### Trivial-task fast path

Before dispatching the per-task pipeline for each TASK_NN, read the `**Trivial:**` header field:

```bash
grep "^\*\*Trivial:\*\*" docs/browzer/feat-<slug>/TASK_NN.md
```

- **`Trivial: false` (default)** → full pipeline: `test-driven-development` → `execute-task` → `write-tests` → `verification-before-completion` → `update-docs` → `commit`.
- **`Trivial: true`** → inline-edit path:
  1. Dispatch a **haiku** Agent with the task spec (inline, ≤15-line edit).
  2. Run `pnpm turbo lint typecheck test --filter=<pkg>` as the sole gate.
  3. Invoke `commit` directly — no `write-tests`, no `verification-before-completion`, no separate `update-docs`.
  4. Log to TodoWrite: `"TASK_NN — trivial path: inline edit + direct commit, quality phases skipped"`.

This is the safe path: the Trivial flag is only valid for single-layer, ≤3-file, deterministic tasks that never touch authz, billing, migrations, or invariant-bearing files — `generate-task` enforces this contract at emission time.

### File handoff for large plans (>5 tasks)

`generate-task` persists each task to `docs/browzer/feat-<slug>/TASK_NN.md`. For plans >5 tasks, it emits only a summary table + paths in chat. Pick up `$FEAT_DIR` from `generate-task`'s chain-contract line.

**Dispatch by path reference**, not by re-embedding bodies. Pasting a task body back into the conversation undoes what `generate-task` just persisted.

```
Skill(skill: "execute-task", args: "TASK_07 — spec at docs/browzer/feat-<slug>/TASK_07.md")
```

Direct `Agent(...)` dispatch follows the same shape. Critical: **the subagent cannot resolve plugin-relative paths** (its CWD is the user's repo, not the plugin dir). So the orchestrator reads the preamble from its own context and **pastes the content** into the subagent prompt — never ships a path the subagent would have to resolve.

```
# Orchestrator step, not subagent step — run in your own context:
Read `../../references/subagent-preamble.md` (relative to this SKILL.md).

# Then dispatch, with the preamble body inlined:
Agent(
  subagent_type: "general-purpose",
  prompt: """
    Read docs/browzer/feat-<slug>/TASK_07.md for the full task spec.

    Execute the task end-to-end, following these rules (inlined from the
    Browzer plugin's subagent-preamble.md):

    <PASTE PREAMBLE §Step 1 through §Step 5 HERE>
    <OR: paste a task-tailored distillation when the full preamble exceeds
     ~100 lines of prompt budget — the Step 4 HANDOFF schema is mandatory>

    Write the HANDOFF report per the preamble's Step 4 to
    docs/browzer/feat-<slug>/.meta/HANDOFF_07.json. Return one line with
    the HANDOFF path, nothing else.
  """
)
```

The full HANDOFF schema lives in the preamble — you paste it, you don't ship a file reference.

**Reading HANDOFFs**: the dispatch returns a one-line ACK. Read the HANDOFF only when you need to decide — before the next dispatch (did a scope adjustment affect the dependency chain? did a gate regress?) or before `update-docs` / `commit`. If the ACK says `ok` and `nextHint` is a no-op, don't read; let the file sit on disk for audit.

**Why this scales**: the main thread carries paths (O(1) per task) instead of bodies (~50–200 lines each). A 20-task run drops from ~7k lines of inline context to ~100 lines of paths + a handful of targeted HANDOFF reads. Below ~5 tasks the overhead exceeds savings; keep small plans inline.

**Parallel dispatch IS the default for disjoint tasks.** The retro documented 3 disjoint tasks (core storage change + queue JSDoc rewrite + docker-compose config tweak) running strictly serially and burning ~10–15min of wall-time the orchestrator could have avoided by fanning out. When multiple tasks are ready to execute and their scopes are non-overlapping, dispatch them as parallel `Task()` calls in a single response turn — do NOT queue them sequentially by default.

**Parallel-eligibility checklist** (ALL four must hold per candidate batch):

1. **Scope file sets disjoint** per `generate-task`'s per-task Scope tables. `packages/queue/src/queues.ts` in TASK_A and `apps/api/src/routes/search.ts` in TASK_B is disjoint; two tasks both editing a barrel export is NOT.
2. **No direct `Depends on: TASK_X` chain** between them. Forward-only dependency rule still applies; a dependent task waits for its predecessor.
3. **No shared invariant family.** Two tasks both editing billing-invariant-bearing files is NOT eligible even if the file sets differ — a regression in one blast-radius-invalidates the other, and batch-validation becomes ambiguous. Similarly: two auth-surface tasks, two migration tasks. When in doubt, treat same-invariant-family as overlap and serialize.
4. **Trivial pairing constraint.** If one task is `Trivial: true` and the other is `Trivial: false`, keep the trivial one inline-sequential (inline-edit finishes in seconds; batching it against a multi-minute dispatch adds overhead, not parallelism). Two Trivial-true in a row: still serial-inline.

**How to dispatch in parallel.** One response turn, N `Task(...)` tool_use blocks, each with `isolation: "worktree"` (worktree isolation is MANDATORY for parallel dispatch — even "file-set-disjoint" tasks can race on the pnpm lockfile, the git index, a shared vitest cache dir, or a lint cache). Log the fan-out in TodoWrite: `"parallel dispatch: TASK_03 + TASK_04 + TASK_05 (scopes disjoint per generate-task)"`. Collect HANDOFFs after all return, validate each per Step 4, THEN proceed with per-task update-docs for each non-empty files.modified.

**Parallel safety when overlap IS present (fallback).** If even ONE file overlaps, fall back to sequential. HANDOFFs are per-task so `HANDOFF_03.json` and `HANDOFF_04.json` never collide on disk, but source-file overlap produces torn writes. `isolation: "worktree"` eliminates filesystem overlap but not shared-state races (schema migrations racing each other; parallel DB writes on the same test database; two subagents both deciding to bump the same version number). Default for any overlap: serial.

Implementation: `Task(..., isolation: "worktree")` creates a temporary git worktree and runs the subagent there. For mechanics (directory selection, cleanup, safety verification), see `superpowers:using-git-worktrees`. Cleanup is automatic when the subagent makes no changes; otherwise the path + branch are returned for review.

### When direct `Agent(...)` replaces `Skill(execute-task)`

`execute-task` is the default for every task. It is acceptable — and sometimes cheaper — to drop to a direct `Agent(subagent_type: "general-purpose", ...)` dispatch for tasks N+1, N+2, … **only when ALL of these hold**:

1. `execute-task` ran at least once earlier in the session and established the pattern (baseline, subagent shape, gates).
2. The remaining tasks don't edit files already modified by prior dispatches, OR only **append** to shared files (never edit existing lines).
3. You'll run `execute-task`'s verification at this layer — quote the invariants, re-run the declared gates, confirm the regression table yourself by reading the HANDOFF JSON the direct dispatch still writes.
4. The Agent prompt is **under ~100 lines**. Any longer and you're re-implementing `execute-task` — invoke it instead. The preamble + task spec carry most of the weight; the per-dispatch prompt is just role, scope, and browzer context snippets.

If any of (1)–(4) fails, re-invoke `Skill(skill: "execute-task", args: "TASK_N")`. Document the drop-to-direct decision inline in TodoWrite so it's auditable. Direct dispatches MUST still write a HANDOFF JSON per the preamble's schema — the machine-readable report is not optional.

### Task fusion is legitimate

`generate-task` may emit tasks that turn out to touch overlapping files once browzer context is richer. You are allowed to fuse two adjacent tasks into one dispatch **when**:

- Both tasks edit the same file(s), or
- One task's validation requires the other's change to be present.

Note the fusion in TodoWrite (`phase 3: dispatch TASK_02+TASK_04 (shared file X)`). Forward-only dependency rule still applies: a fused dispatch must not reach forward into tasks not yet in the fusion.

---

## Step 4 — Validate skill output between phases

When a skill returns, check before moving on. Validation at this layer is about **shape and report completeness**, not about re-running quality gates — `execute-task` / `verification-before-completion` already ran them, and re-running at this layer is pure duplication.

- **Brainstorm report** → read `.meta/BRAINSTORM_<ts>.json`. Confirm `dimensionsOpen == 0` (or the remaining opens are acknowledged assumptions). If too many dimensions were left assumed (>3), consider routing back for a second lighter pass before PRD.
- **PRD** → does §7 (functional requirements) and §13 (acceptance criteria) have enough bite for `generate-task` to decompose? If "Handle X" with no observable signal, send back to `generate-prd` with the gap called out.
- **Task plan** → does every task have exact file paths (from browzer), a layer assignment, dependencies pointing only backward, and carried repo invariants (from `CLAUDE.md`) where relevant? If not, send back.
- **TDD report** → read `.meta/TDD_<ts>.json`. Confirm `redVerification.status == "confirmed"` and `unexpectedPasses == 0`. If any unexpected pass, the RED phase is broken — do NOT proceed to `execute-task`; re-invoke `test-driven-development` with the gap noted.
- **Execute report** → read `docs/browzer/feat-<slug>/.meta/HANDOFF_NN.json`. Check each declared gate ran and passed, `gates.postChange` shows no regression beyond tolerance, carried invariants are listed in `invariantsChecked` and tied to specific diff hunks. A missing gate is a red flag. You do **not** re-run gates yourself.
- **Write-tests report (green)** → read `.meta/WRITE_TESTS_<ts>.json`. Confirm `verification.status == "pass"` and `testsFailed == 0`. Any failure is either a buggy test (re-invoke `write-tests`) or a latent bug in the code `execute-task` just wrote (re-invoke `execute-task` with the regression noted).
- **Verification report** → read `.meta/VERIFICATION_<ts>.json`. Confirm `qualityGates` all pass, `blastRadius.consumersUntestable` reasons are legitimate, and `mutationTesting.score >= target`. A mutation score below target after reinforcement is NOT a blocker — decide with the operator whether to proceed.
- **Update-docs report** → read `.meta/UPDATE_DOCS_<ts>.json`. Confirm both passes ran (direct-ref matches + concept-level sweep), budget wasn't silently truncated, and each patched file has a reason. If budget exhausted with unverified candidates, decide: widen budget and re-run, or accept with a note.
- **Commit** → Conventional Commits v1.0.0-compliant? Detected and mirrored the repo's house style (scopes, trailers)?
- **Sync-workspace** (manual invocations only) → `browzer workspace sync` succeeded or short-circuited with "unchanged"? If pending jobs are in flight, wait or re-run with `--force` per `sync-workspace`'s guidance. Automatic re-index on push is handled by the `browzer-sync-on-push` hook — no need to validate here unless the user explicitly ran sync.

If a check fails, re-invoke the same skill with the specific correction — do not cascade broken output into the next phase. The quality phases are your early-warning system; a broken quality report is a signal to pause, not to race ahead to commit.

---

## Step 5 — Model selection (for any ad-hoc subagent you spawn yourself)

Most model selection happens **inside** the workflow skills — `execute-task` picks per-task models from the suggestions `generate-task` emits. You only pick a model when the user asks for something outside the workflow — "investigate this crash", "review this file".

| Task                                                                                             | Model      |
| ------------------------------------------------------------------------------------------------ | ---------- |
| Architecture decisions, security audits, complex multi-service refactors, deep bug investigation | **opus**   |
| Feature implementation, bug fixes, doc writing, test writing, code review                        | **sonnet** |
| File lookups, single-function reads, quick verifications, 1-file reformatting                    | **haiku**  |

**Pressure against defaulting to sonnet for everything**: the majority of routing sessions end with 100% sonnet dispatches. That's a cost leak on both ends. Concrete triggers:

- **haiku tier** (5–10× cheaper, fast enough, plenty smart for the shape of work) — if a task fits any of these, **dispatch haiku**:
  - Doc rewrite of an existing paragraph / section.
  - Deterministic regen (auto-generated API clients, OpenAPI stubs, fixture snapshots).
  - 1-file reformat (lint auto-fix, single-file biome check).
  - Single-symbol lookup ("where is `foo` defined?", "what imports `bar`?").
  - Runbook or new `.md` file write (creation, not architectural reasoning).
  - Append-only doc edit.
  - Inline integration-glue extracted per the <15-line cap — when the work BARELY fits but you chose to dispatch for context hygiene.
- **opus tier** — multi-package refactor, security audit, novel bug whose root cause is non-obvious after 15min, any prompt that reasons across 4+ files. Sonnet here produces plausible-but-wrong fixes that cost more to revert than opus cost to run.
- **sonnet** — everything else (single-service feature, bugfix with a clear hypothesis, standard commit/test writing).

When in doubt on a decision: go higher. Under-powered reasoning produces wrong output that costs more to fix.

### Influencing model selection in workflow skills

Per-task model assignment belongs to `generate-task`, not `execute-task`. The `generate-task` skill emits a `suggested model` column per task; `execute-task` reads it when dispatching. Do **not** pass a model to `execute-task` — its `argument-hint` is `[TASK_N | task-number | free-form task description]`. Inventing `"TASK_06 | model: haiku"` misroutes the call into the "free-form description" branch and re-runs `generate-task`.

The correct lever is natural-language guidance in `generate-task`'s args, which the skill incorporates into its per-task suggestions:

```
Skill(skill: "generate-task", args: "Decompose <PRD>. Note: single-file doc regen
tasks should be tagged haiku-tier; multi-service or security-adjacent tasks
should be tagged opus-tier.")
```

`execute-task` then picks up the tagged model. If you need to override after the fact, re-invoke `generate-task` with an updated hint rather than fighting `execute-task`'s parser.

### Contract discipline

Args you pass to any sub-skill must match what the sub-skill actually parses — check its `argument-hint` and Phase-0 resolution logic before inventing syntax. A sub-skill that doesn't recognize your hint will either ignore it silently or misroute the call — both degrade the pipeline without an obvious error surface.

---

## Step 6 — Stop conditions

Break the loop when any of these fire — don't hammer through:

- **3-strike external failure** — gate / service returns non-2xx three times in a row. Document, handback. No fourth retry.
- **Hook bypass needed** — write the reason in TodoWrite **before** using `--no-verify` / `git commit -F`. Unjustified bypass = skill bug, file it.
- **Scope creep mid-phase** — user's ask grows while you're executing. Stop, report progress, ask. Don't fold new scope into the current dispatch.
- **Stalled validation** — Step 4 fails the same check twice in a row on the same skill output. Re-read the skill's output end-to-end, escalate.

---

## When to ask vs. act

- **Act immediately:** workflow phase is obvious from the request, browzer gives enough context, change is reversible.
- **Ask first (one clarifying question max):** ambiguous phase (is this a PRD or a direct bug fix?), destructive ops (force push, data delete), scope that flips between packages after browzer returned conflicting results.

**Modifications outside the target repo are always "ask first"**, even when non-destructive and backed by timestamped backups. Symlinks into `.claude/plugins/`, edits to `~/.claude/*`, changes to any shared user-level config fall under "shared state that isn't this repo" and need confirmation regardless of how reversible the op is.

One question — then act.

---

## Post-ship: reviewer feedback (CodeRabbit, PR comments)

If a reviewer flags an already-committed change after `commit`, delegate to `superpowers:receiving-code-review` **when the `superpowers` plugin is installed** — it owns the "verify the feedback is valid → decide fix vs. close → re-dispatch through `execute-task` or direct Agent as appropriate" loop. If `superpowers` is not available in the target environment, handle the review feedback inline as a mini loop: one `generate-task` invocation for the fix (args: "Address reviewer feedback: <summary>"), one `execute-task` on the resulting task, one `update-docs`, one `commit`. Either way, re-enter this skill at the right phase — don't fix the reviewer's point inline without routing.

---

## Post-ship: source doc hygiene

If the session's original input was a doc (retro, PRD, action plan — anything with an implicit or explicit action-plan table), that doc has a status field that silently decays as soon as you ship the work. Next reader has no way to tell what's done vs pending without reconstructing from `git log`. Prevent decay in-band: after `commit` succeeds, emit one question:

> Source doc `<path>` has an implicit action plan with per-item status. Update it now with a `status` / `commit` column + a short execution summary? **[yes / no / later]**

Default behavior: **yes**. The update is small and catches rot at its cheapest moment — when you still remember which commit addresses which item. `later` is legitimate; `no` should be rare and its reason stated.

**Trigger condition**: the orchestrator's original user message referenced a `.md` path with vocabulary like *retro*, *PRD*, *action plan*, *spec*, *design doc*, *runbook*, *postmortem* — or the message pasted a doc-shaped payload. If neither signal fires, skip the nudge silently.

Note: this update is a distinct operation from `update-docs`. `update-docs` syncs docs that describe the *code* you changed; this post-ship nudge updates the doc that *triggered* the session (a different kind of staleness).

---

## Post-ship: workspace re-index (sync nudge)

If the session ended with the last `commit` but you have NOT pushed (branch ahead of origin), the Browzer workspace index is stale relative to the new local commits. The next session will open with a staleness warning and file paths that may not reflect just-committed changes. The retro documented the index drifting 5+ commits behind because this post-ship step was never surfaced — the next session opened with outdated `importedBy` lists.

**After the final `commit` line returns**, inspect `git rev-list --count @{u}..HEAD` (commits ahead of upstream). If > 0 AND no `git push` has occurred in this session, emit one line:

> Branch is N commits ahead of upstream. Run `Skill(skill: "sync-workspace")` now to re-index Browzer against local HEAD? (If you're about to push, skip this — the `browzer-sync-on-push` hook handles re-index automatically on push.) **[yes / skip]**

Default behavior: **ask once**. If the operator says "yes", invoke `sync-workspace`; if "skip" or silence, move on — this is a nudge, not a blocker. Skip the nudge silently when: the operator has pushed in this session (hook already fired), OR the branch is at-or-behind upstream (nothing to sync).

**Why this exists**: automatic sync-on-push closes the gap only IF you push. A session that ends in a commit-but-no-push state (common: your CI runs tests before merge, or you wait for a reviewer) leaves Browzer blind to the new commits until the next sync event. The nudge ensures "session closure" in both the git AND the index senses.

---

## Entry-point shortcuts

Users frequently enter the workflow mid-way. Respect that:

- "I have an idea for…" / "help me think about…" / "what if we…" → `brainstorming` directly.
- "Write a PRD for X" → `generate-prd` directly (it will route to `brainstorming` itself if the input is vague).
- "I already have a PRD here, break it down" → `generate-task` directly.
- "TDD this / red test first" → `test-driven-development` directly.
- "Execute TASK_03 from above" → `execute-task` directly (plus `write-tests` + `verification-before-completion` afterwards if test setup exists).
- "Write tests for these files" → `write-tests` directly.
- "Verify before commit" / "mutation test this change" → `verification-before-completion` directly.
- "Update the docs for this change" → `update-docs` directly (pass the file list).
- "Commit what I have staged" → `commit` directly.
- "Sync my workspace" / "re-index browzer" → `sync-workspace` directly (note: push already triggers auto-sync via hook; use this for manual mid-session re-index).
- "Ship this feature end-to-end" → full chain: `brainstorming` (if input vague) → `generate-prd` → `generate-task` → per-task (`test-driven-development` → `execute-task` → `write-tests` → `verification-before-completion`) → `update-docs` (after the last task or per task, per plan) → `commit`.

You are a router, not a gatekeeper. The skills own the rigor; you own the handoffs.

---

## Output contract

The orchestrator itself follows the plugin's `README.md` §"Skill output contract" (at `../../README.md` relative to this SKILL.md). At each phase boundary, quote the sub-skill's one-line confirmation and **immediately invoke the next phase's `Skill(...)` in the same turn** — don't re-summarize, don't pause for operator input, don't ask "shall I proceed?". See Step 3 §"Zero-pause between phases" for the auto-chain contract. At end of flow, emit one final line:

```
orchestrate-task-delivery: shipped TASK_01..TASK_NN via 5-phase flow (commit <SHA>)
```

Or, on partial success / stop-condition exit:

```
orchestrate-task-delivery: stopped at phase <N> — <reason>
hint: <single next step>
```

No subagents-table recap, no baseline-vs-post-change table, no "Next steps" block. The HANDOFF JSONs and the UPDATE_DOCS JSON on disk are the structured record; the orchestrator's chat output is just the cursor.

---

## Related skills and references

- `../../references/subagent-preamble.md` — the brief every code subagent reads before editing. The orchestrator Read()s this file in its own context and pastes the relevant sections into subagent prompts; subagents don't resolve the path themselves.
- `../../scripts/detect-test-setup.mjs` — shared test-setup probe. Run once per session to gate the quality phases.
- `brainstorming` — step 0 preflight when the input is vague. Writes `BRAINSTORM.md` that `generate-prd` consumes.
- `generate-prd`, `generate-task`, `execute-task`, `update-docs`, `commit` — the five core workflow skills this orchestrator routes through.
- `sync-workspace` — available for manual mid-session re-index; workspace sync on push is handled automatically by the `browzer-sync-on-push` hook.
- `test-driven-development`, `write-tests`, `verification-before-completion` — the three quality phases this orchestrator injects when test setup exists.
- `superpowers:receiving-code-review` — optional; owned by the separately-installable `superpowers` plugin. Handles post-merge reviewer feedback when present. See §"Post-ship: reviewer feedback" for the inline-fallback loop when `superpowers` is not installed.
- `superpowers:using-git-worktrees` — optional; same plugin. Formalises the mechanics for `isolation: "worktree"` in parallel dispatches. When absent, Claude Code's built-in `Task(..., isolation: "worktree")` still works; just skip the extra checklist that skill provides.
