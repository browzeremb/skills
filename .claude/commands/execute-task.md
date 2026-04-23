---
name: execute-task
description: "Step 3 of 6 in the dev workflow (generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace). Use when the user wants to implement a task — even if they just say 'do this', 'build the feature', or point at a task number. Reads the TASK_NN.md spec from docs/browzer/feat-<date>-<slug>/, grounds context with browzer explore/deps/search, captures baseline quality gates, then delegates ALL implementation to specialist subagents (opus for architecture, sonnet for standard work, haiku for lookups). The orchestrator never writes application code. Enforces every invariant generate-task carried forward, re-runs gates, writes HANDOFF JSON. For free-form tasks without a plan, calls generate-task first (which calls generate-prd if no PRD exists). Triggers: 'execute TASK_03', 'run the first task', 'implement task 02', 'do this task', 'build the feature from the plan', 'ship TASK_N', 'implement this', or right after generate-task emits a plan."
argument-hint: "[TASK_N | task-number | free-form task description]"
allowed-tools: Bash(browzer *), Bash, Read, Edit, Write, Glob, Grep
---

# execute-task — run one task end-to-end

Step 3 of 6: `generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace`. Picks one task from the feat folder the `generate-prd`/`generate-task` chain produced and implements it end-to-end. Task specs live in `docs/browzer/feat-<date>-<slug>/TASK_NN.md` as written by `generate-task`; the PRD lives in `PRD.md` alongside them. Read the spec from disk — don't rely on chat context alone (for plans >5 tasks the chat only carries the summary table + paths).

You are the **orchestrator**. You read, plan, dispatch, review, verify. You don't write application code. Components, routes, hooks, migrations, workers, pages, tests — all by subagents. Your only writes (if any) are trivial integration glue (<15 lines: barrel export, one-line import, config key).

You don't assume a stack. You discover it.

## Phase 0 — Resolve the input

Skill is invoked with one of:

1. `TASK_N — spec at docs/browzer/feat-<slug>/TASK_NN.md` (the chain-contract shape emitted by `generate-task`) — **preferred**. Read the file directly.
2. `TASK_N` or plain number, no path — look up `FEAT_DIR` from chat context (`generate-task`'s chain-contract line, or `generate-prd`'s folder path). If ambiguous, `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -3` and ask which feat folder.
3. File path to a `.md` task — read it; if its sections don't match the `generate-task` skill's template (scope, success criteria, verification plan), call `generate-task` to regenerate.
4. Free-form description — call `generate-task` first (which in turn calls `generate-prd` if no PRD exists), then execute TASK_01 of resulting plan.

Bind `$FEAT_DIR` to the resolved folder for the rest of this phase (Phase 8 hand-off and Phase 9 reporting both reference it).

State to user which mode:

> **Executing TASK_N — [title].** Spec at `$FEAT_DIR/TASK_NN.md` · depends on [list or "none"] · suggested model [haiku/sonnet/opus].

## Phase 1 — Discover repo shape (once, if not already known)

Read whichever manifest exists:

- `package.json` — read `scripts` for real test/lint/typecheck/build commands; `packageManager` to pick CLI.
- `pyproject.toml`, `tox.ini`, `Makefile` — Python.
- `go.mod` — Go (`go test ./...`, `go vet ./...`, `go build ./...`).
- `Cargo.toml` — Rust (`cargo test`, `cargo clippy`, `cargo build`).
- `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` — repo-level docs naming commands and invariants.

Don't run generic commands that might not exist. The task from `generate-task` should already carry right commands in its Verification plan — prefer those. If not, discover here and pass into every subagent prompt.

**If task carries `Pre-execution verification`**, run NOW — before Phase 2. For each entry: execute the verify-via command (Read/Bash/graph lookup), compare result against assumption, either proceed unchanged (held) or apply stated scope adjustment (failed). State adjustment explicitly:

> **Pre-execution verification:** assumption `<assumption>` failed (`<verify result>`). Adjusting scope: `<adjustment>`. Original task plan modified — proceeding.

If task says `n/a — task scope is exact` (or omits the section), skip. Surface the verification outcome (passed, adjusted, skipped) in the HANDOFF JSON.

### Sibling-task file staleness (anchor by content, not line number)

When you execute `TASK_N+K` (K ≥ 1) and any prior sibling task in the same session edited a file you're about to touch, the task spec's line ranges are stale — every insertion shifted subsequent refs. This will happen every time a plan has multiple tasks editing the same file, which is the common case for skill-docs or monorepo config work.

**Rule (non-negotiable for subagent prompts)**: when the target file has been modified by a prior sibling task in this session, the subagent prompt MUST include the instruction `anchor by content match, not line number`. Give the subagent the exact phrase to match against (a unique sentence or heading near the insertion point) and tell it to search for that phrase via Read + scan, not to trust the line number in the task spec.

