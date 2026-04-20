---
name: execute
description: "Step 3 of dev workflow (prd → task → execute → commit → sync). Implements a single task end-to-end by reading its spec from `docs/browzer/feat-<date>-<slug>/TASK_NN.md` (the file `task` wrote alongside `PRD.md`): grounds context with `browzer explore`/`deps`/`search`, captures baseline via the repo's actual quality gates, delegates implementation to specialist subagents with the right model (opus for architectural/multi-service, sonnet for standard feature/fix/tests, haiku for single-file/config), enforces every invariant `task` carried forward, runs gates, compares post-change vs baseline, hands off to `commit` + `sync`. The orchestrator (this skill) NEVER writes application code — all routes, components, migrations, workers, tests come from dispatched subagents. Discovers stack/package manager/test runner/build commands from manifest files (package.json, pyproject.toml, go.mod, Cargo.toml, Makefile) or CLAUDE.md — never assumes. Use when user says 'execute TASK_03', 'run the first task', 'implement task 02', 'do this task', 'build the feature from the plan', 'ship TASK_N', or right after `task` emits a plan. Also for free-form contained tasks — call `Skill(skill: 'task')` first to produce a plan. Emits an inline completion report (files touched, subagents used, skills loaded, baseline vs post-change table, pointer to `commit`)."
argument-hint: "[TASK_N | task-number | free-form task description]"
allowed-tools: Bash(browzer *), Bash, Read, Edit, Write, Glob, Grep
---

# execute — run one task end-to-end

Step 3 of `prd → task → execute → commit → sync`. Picks one task from the feat folder the `prd`/`task` chain produced and implements it end-to-end. Task specs live in `docs/browzer/feat-<date>-<slug>/TASK_NN.md` as written by `task`; the PRD lives in `PRD.md` alongside them. Read the spec from disk — don't rely on chat context alone (for plans >5 tasks the chat only carries the summary table + paths).

You are the **orchestrator**. You read, plan, dispatch, review, verify. You don't write application code. Components, routes, hooks, migrations, workers, pages, tests — all by subagents. Your only writes (if any) are trivial integration glue (<15 lines: barrel export, one-line import, config key).

You don't assume a stack. You discover it.

## Phase 0 — Resolve the input

Skill is invoked with one of:

1. `TASK_N — spec at docs/browzer/feat-<slug>/TASK_NN.md` (the chain-contract shape emitted by `task`) — **preferred**. Read the file directly.
2. `TASK_N` or plain number, no path — look up `FEAT_DIR` from chat context (`task`'s chain-contract line, or `prd`'s folder path). If ambiguous, `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -3` and ask which feat folder.
3. File path to a `.md` task — read it; if its sections don't match the `task` skill's template (scope, success criteria, verification plan), call `Skill(skill: "task")` to regenerate.
4. Free-form description — call `Skill(skill: "task")` first (which in turn calls `prd` if no PRD exists), then execute TASK_01 of resulting plan.

Bind `$FEAT_DIR` to the resolved folder for the rest of this phase (Phase 8 doc updates and Phase 9 report both reference it).

State to user which mode:

> **Executing TASK_N — [title].** Spec at `$FEAT_DIR/TASK_NN.md` · depends on [list or "none"] · suggested model [haiku/sonnet/opus].

## Phase 1 — Discover repo shape (once, if not already known)

Read whichever manifest exists:

- `package.json` — read `scripts` for real test/lint/typecheck/build commands; `packageManager` to pick CLI.
- `pyproject.toml`, `tox.ini`, `Makefile` — Python.
- `go.mod` — Go (`go test ./...`, `go vet ./...`, `go build ./...`).
- `Cargo.toml` — Rust (`cargo test`, `cargo clippy`, `cargo build`).
- `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` — repo-level docs naming commands and invariants.

Don't run generic commands that might not exist. The task from `task` should already carry right commands in its Verification plan — prefer those. If not, discover here and pass into every subagent prompt.

**If task carries `Pre-execution verification`**, run NOW — before Phase 2. For each entry: execute the verify-via command (Read/Bash/graph lookup), compare result against assumption, either proceed unchanged (held) or apply stated scope adjustment (failed). State adjustment explicitly:

> **Pre-execution verification:** assumption `<assumption>` failed (`<verify result>`). Adjusting scope: `<adjustment>`. Original task plan modified — proceeding.

