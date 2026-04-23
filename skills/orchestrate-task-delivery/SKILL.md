---
name: orchestrate-task-delivery
description: Master orchestrator for any non-trivial task inside a Browzer-indexed repository — identifies which domain specialists the repo provides (queue, cache, web framework, database, auth, observability, RAG, infra) and loads them before planning, then routes work through the dev workflow. Core 6 phases (`generate-prd` → `generate-task` → `execute-task` → `update-docs` → `commit` → `sync-workspace`) plus three optional quality phases that auto-inject when the repo has a test setup: `brainstorming` (step 0, preflight into `generate-prd` when the input is vague), `test-driven-development` (before each `execute-task`, writes RED tests that drive the implementation), `write-tests` (after each `execute-task`, covers the new behaviour in green), `verification-before-completion` (before `update-docs`, runs blast-radius regression coverage + mutation testing). Grounds every decision in `browzer explore` / `search` / `deps`, and delegates real implementation to the matching workflow skill (which in turn drives specialist subagents with the right model: opus for architectural / multi-service work, sonnet for standard implementation, haiku for lookups and quick verifications). Use proactively whenever the user asks to write a PRD, break a PRD into tasks, implement / ship / execute a task or feature, update docs after a change, craft a commit message, re-index or sync the workspace, or describes work that spans multiple files, bridges code + docs + ops, or needs understanding of existing code before touching it. Also trigger on mid-flow entries like "execute TASK_03", "update the docs for this change", "commit what I have staged", "sync my workspace", "ship this end-to-end", or any request that matches a workflow phase even when the user does not name it explicitly. Do NOT use for trivial ≤3-file read-only lookups or direct questions — answer those inline.
---

You are the task orchestrator for this repository. Your job: **route → ground in browzer context → invoke the right skill → validate shape → move to the next phase**. You do not implement. You do not hold large prompts in your head — the skills do.

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
| "update the docs", "sync docs with this change", post-implementation | `update-docs`                      | 4/6       |
| "commit this", "write the commit message"                            | `commit`                           | 5/6       |
| "sync the workspace", "re-index browzer", "refresh the index"        | `sync-workspace`                   | 6/6       |

The 6-phase nomenclature refers to the CORE pipeline. Quality phases (0, 2.5, 3.5, 3.75) auto-inject when the repo has a test setup AND the task isn't marked opt-out — they are not separate flows, they are decorations on the core flow.

**Do it yourself (no skill, no subagent) only for:**

- Trivial direct questions, lookups, ≤3-file read-only answers.
- Running `browzer status`, `browzer explore`, `browzer search`, `browzer deps` to gather context.
- Routing decisions and TodoWrite planning.
- **Integration glue writes capped at <15 lines**, and only for: a barrel export, a one-line import, a one-line config key. Nothing else qualifies.

**Inline-edit hard cap — no exceptions.** If the change is >15 lines, OR touches a doc / runbook / multi-line markdown block, OR modifies actual logic (not just wiring), you MUST dispatch a haiku-tier subagent. "It's just a quick edit" is the thought that dumps a 124-line runbook into the orchestrator's working set. The haiku dispatch costs ~3 min and keeps your context clean; the inline shortcut costs context budget for the rest of the session.

**Why this matters:** if you try to execute a feature inline, you run 100+ turns doing investigation + implementation + review + commit in one thread. Instead: you stay a lightweight router, the workflow skill spawns the right specialist subagents, and the total cost stays sane.

---

## Preflight — tool availability

Before anything else, confirm the Task tools are loaded. In many sessions `TaskCreate` / `TaskUpdate` / `TaskList` arrive as deferred schemas:

```
ToolSearch(query: "select:TaskCreate,TaskUpdate,TaskList", max_results: 3)
```

One call, happens once per session, unblocks Step 2.

---

## Step 0 — Load method specialists (default ON)

Before planning, identify which **method domains** your task touches and load the specialist skills the target repo provides for those domains. Most reliably differentiates a routing session from a "model just solves it" session: the model can reason about queues or HTTP routes from general knowledge, but a repo-specific specialist skill encodes **this codebase's** conventions.

**How**: `browzer search "skills <2-3 vocabulary keywords from the task>" --json --save /tmp/skills_check.json`. Results that include a repo-curated skills index (conventionally `docs/browzer/rag-steroids/CLAUDE_SKILLS_FOR_*.md`, `docs/SKILLS.md`, or root `SKILLS.md`) are the canonical specialist list. The `CLAUDE_SKILLS_FOR_*.md` convention is produced by the `give-claude-rag-steroids` skill; if that skill has never run in the target repo the search will miss, and Step 0 falls through to "no specialists loaded, log the skip reason, proceed." Extract the **High-tier** matches and invoke them before Step 1.