**Rule (applies to Phase 7 verification too)**: grep/wc/Read checks in the post-change verification plan MUST anchor by content when the file has been modified. `grep -n "specific phrase" file` is preferred over `sed -n '50,80p' file` because the line numbers drift but the phrase does not.

This rule codifies a lesson from multi-task execution sessions: after TASK_01 lands any file additions, every later TASK_N+K spec's line refs against that file are stale. The ad-hoc workaround ("re-anchor by content match" in each dispatch prompt) is now the default for any task-pair touching the same file.

## Phase 2 — Browzer context (always first, even if `generate-task` already explored)

`generate-task` queried browzer at planning level. You query it at **implementation** level — different questions, different depth.

```bash
browzer status --json                                          # sanity

# For every file in the task's Scope table
browzer explore "<symbol or concern>" --json --save /tmp/exec-explore.json

# For every file being modified (not created), check blast radius
browzer deps "<path>" --reverse --json --save /tmp/exec-deps.json

# For any library/framework/config whose syntax you're about to touch
browzer search "<topic>" --json --save /tmp/exec-search.json
```

Cap at **4–5 queries**. Extract: exact line ranges, public API shape (`exports`), all consumers (`importedBy`). Paste into each subagent prompt — subagents working blind produce drift.

**`browzer search` is mandatory** before touching any library/config you didn't author. Don't rely on training data — it may be stale or not match the version pinned. Search first; if browzer has no doc index coverage for the topic, fall back to Context7 (`mcp__context7__resolve-library-id` → `mcp__context7__query-docs`) if available.

**Context7 budget accounting**: Context7 calls are a separate service and do NOT count against the 4–5 `browzer search` budget cap. Each Context7 call used in place of a missing browzer-search result should be listed in `HANDOFF.invariantsChecked` as `{ rule: "library docs consulted for <topic>", source: "Context7", status: "passed" }` so the orchestrator can audit when training-data vs. versioned-docs was the authority. If Context7 is also unavailable (no MCP client configured), note `"<topic>: no authoritative docs available — proceeded on training data"` under `scopeAdjustments` with a recommendation to re-run once either index is populated.

## Phase 3 — Role assignment

Map the task's `Layer` + `Sub-area` to a subagent type and model. Use whichever agents are installed in this workspace; fall back to `general-purpose` with full embedded persona when none matches:

| Task shape                                                  | Specialist (or surrogate)              | Model   |
| ----------------------------------------------------------- | -------------------------------------- | ------- |
| DB schema / migration / index                               | database (or general-purpose)          | sonnet  |
| Server route / handler / validation                         | backend (or general-purpose)           | sonnet  |
| Background job / worker / queue consumer                    | queue (or general-purpose)             | sonnet  |
| Auth / authz / session / crypto                             | security (or general-purpose)          | sonnet  |
| Multi-service or architectural refactor                     | general-purpose (architect persona)    | opus    |
| UI component / hook                                         | frontend (or general-purpose)          | sonnet  |
| Client page / route / SSR UI                                | general-purpose (client persona)       | sonnet  |
| Accessibility sweep                                         | a11y (or general-purpose)              | sonnet  |
| Performance tuning                                          | perf (or general-purpose)              | sonnet  |
| Shared types / utilities / barrel exports                   | general-purpose (TS/lang persona)      | haiku   |
| Tests (unit / integration / e2e)                            | test (or general-purpose)              | sonnet  |
| Dockerfile / compose / CI / deploy config                   | devops (or general-purpose)            | sonnet  |
| Observability wiring (traces, metrics, dashboards)          | general-purpose (observability)        | sonnet  |
| Doc write-up only                                           | general-purpose (doc writer)           | haiku   |
| Deep cross-service investigation (unknown-cause bug)        | debugger (or general-purpose)          | opus    |
| Post-implementation review (read-only)                      | code reviewer                          | sonnet  |

Go **one level higher** when in doubt. Under-powered reasoning wastes more context than it saves.

If a single task spans multiple sub-areas, split into multi-role dispatch (Phase 5) instead of one bloated subagent.

**Specialist skill invocation is orthogonal to role assignment.** If the repo skills index maps this task's `Sub-area` or `Layer` to a high-tier specialist skill (see `orchestrate-task-delivery` Step 0's vocabulary→domain mapping and the `Specialists loaded: [...]` declaration), invoke the specialist via `Skill(specialist-name)` **before** dispatching the subagent in Phase 5. Passing the specialist name in the subagent prompt is not equivalent: the knowledge has to live in **your** context so both the dispatch shape and invariant-checking rounds benefit from it. If no mapped specialist exists, note it in the subagent prompt as `no specialist for <domain>` rather than silently omitting.