If task says `n/a — task scope is exact` (or omits the section), skip. Surface the verification outcome (passed, adjusted, skipped) in Phase 9 report.

### Sibling-task file staleness (anchor by content, not line number)

When you execute `TASK_N+K` (K ≥ 1) and any prior sibling task in the same session edited a file you're about to touch, the task spec's line ranges are stale — every insertion shifted subsequent refs. This will happen every time a plan has multiple tasks editing the same file, which is the common case for skill-docs or monorepo config work.

**Rule (non-negotiable for subagent prompts)**: when the target file has been modified by a prior sibling task in this session, the subagent prompt MUST include the instruction `anchor by content match, not line number`. Give the subagent the exact phrase to match against (a unique sentence or heading near the insertion point) and tell it to search for that phrase via Read + scan, not to trust the line number in the task spec.

**Rule (applies to Phase 7 verification too)**: grep/wc/Read checks in the post-change verification plan MUST anchor by content when the file has been modified. `grep -n "specific phrase" file` is preferred over `sed -n '50,80p' file` because the line numbers drift but the phrase does not.

This is a lesson learned from the 2026-04-17 tarde-noite skill-creator execution session (see commits `f4f6a3b` through `67c2d16`): after TASK_01 landed 10 lines of additions, every later TASK_N+K spec's line refs were stale against `task-orchestrator/SKILL.md`. The ad-hoc workaround was "re-anchor by content match" in each dispatch prompt; this note formalises it as the default.

## Phase 2 — Browzer context (always first, even if `task` already explored)

`task` queried browzer at planning level. You query it at **implementation** level — different questions, different depth.

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

**`browzer search` is mandatory** before touching any library/config you didn't author. Don't rely on training data — it may be stale or not match the version pinned. Search first; if browzer has no doc index coverage, fall back to Context7 (`mcp__context7__resolve-library-id` → `mcp__context7__query-docs`) if available.

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

**Specialist skill invocation is orthogonal to role assignment.** If the repo skills index maps this task's `Sub-area` or `Layer` to a high-tier specialist skill (see `task-orchestrator` Step 0's vocabulary→domain mapping and the `Specialists loaded: [...]` declaration), invoke the specialist via `Skill(specialist-name)` **before** dispatching the subagent in Phase 5 — do not just list the name in the subagent prompt and assume it propagates. Passing the specialist name in the subagent prompt is not equivalent: the knowledge has to live in **your** context so both the dispatch shape (Phase 5 prompt construction) and the invariant-checking rounds (Phase 5 validation, Phase 6 gate review) benefit from it. If no mapped specialist exists, note it in the subagent prompt as `no specialist for <domain>` rather than silently omitting — a readable absence beats a guessable one.

## Phase 4 — Baseline capture (mandatory, before any edit)

Run gates the `task` skill named in this task's Verification plan. If task didn't name them, discover in Phase 1.

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

### Formatter delegation (run once per session, before the first Phase 5 dispatch)

Before writing subagent prompts, decide whether formatter gates are redundant because an in-loop auto-format Claude Code hook already runs them after every Edit/Write. Omit `biome check` / `prettier --write` / `ruff format` / `rustfmt` / equivalent from every subagent's "quality gates" list when a hook is in effect — a subagent running them after the hook is pure duplication.

**Default in Browzer-initialized repos: `HAS_AUTOFORMAT=yes`.** The Browzer plugin ships `auto-format.mjs` (a PostToolUse `Edit|Write` guard in `packages/skills/hooks/hooks.json`) that detects the target repo's formatter by file extension + config presence (biome → prettier → ruff → rustfmt → gofmt → stylua → no-op) and runs it in-loop. It is gated by `isInBrowzerWorkspace()` — only fires inside repos that ran `browzer init`. Set `HAS_AUTOFORMAT=no` only if one of these holds: the target repo is NOT Browzer-initialized (`.browzer/config.json` missing), the operator has set `BROWZER_HOOK=off` / disabled the hook in their Browzer config, or a fresh-session smoke test confirms the hook did not fire.

For non-Browzer repos, fall back to repo-local detection against `.claude/settings.json`:

```bash
HAS_AUTOFORMAT=$(
  jq -e '
    .hooks.PostToolUse // []
    | map(.matcher // "" | test("Edit|Write"))
    | any
  ' .claude/settings.json 2>/dev/null && echo "yes" || echo "no"
)
```

- **`HAS_AUTOFORMAT=yes`** (the common case in Browzer repos): omit formatter instructions from the subagent prompt. The hook runs `<formatter> <file>` after every Edit/Write automatically; the subagent doesn't need to do it. Keep typecheck, lint-as-linter (rule checks, not format-fix), tests, and build — those cost seconds and have no in-loop hook.
- **`HAS_AUTOFORMAT=no`**: keep the conservative "format the touched file" instruction as one of the gates.

**Why hook-presence, not tool-name-presence** — the plugin ships across stacks (biome, prettier, ruff, rustfmt, gofmt, deno fmt, stylua, ktlint, prettier+eslint), so grepping for a specific tool name is brittle and TS/JS-biased. Presence of *any* `PostToolUse` hook matching `Edit|Write` is the correct signal: it expresses the repo's intent ("something already formats on my behalf") without coupling to a particular formatter.

| Signal | Brittle? |
|---|---|
| `grep biome .claude/settings.json` | Yes — the repo may use prettier, ruff, rustfmt, gofmt, etc. |
| `test -f biome.json` | Yes — config presence ≠ wired hook. |
| `jq .hooks.PostToolUse` matcher `Edit\|Write` | **No** — expresses repo intent, formatter-agnostic. |

Typecheck and tests do **not** get this delegation — no Claude Code hook is cheap enough to run them in-loop (typecheck easily hits 30s+, tests can be minutes). Subagents keep running those explicitly.

Every subagent prompt carries these six blocks, in order:

```
Role: <one sentence — who the subagent is for this task>

Task: <one sentence — what to build/fix/test>

Context from browzer (exact paths + line ranges):
- <path>:<start>-<end>  — <what's there>
- <path>:<start>-<end>  — <public API shape, importedBy if relevant>

Repo invariants applicable to this task:
- <copy quoted rules from the task's "Repo invariants carried" section, with source ref>

Quality gates to run before reporting done (commands discovered from this repo):
- <typecheck command>
- <lint command>
- <test command>
- <build command if applicable>
- *(Formatter is omitted here if `HAS_AUTOFORMAT=yes` from the detection above; included if `no`.)*

Skills to load (call via Skill() before writing code):
- <skill matching sub-area, if installed in this workspace>
Use `browzer search "<topic>"` BEFORE touching any library/config you did not write.
Use Context7 only if browzer returns nothing useful for versioned library config.

Scope — only touch:
- <files from task Scope table>
Do NOT touch:
- <files explicitly out of scope from PRD §4 or other tasks>

Output contract:
- Files created/modified/deleted (exact paths)
- Tests written + exact command used to run them
- Quality gates ran: pass/fail for each
- One-line summary of the change
```

When two parallel subagents touch any overlapping file (shared barrel, config, schema), add `isolation: "worktree"` to each `Task()` call. Skip isolation only when scopes are truly disjoint.

When a subagent returns, validate before dispatching the next wave:

- Output contract fulfilled? (files, tests, gates)
- Every applicable **repo invariant** respected? (scan the diff against quoted rules; don't rely on subagent's self-report)
- Scope respected? (touched only what was listed)

If any check fails, send the same subagent back with a **specific** correction — not a re-statement of the task, but "You changed X instead of Y; you also dropped the Zod parse on line N; fix both." Don't cascade broken output into the next wave.

## Phase 6 — Quality gates

Run gates the repo defines, in local order (usually: format → lint → typecheck → unit → integration/e2e → build). If any fails, **dispatch a fix agent — don't patch inline.** Inline fixes exhaust context and trigger mid-task compaction; orchestrators who fix their own errors always pay for it two tasks later.

After fix agent lands, re-run **all** gates from the top — one fix can surface a new failure elsewhere.

## Phase 7 — Post-change verification

Re-run every Phase 4 baseline command with identical parameters. Build comparison table:

| Check                       | Baseline              | Post-change            | Delta     | Status               |
| --------------------------- | --------------------- | ---------------------- | --------- | -------------------- |
| lint                        | pass                  | pass                   | —         | ok                   |
| typecheck                   | pass                  | pass                   | —         | ok                   |
| unit tests                  | N passed              | M passed               | +K        | ok / regression      |
| integration                 | pass/fail             | pass/fail              | —         | ok                   |
| build size (if frontend)    | X kB                  | Y kB                   | ±Δ kB     | ok / improved / regr |
| LCP of `<page>`             | X ms                  | Y ms                   | ±Δ ms     | ok                   |
| `curl <endpoint>`           | 200 in X ms           | 201 in Y ms            | status +1 | ok                   |

Any regression beyond task's stated tolerance (or > 10% by default) must be investigated before proceeding. Dispatch a debugging agent with diff, baseline, post-change numbers; don't guess the cause.

Every task success criterion gets a row, even if qualitative — mark `manually verified` and describe evidence.

## Phase 8 — Docs + index freshness

Update docs **only** for real consumers of the change. Common targets (use whichever the repo has):

- `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` — new commands, architecture changes, new env vars, new invariants.
- Per-package or per-app docs — local conventions introduced by this task.
- `README.md` — only for user-facing capability changes.
- Architecture/runbook docs — iff this task changes something they describe.

Don't create new docs for every feature. Prefer editing.

## Phase 9 — Hand-off (completion report)

Emit this block in chat, then stop:

```markdown
## TASK_N complete — [title]

**Workflow stage:** execute (3/5) · previous: `task` · next: `commit`

### Subagents

| Role | Agent / surrogate | Model | Wave | Status |
| ---- | ----------------- | ----- | ---- | ------ |
| …    | …                 | …     | 1    | ok     |

### Files

- **Created:** [paths]
- **Modified:** [paths]
- **Deleted:** [paths]

### Skills loaded (across all subagents)

- [list]

### Repo invariants enforced

- [list of quoted rules from task's "invariants carried" section, each with ✅ or short note]

### Quality gates

- [typecheck ✅] · [lint ✅] · [test N passed] · [build ✅] · [integration ✅] · [e2e ✅]

### Baseline vs post-change

[paste table from Phase 7]

### Next steps

1. Run `Skill(skill: "commit")` to craft the conventional-commit message and stage changes.
2. After commit, run `Skill(skill: "sync")` to re-index the workspace — required so next `prd`/`task`/`execute` cycle sees this change in browzer's graph.
3. Optional: run next task (`execute TASK_<N+1>`).
```

## Orchestrator anti-patterns (self-check before every message)

- [ ] About to edit an application file? → **Stop, dispatch a subagent.**
- [ ] Announced N parallel agents? → Count `Task()` calls in this message. Must equal N.
- [ ] Parallel agents touching overlapping files? → Add `isolation: "worktree"` to each.
- [ ] Gate failed? → **Dispatch fix agent**, don't fix inline.
- [ ] About to guess library/config shape? → Run `browzer search` first, then Context7 if needed.
- [ ] Verified every applicable repo invariant in subagent's diff against quoted rules?

## Invocation modes

- **Via `browzer` agent:** called once `task` emits a plan and user picks a task (or says "ship the whole plan" — then iterate: execute → commit → sync → next).
- **Standalone:** `/execute TASK_N` or "implement TASK_03" — prefer the chain-contract shape `TASK_N — spec at docs/browzer/feat-<slug>/TASK_NN.md` so Phase 0 mode 1 applies directly. If only `TASK_N` is given, resolve `FEAT_DIR` from chat or disk (Phase 0 mode 2). If no task file exists, call `Skill(skill: "task")` first; if PRD also missing, start from `Skill(skill: "prd")`.

## Non-negotiables

- **Output language: English.** Render the completion report (Phase 9: subagents table, files list, skills loaded, invariants enforced, baseline-vs-post-change table) in English regardless of operator's language. Conversational wrapper around dispatch follows operator's language. Keeps `commit` consumption unambiguous.
- No application code by orchestrator.
- No silent skips of baseline capture or post-change verification.
- No inline fixes of failed gates.
- No parallel edits of same file without worktree isolation.
- No repo invariant left unchecked when its area was touched.

## Related skills

- `prd` — stage 1; source of the spec.
- `task` — stage 2; source of the plan this executes.
- `commit` — stage 4; runs immediately after success.
- `sync` — stage 5; re-indexes workspace so next cycle sees the change.