**MANDATORY** — not a recommendation. After the invocations, emit a single-line declaration:

> Specialists loaded: [name1, name2, ...]

…or, if nothing matched:

> Specialists loaded: none (no domain from the vocabulary table fired)

The declaration is auditable evidence Step 0 ran. A reviewer reading the TodoWrite plan should see it without reconstructing from tool-call history. If the declaration is missing from the log, assume Step 0 was skipped.

**Vocabulary → domain** (repo-agnostic — specialist names vary per repo):

| Vocabulary signal                                            | Probable domain         |
| ------------------------------------------------------------ | ----------------------- |
| queue, job, worker, consumer, concurrency, dedup, retry, lock | background processing   |
| cache, rate-limit, TTL, pub/sub, in-memory store             | caching / K-V store     |
| route, schema, middleware, handler, controller, validator    | web framework           |
| migration, ORM, query, transaction, index, connection pool   | database / data access  |
| session, OAuth, token, JWT, RBAC, permission, trusted origin | auth / authz            |
| trace, span, metric, dashboard, log correlation              | observability           |
| embed, vector, chunk, retrieval, rerank, hybrid search       | RAG / semantic search   |
| container, image, compose, CI, deploy, runtime config        | infra / devops          |

These are **domain patterns, not skill names**. Specific specialist names are discovered per repo via `browzer search`. If no specialist exists for a domain in the target repo, note it and proceed without that hint — don't invent one.

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
  { content: "phase 5: invoke commit", status: "pending" },
  { content: "phase 6: invoke sync-workspace", status: "pending" }
])
```

Mark items done as each skill returns. Quality phases are **opt-out**, not opt-in — default is to run them when the detector says test setup exists. Operator can disable per-task (`test-driven-development` accepts `enabled: false`; `verification-before-completion` accepts `--skip-mutation`). If the detector says no test setup, skip all three quality phases and note the skip reason in TodoWrite — don't bootstrap a test framework from the orchestrator layer.

If the user enters mid-flow (they already have a PRD, they're fixing a bug that skips PRD), start at the right phase — do not force them through earlier ones for no reason. Quality phases still inject where they naturally belong (TDD before any `execute-task`, write-tests + verification after).

---

## Step 3 — Invoke the workflow skill

Use `Skill(skill: "<name>")` with a short argument that states the concrete ask. The PRD and task specs are **persisted to disk** under `docs/browzer/feat-<date>-<slug>/` — hand them off by **path**, not by assuming they survive in conversation context.

```
# Phase 0 — only when the input fails generate-prd's saturation check:
Skill(skill: "brainstorming",    args: "<user's vague request verbatim>")
# → writes docs/browzer/feat-<date>-<slug>/BRAINSTORM.md; auto-invokes generate-prd with the path

Skill(skill: "generate-prd",     args: "<user's feature idea or request>  # OR  brainstorm: docs/browzer/feat-<slug>/BRAINSTORM.md")
# → writes docs/browzer/feat-<date>-<slug>/PRD.md; emits 1-line confirmation
Skill(skill: "generate-task",    args: "feat dir: docs/browzer/feat-<date>-<slug>")
# → reads PRD.md, writes TASK_NN.md siblings + .meta/activation-receipt.json

# Phase 2.5 — quality (only when test setup exists + task isn't opt-out):
Skill(skill: "test-driven-development", args: "task: TASK_01 — spec at docs/browzer/feat-<slug>/TASK_01.md")
# → delegates to write-tests (mode: red), verifies RED, writes .meta/TDD_01.json; returns control

Skill(skill: "execute-task",     args: "TASK_01 — spec at docs/browzer/feat-<date>-<slug>/TASK_01.md")
# → reads task spec, dispatches code subagents via subagent-preamble.md, writes HANDOFF_01.json

# Phase 3.5 — quality (green test authoring):
Skill(skill: "write-tests",      args: "files: <paths from HANDOFF_01>; mode: green; feat dir: docs/browzer/feat-<slug>")
# → covers the new behaviour; writes .meta/WRITE_TESTS_<ts>.json

# Phase 3.75 — quality (last-line defence before docs/commit):
Skill(skill: "verification-before-completion", args: "files: <paths from HANDOFF_01>; feat dir: docs/browzer/feat-<slug>")
# → blast-radius regression coverage + mutation testing; writes .meta/VERIFICATION_<ts>.json

Skill(skill: "update-docs",      args: "files: <paths from HANDOFF_01>; feat dir: docs/browzer/feat-<date>-<slug>")
# → finds docs referencing those paths + concept-level matches, patches, writes UPDATE_DOCS_<ts>.json
Skill(skill: "commit")                        # runs after update-docs; emits SHA + subject
Skill(skill: "sync-workspace")                # closes the loop; re-indexes for the next cycle
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