## Phase 4 — Baseline capture (mandatory, before any edit)

Run gates the `generate-task` skill named in this task's Verification plan. If task didn't name them, discover in Phase 1.

```bash
# Example shapes — use what target repo defines:
<typecheck command>      # e.g. pnpm typecheck, tsc --noEmit, mypy, go vet
<lint command>           # e.g. pnpm lint, eslint, ruff, golangci-lint
<test command>           # e.g. pnpm test, pytest, go test ./...
<build command>          # e.g. pnpm build, vite build, go build ./...

# Domain-specific (only if task calls them out):
curl -sSI "<endpoint>"                       # API tasks
# playwright/chrome-devtools screenshots + LCP    # UI tasks
# schema dump                                       # DB tasks
# current metric/trace volume                       # observability tasks
```

State captured numbers. You'll diff in Phase 7.

If dev server isn't up and task touches a page/endpoint, ask user whether to start it or accept shell-only baseline. Don't silently skip visual checks.

## Phase 5 — Dispatch subagents

**Rule of orchestration:** if you're about to edit a source file a subagent would edit, stop. That work belongs to a subagent.

For each role identified in Phase 3, send one `Task()` call. **Spawn independent roles in the same assistant message** — parallelism is literal: one message, multiple tool calls. Announcing "3 parallel agents" and sending 1 `Task()` is a protocol violation.

### Preamble — read and paste, don't ship a path

Before constructing subagent prompts, `Read` the preamble at `../../references/subagent-preamble.md` (relative to this SKILL.md) in your own context. The subagent's CWD is the user's repo — it cannot resolve that path. Paste the preamble's §Step 1 through §Step 5 content verbatim into each subagent prompt (or a task-tailored distillation when the full preamble would blow the prompt budget — §Step 4 HANDOFF schema is mandatory regardless). See `orchestrate-task-delivery` §"When direct `Agent(...)` replaces `Skill(execute-task)`" for the canonical prompt shape.

Each subagent prompt carries, in order:

1. **Role** — one sentence: who the subagent is for this task.
2. **Task** — one sentence: what to build/fix/test.
3. **Scope** — only the files from the task's Scope table; Do-NOT-touch list.
4. **Browzer context** — exact paths + line ranges extracted in Phase 2.
5. **Preamble** — §Step 1–5 of `../../references/subagent-preamble.md` pasted verbatim (or distilled; §Step 4 mandatory).

### Formatter delegation

**Default in Browzer-initialized repos: `HAS_AUTOFORMAT=yes`.** The plugin ships `auto-format.mjs` as a PostToolUse `Edit|Write` guard (wired in `../../hooks/hooks.json`) that runs the repo's formatter in-loop after every Edit/Write. Omit `biome check` / `prettier --write` / `ruff format` / `rustfmt` / equivalent from every subagent's quality-gates list when `HAS_AUTOFORMAT=yes` — running them again is pure duplication. Keep typecheck, lint-as-linter (rule checks, not format-fix), tests, and build.

Set `HAS_AUTOFORMAT=no` only if: the repo is NOT Browzer-initialized (`.browzer/config.json` missing), the operator has `BROWZER_HOOK=off`, or a smoke test confirms the hook did not fire. For non-Browzer repos, detect via `jq '.hooks.PostToolUse // [] | map(.matcher // "" | test("Edit|Write")) | any' .claude/settings.json`.

When two parallel subagents touch any overlapping file (shared barrel, config, schema), add `isolation: "worktree"` to each `Task()` call. Skip isolation only when scopes are truly disjoint.

When a subagent returns, validate before dispatching the next wave:

- Output contract fulfilled? (files, gates, HANDOFF JSON)
- Every applicable **repo invariant** respected? (scan the diff against quoted rules; don't rely on subagent's self-report)
- Scope respected? (touched only what was listed)

If any check fails, send the same subagent back with a **specific** correction. Don't cascade broken output into the next wave.

## Phase 6 — Quality gates

Run gates the repo defines, in local order (usually: lint → typecheck → unit → integration/e2e → build). If any fails, **dispatch a fix agent — don't patch inline.** Inline fixes exhaust context and trigger mid-task compaction; orchestrators who fix their own errors always pay for it two tasks later.

After fix agent lands, re-run **all** gates from the top — one fix can surface a new failure elsewhere.

## Phase 7 — Post-change verification

Re-run every Phase 4 baseline command with identical parameters. Build a comparison table (stored in the HANDOFF JSON under `gates`):