**Formatter delegation** — in Browzer-initialized repos the plugin ships a PostToolUse `Edit|Write` hook (`auto-format.mjs`) that runs the repo's formatter in-loop after every edit; **default `HAS_AUTOFORMAT=yes`**. Record it in TodoWrite and strip `biome check` / `prettier` / `ruff format` from every subagent prompt's quality-gates list. Flip to `no` only if: the working tree is not Browzer-initialized (`.browzer/config.json` missing), the operator has `BROWZER_HOOK=off`, or a fresh-session smoke test shows the hook did not fire. The `subagent-preamble.md` §"Formatter delegation" section has the non-Browzer fallback logic.

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

**Parallel safety** — promote worktree isolation to default when dispatches overlap. HANDOFFs are per-task so `HANDOFF_03.json` and `HANDOFF_04.json` never collide on their own, but source-file overlap is a different beast. **Rule**: if two or more parallel dispatches touch any shared file (a barrel export, a vitest config, a schema migration, a CI workflow, an `.env.example`), pass `isolation: "worktree"` to **each** `Task()` call. Default for any overlap — omit only when scopes are verified disjoint.

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
- **Sync-workspace** → `browzer workspace sync` succeeded or short-circuited with "unchanged"? If pending jobs are in flight, wait or re-run with `--force` per `sync-workspace`'s guidance.

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

If a reviewer flags an already-committed change after `commit` + `sync-workspace`, delegate to `superpowers:receiving-code-review` **when the `superpowers` plugin is installed** — it owns the "verify the feedback is valid → decide fix vs. close → re-dispatch through `execute-task` or direct Agent as appropriate" loop. If `superpowers` is not available in the target environment, handle the review feedback inline as a mini loop: one `generate-task` invocation for the fix (args: "Address reviewer feedback: <summary>"), one `execute-task` on the resulting task, one `update-docs`, one `commit`, one `sync-workspace`. Either way, re-enter this skill at the right phase — don't fix the reviewer's point inline without routing.

---

## Post-ship: source doc hygiene

If the session's original input was a doc (retro, PRD, action plan — anything with an implicit or explicit action-plan table), that doc has a status field that silently decays as soon as you ship the work. Next reader has no way to tell what's done vs pending without reconstructing from `git log`. Prevent decay in-band: after `commit` + `sync-workspace` succeed, emit one question:

> Source doc `<path>` has an implicit action plan with per-item status. Update it now with a `status` / `commit` column + a short execution summary? **[yes / no / later]**

Default behavior: **yes**. The update is small and catches rot at its cheapest moment — when you still remember which commit addresses which item. `later` is legitimate; `no` should be rare and its reason stated.

**Trigger condition**: the orchestrator's original user message referenced a `.md` path with vocabulary like *retro*, *PRD*, *action plan*, *spec*, *design doc*, *runbook*, *postmortem* — or the message pasted a doc-shaped payload. If neither signal fires, skip the nudge silently.

Note: this update is a distinct operation from `update-docs`. `update-docs` syncs docs that describe the *code* you changed; this post-ship nudge updates the doc that *triggered* the session (a different kind of staleness).

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
- "Sync my workspace" → `sync-workspace` directly.
- "Ship this feature end-to-end" → full chain: `brainstorming` (if input vague) → `generate-prd` → `generate-task` → per-task (`test-driven-development` → `execute-task` → `write-tests` → `verification-before-completion`) → `update-docs` (after the last task or per task, per plan) → `commit` → `sync-workspace` at the end.

You are a router, not a gatekeeper. The skills own the rigor; you own the handoffs.

---

## Output contract

The orchestrator itself follows the plugin's `README.md` §"Skill output contract" (at `../../README.md` relative to this SKILL.md). At each phase boundary, quote the sub-skill's one-line confirmation and move on — don't re-summarize. At end of flow, emit one final line:

```
orchestrate-task-delivery: shipped TASK_01..TASK_NN via 6-phase flow (commit <SHA>, index synced)
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
- `generate-prd`, `generate-task`, `execute-task`, `update-docs`, `commit`, `sync-workspace` — the six core workflow skills this orchestrator routes through.
- `test-driven-development`, `write-tests`, `verification-before-completion` — the three quality phases this orchestrator injects when test setup exists.
- `superpowers:receiving-code-review` — optional; owned by the separately-installable `superpowers` plugin. Handles post-merge reviewer feedback when present. See §"Post-ship: reviewer feedback" for the inline-fallback loop when `superpowers` is not installed.
- `superpowers:using-git-worktrees` — optional; same plugin. Formalises the mechanics for `isolation: "worktree"` in parallel dispatches. When absent, Claude Code's built-in `Task(..., isolation: "worktree")` still works; just skip the extra checklist that skill provides.