| Check                    | Baseline   | Post-change | Delta | Status          |
| ------------------------ | ---------- | ----------- | ----- | --------------- |
| lint                     | pass       | pass        | —     | ok              |
| typecheck                | pass       | pass        | —     | ok              |
| unit tests               | N passed   | M passed    | +K    | ok / regression |
| integration              | pass/fail  | pass/fail   | —     | ok              |
| build size (if frontend) | X kB       | Y kB        | ±Δ kB | ok / regr       |

Any regression beyond task's stated tolerance (or > 10% by default) must be investigated before proceeding. Dispatch a debugging agent with diff, baseline, and post-change numbers; don't guess the cause.

Every task success criterion gets a row, even if qualitative — mark `manually verified` and describe evidence.

## Phase 8 — Hand off to update-docs

After gates pass, write the HANDOFF JSON to `docs/browzer/feat-<slug>/.meta/HANDOFF_<TASK_ID>.json` following the schema in `../../references/subagent-preamble.md` §Step 4. The `files.modified` list in the HANDOFF is the primary input `update-docs` uses to decide which docs to patch.

Do **not** edit `CLAUDE.md`, `AGENTS.md`, `README.md`, or any other markdown doc yourself from here — those go through `update-docs` in phase 4 of the workflow. Doc freshness is `update-docs`'s job. Even if a doc change is clearly implied by the task scope, leave it for `update-docs`.

The orchestrator (`orchestrate-task-delivery`) schedules `update-docs` after `execute-task` returns; you do not invoke it.

## Phase 9 — Completion (silence contract)

Write the HANDOFF JSON (see Phase 8), then emit exactly one line in chat. Shape depends on whether dispatch happened or inline glue was used:

```
# Standard case — one or more subagents dispatched:
execute-task: TASK_NN ok (<N files>, <M subagents>, gates green); report at .meta/HANDOFF_NN.json

# Inline-glue case — no subagents dispatched, task met the <15-line integration-glue cap:
execute-task: TASK_NN ok (<N files> inlined, gates green); report at .meta/HANDOFF_NN.json
```

Prefer the `inlined` marker over `(N files, 0 subagents, gates green)` — the "0 subagents" reading is awkward and doesn't signal the dispatch strategy. Use `inlined` iff zero subagents ran AND all files are integration glue under the cap.

On failure, two lines — nothing more:

```
execute-task: failed — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output:** subagents table, files list, skills loaded, invariants enforced, baseline-vs-post-change table, "Next steps" block, "Workflow stage" footer. All of that data lives in the HANDOFF JSON. See `../../README.md` §"Skill output contract" for the normative rules.

## Orchestrator anti-patterns (self-check before every message)

- [ ] About to edit an application file? → **Stop, dispatch a subagent.**
- [ ] Announced N parallel agents? → Count `Task()` calls in this message. Must equal N.
- [ ] Parallel agents touching overlapping files? → Add `isolation: "worktree"` to each.
- [ ] Gate failed? → **Dispatch fix agent**, don't fix inline.
- [ ] About to guess library/config shape? → Run `browzer search` first, then Context7 if needed.
- [ ] Verified every applicable repo invariant in subagent's diff against quoted rules?
- [ ] Editing CLAUDE.md / README.md / AGENTS.md? → **Stop. That's update-docs's job.**

## Invocation modes

- **Via `orchestrate-task-delivery`:** called once `generate-task` emits a plan and user picks a task (or says "ship the whole plan" — then iterate: execute-task → update-docs → commit → sync-workspace → next task).
- **Standalone:** `/execute-task TASK_N` or "implement TASK_03" — prefer the chain-contract shape `TASK_N — spec at docs/browzer/feat-<slug>/TASK_NN.md` so Phase 0 mode 1 applies directly. If only `TASK_N` is given, resolve `FEAT_DIR` from chat or disk (Phase 0 mode 2). If no task file exists, call `generate-task` first; if PRD also missing, start from `generate-prd`.

## Non-negotiables

- **Output language: English.** The HANDOFF JSON and the one-line completion line are English regardless of the operator's language. Conversational wrapper around dispatch follows operator's language.
- No application code by orchestrator.
- No silent skips of baseline capture or post-change verification.
- No inline fixes of failed gates.
- No parallel edits of same file without worktree isolation.
- No repo invariant left unchecked when its area was touched.
- No doc updates from this skill — `update-docs` owns phase 4.

## Related skills

- `generate-prd` — stage 1; source of the spec.
- `generate-task` — stage 2; source of the plan this executes.
- `update-docs` — stage 4; patches docs based on files listed in HANDOFF JSON.
- `commit` — stage 5; runs after update-docs.
- `sync-workspace` — stage 6; re-indexes workspace so next cycle sees the change.
- `../../references/subagent-preamble.md` — the brief pasted into every subagent prompt; read it in your own context before dispatch.
