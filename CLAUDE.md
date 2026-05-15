# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative references (read first)

- **`docs/CLAUDE_CODE_PLUGIN.md`** — single source of truth for this plugin: layout, invariants, hooks, CI gates, frontmatter rules, token-economy tiers, session-log fixes, version trajectory, plugin-agnosticization checklist. Consult before any non-trivial change here.
- **`packages/cli/`** — the Go `browzer` CLI is the runtime side of this plugin. Skills are thin markdown wrappers around its commands; the workflow schema SSOT lives at `packages/cli/schemas/workflow-v1.cue`. This plugin MUST stay synchronized with the CLI: any change to a `browzer` subcommand surface (flags, JSON shape, exit codes, named queries, `get-step` view templates, `save-step` payload contract, mutator verbs like `append-step` / `append-steps` / `describe-step-type`) requires patching every skill body that invokes it in the same change, then rerunning `scripts/audit/skill-cli-references.mjs` + `skill-cli-sync-drift.mjs`. See `packages/cli/CLAUDE.md` for CLI-side conventions.

## What this package is

`@browzer/skills` is a **markdown-only Claude Code plugin**. It ships:

- Skills under `skills/<name>/` — each follows the canonical Anthropic Agent Skills layout: `SKILL.md` at the skill root, plus optional `template.md`, `examples/`, `scripts/`, `references/`. Single-skill content (templates, fixtures, refs loaded by exactly one skill) lives INSIDE the skill folder. The skill body is a frontmatter-prefixed markdown file driving an agent workflow around the `browzer` Go CLI (hybrid vector + Graph RAG).
- Lifecycle hooks under `hooks/guards/*.mjs` (Node ESM, no bundler), wired by `hooks/hooks.json`. The `_auto-save-step.mjs` autosave bridge was retired in v5.0.0 — it is no longer present.
- **Cross-skill shared references** under `references/` — ONLY for files loaded by **≥2 skills** (e.g. `subagent-preamble.md` consumed by every dispatching skill; `sensitive-paths.md` consumed by `code-review` fast-lane gate and `generate-task` Reviewer pass). Per-skill refs MUST live inside the skill (`skills/<name>/references/`); the `≥2-skill threshold` is the rule for promoting a doc to the global folder.
- Per-skill `scripts/` (only when the skill ships real helpers) — ESM modules and shell utilities tested via `node --test`. The plugin no longer ships `jq-helpers.sh` or `scripts/renderers/*.jq`: those depended on CLI verbs (`workflow patch`, `workflow set-status`, `workflow query`, `--render`) that were removed in CLI v3.0.0. State mutations flow through direct `Write` calls to plain `.md` files under `docs/browzer/<feat>/staging/` (and `README.md` at the feat root for the one committed artefact); reads are direct `Read` calls on those files. The historical `PostToolUse(Write) autosave → browzer save-step` bridge was retired in v5.0.0 while the `staging/` discipline itself was preserved.

There is no source compilation step — the package distributes raw markdown + the runtime ESM scripts above. `lint` and `typecheck` are no-ops by design.

## Commands

Run from this package directory (`packages/skills/`) unless noted.

```bash
# Validate every SKILL.md frontmatter against the spec
pnpm validate-frontmatter

# Full test gate (frontmatter + script unit tests)
pnpm test

# Just the script-level node:test runs
pnpm test:scripts

# Skill eval harness — needs ../../.env.local (Anthropic key, etc.)
pnpm test:evals

# Per-skill eval (skl1 = single skill, see scripts/packages/skills/run-skill-evals.mjs)
pnpm test:evals:skl1
```

Host-only test/eval scripts resolve to `scripts/packages/skills/` from the monorepo root (see the host-only callout above). Per-skill `node --test` continues to work for tests co-located with the skill:

```bash
node --test scripts/packages/skills/validate-frontmatter.test.mjs
node --test skills/<skill>/scripts/<file>.test.mjs
```

The repo-wide quality gate is `pnpm run browzer:gate` from the monorepo root — invoke it manually before push. The plugin no longer ships a Stop-event gate runner (the quality-gate hooks were retired in v5.4.0).

## Baseline regression — when to run it (mandatory)

Any non-trivial change to `packages/skills/skills/**`, `packages/skills/hooks/**`, `packages/skills/agents/**`, or `packages/cli/internal/**` MUST be sandwiched between two `baseline-regression` runs: a **before** snapshot on the current `main`, and an **after** snapshot on the change branch. The harness is the only end-to-end measurement of whether plugin/CLI edits actually moved tokens, wall time, dispatch routing, hook firings, and delivery quality — `pnpm browzer:gate` only catches lint/typecheck/unit drift.

```bash
# Before — on main, captures the current baseline behaviour
git switch main
node scripts/packages/skills/baseline-regression/run.mjs --tier=smoke

# After — on your change branch
git switch <your-branch>
node scripts/packages/skills/baseline-regression/run.mjs --tier=smoke --compare-to=BASELINE.json
```

Smoke (1 fixture, ~$3-10) is the floor for every PR. `--tier=standard` (2 fixtures, ~$10-20) before pre-release. `--tier=full` (5 fixtures, ~$50-150) before any refactor of `orchestrate-task-delivery` itself, plus on the post-merge `--update-baseline` commit. Cost is uncapped — `--max-budget-usd` was removed because every capped smoke died mid-pipeline; the only safety is a walltime SIGTERM (`walltimeMin × 1.5` per fixture). Always `--dry-run` first to see the per-fixture cost estimate before kicking off. Never `--update-baseline` outside `--tier=full`. See `.claude/skills/baseline-regression-skills/SKILL.md` for the operator workflow and `scripts/packages/skills/baseline-regression/README.md` for the harness internals. If the harness reports regressions, the fix belongs in the skill body / CLI internals — not in `BASELINE.json`.

## Architecture — big picture

### Skills are markdown contracts, not code

Each `skills/<name>/SKILL.md` has a YAML frontmatter (`name`, `description`, model hints) followed by a prose contract that an agent loads at trigger time. Triggering is description-driven: write descriptions that begin with concrete trigger phrases ("Use when…", verb lists), since Claude Code matches on description text. `validate-frontmatter.mjs` enforces the schema; do not bypass it.

Some skills carry their own `scripts/` subfolder — these are real ESM helpers and shell utilities (e.g. baseline-failure parsers, pre-push gate detectors) shipped alongside the markdown and tested via `node --test`.

### The workflow pipeline (the heart of the plugin)

`orchestrate-task-delivery` is the master orchestrator. It runs a fixed 12-phase chain on any non-trivial change:

```
Phase 1 brainstorming → Phase 2 generate-prd → Phase 3 resolve executionStrategy →
Phase 4 generate-task → Phase 5 execute-task (× N) → Phase 6 code-review →
Phase 7 receiving-code-review → Phase 8 write-tests → Phase 9 update-docs →
Phase 10 PRE_PUSH_GATE → Phase 11 feature-acceptance → Phase 12 commit
```

Phases 1 and 2 dispatch typed agents (`browzer:pm` and `browzer:po`) with model and effort scaled to feature complexity — determined by the `COMPLEXITY` signal resolved at S1 (probe step). All remaining phases continue to run as skill invocations in the main thread.

`executionStrategy` resolution moved to Phase 3 in the v3.0.0 refactor — the orchestrator now picks `serial | parallel | parallel-worktrees | agent-teams` BEFORE `generate-task` runs, so the task plan is shaped by the chosen strategy. The CUE enum step names (`BRAINSTORMING`, `PRD`, `TASKS_MANIFEST`, `TASK`, `CODE_REVIEW`, `RECEIVING_CODE_REVIEW`, `WRITE_TESTS`, `UPDATE_DOCS`, `FEATURE_ACCEPTANCE`, `COMMIT`) live in `packages/cli/schemas/workflow-v1.cue` as the Go-side type registry — they are NOT the names of files the skills write. In markdown-chains the on-disk filenames are `BRIEF.md`, `PRD.md`, `EXPLORATION.md`, `TASK_NN.md` (one per task), `TASK_GRAPH.md` (only when `executionStrategy != "serial"`), `CODE_REVIEW.md`, `RECEIVING_CODE_REVIEW.md`, `TESTS.md`, `DOC_PATCHES.md`, `ACCEPTANCE.md` — see `references/feature-folder-layout.md`. Adding a new phase means editing the CUE schema in the `browzer` Go CLI plus shipping the matching `internal/workflow/view/templates/<phase>.md.tmpl`, not this file.

The dispatch-ledger contract in `orchestrate-task-delivery/SKILL.md` is forward-compatible: unknown top-level keys in ledger JSON are ignored rather than rejected, so future CLI versions may add fields without breaking existing skill bodies.

### State lives in `.md` files, not chat history

Every workflow run stores its phase outputs as plain `.md` files under
`docs/browzer/<feat>/staging/` — one file per phase (e.g. `PRD.md`, `TASK_01.md`, `CODE_REVIEW.md`).
The single exception is `docs/browzer/<feat>/README.md`, written by `finalize-feature` and the only
artefact committed to git; the rest of `staging/` is gitignored (per the auto-generated
`staging/.gitignore` written at INIT). Each phase skill writes its output via the `Write` tool; the
next phase skill reads it via `Read`. There is no `workflow.json` and no autosave hook bridge —
the historical `stage + autosave` pipeline (`PostToolUse(Write) → browzer save-step → workflow.json`)
was retired in v5.0.0 while the `staging/` discipline was preserved. Direct `jq` writes against any
workflow state file remain banned. See `references/feature-folder-layout.md` for the full per-file
map.

### Subagent dispatch contract

Each workflow phase dispatches a **typed specialist agent** via `Agent(subagent_type: browzer:<role>)`. The full roster under `agents/`:

| Agent                   | Model         | Dispatched by                                                                       | Role                                                                            |
| ----------------------- | ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `browzer:explorer`      | haiku         | generate-task, execute-task, code-review, update-docs, orchestrate-task-delivery S6 | RAG discovery, blast-radius, find-skills programmatic mode                      |
| `browzer:pm`            | sonnet / opus | orchestrate-task-delivery Phase 1                                                   | PRD authoring, scaled by `$COMPLEXITY`                                          |
| `browzer:po`            | sonnet / opus | orchestrate-task-delivery Phase 2                                                   | Task decomposition, scaled by PRD complexity                                    |
| `browzer:coder`         | sonnet / opus | execute-task                                                                        | Implementation, model+effort from scope size                                    |
| `browzer:code-reviewer` | opus          | code-review                                                                         | All 4 review lanes (senior-engineer, software-architect, qa, regression-tester) |
| `browzer:fixer`         | sonnet / opus | receiving-code-review                                                               | Per-finding fixes, 7-step escalation ladder                                     |
| `browzer:tester`        | sonnet        | write-tests                                                                         | Test authoring + mutation testing                                               |
| `browzer:doc-writer`    | sonnet        | update-docs Phase B                                                                 | Doc patching from discovery receipts                                            |

All agents carry `memory: project` — each accumulates a per-repo runbook at `.claude/agent-memory/<role>.md` across sessions. `browzer:code-reviewer` and `browzer:explorer` are read-only (`disallowedTools: [Write, Edit, MultiEdit]`).

`code-review` spawns 4 `browzer:code-reviewer` instances in parallel (one per lens). The regression-tester lane is non-collapsible — it is the only lane producing empirical evidence. `receiving-code-review` dispatches `browzer:fixer` per finding through a 7-step model-escalation ladder (sonnet → sonnet retry → research+sonnet → opus → opus retry → research+opus → tech-debt log). Haiku is forbidden for fix dispatch. Zero-tech-debt is the default.

`find-skills` operates in two modes: **interactive** (user-facing marketplace search) and **programmatic** (§0, invoked by `browzer:explorer` at S6 — scans installed skills under `.claude/skills/`, `.claude/plugins/`, `~/.claude/skills/` and returns only invocable `Skill(...)` names, never marketplace URLs). In programmatic mode the output JSON uses `installed` as the canonical top-level key for the skill list. **Anti-pattern:** do not emit `matched_installed_skills` as a top-level key — the judge contract and downstream dispatch agents expect `installed[]`; using any other key causes those agents to silently skip all discovered skills.

Universal subagent preamble lives at `references/subagent-preamble.md` (cross-skill, ≥2-skill threshold). It requires every code-touching subagent to run `browzer deps --reverse <file>` to probe blast radius before edits. Don't drop this when adding new dispatchers. Per-role preamble variants under `references/preambles/` were retired in v5.0.0 — the single shared preamble covers all dispatch lanes.

### Hooks (shell delegators + Go subcommands)

Wired by `hooks/hooks.json`. Each hook is a thin shell wrapper at `packages/skills/hooks/<name>.sh` (≤60 LOC, mode 0755) that:

1. Reads the Claude Code hook input JSON from stdin.
2. Pipes it to `browzer hook <name>` (a cobra subcommand in `packages/cli/internal/commands/hooks/<name>.go`).
3. Branches on the exit-code protocol: **0** = allow with payload on stdout, **1** = passthrough, **2** = deny, **3** = ask.
4. Emits Claude-Code `hookSpecificOutput` JSON via `jq -n` when the subcommand asks for it.
5. Short-circuits silently when `jq` or `browzer` is missing (so operators with an older CLI keep working until they upgrade).

All parsing, regex, daemon-RPC, and state logic lives in Go under `packages/cli/internal/hooks/` (`StripQuoted`, `ClassifyPath`/`NeverRewriteRE`/`ConfigSurfaceRE`, `DaemonCall`, `AppendPendingEvent`, `AcquireLock`, `SessionBannerEmittedOnce`, `GateAllowed`, `IsInBrowzerWorkspace`, `TrackEvent`, `EmitHookDelta`, etc.). The shell wrapper is intentionally trivial — single-source-of-truth for behaviour is the Go code, which is tested with `go test` and cross-compiled for darwin / linux / windows on every `make ci`.

| Event | Wrapper | Go subcommand | Purpose |
| --- | --- | --- | --- |
| `SessionStart` | `session-start.sh` | `browzer hook session-start` | Boots workspace context (`browzer status --json` summary) into the agent. |
| `PreToolUse(Bash)` | `rewrite-bash.sh` | `browzer hook rewrite-bash` | `BROWZER_LLM=1` env injection on `browzer …` invocations; run-proxy rewrite of `git status/log/diff/push/pull`, vitest, pnpm turbo, go test, cargo test, biome, tsc, cat/head/tail-on-large-files to `browzer run <cmd>` so stdout is compressed before the LLM sees it; compound commands with pipes/redirects are not rewritten. |
| `PreToolUse(Bash)` | `contract.sh` | `browzer hook contract` | Validates `browzer …` calls against the published CLI contract using `StripQuoted` so heredoc-embedded substrings never false-match. |
| `PreToolUse(Bash)` | `init.sh` | `browzer hook init` | Blocks accidental `browzer init` re-runs inside an already-initialised workspace. |
| `PreToolUse(Read)` | `rewrite-read.sh` | `browzer hook rewrite-read` | Emits a token-economy advisory (with optional head snippet) before large file reads; suggests `browzer explore` / `browzer read --filter=auto`. |
| `PreToolUse(Glob)` | `block-glob.sh` | `browzer hook block-glob` | Blocks broad globs in favor of `browzer explore`. |
| `PreToolUse(Grep)` | `suggest-grep.sh` | `browzer hook suggest-grep` | Suggests a `browzer search` rewrite for the captured pattern. |
| `PreToolUse(Edit\|Write)` | `prd-frozen.sh` | `browzer hook prd-frozen` | Denies edits to `**/staging/PRD*.md` when a `.prd-frozen` sentinel sits in the feature staging directory. |
| `PreToolUse(Task)` | `validate-subagent-type.sh` | `browzer hook validate-subagent-type` | Rejects unknown `subagent_type` dispatches with a Levenshtein-style suggestion. |
| `PostToolUse(Bash)` | `sync-on-push.sh` | `browzer hook sync-on-push` | Detached re-index after `git push`, `gh pr create/push`, `gh repo sync`, `glab mr create/push`, `glab repo push`. |
| `PostToolUse(Bash)` | `postuse-run.sh` | `browzer hook postuse-run` | Injects top-5 `additionalContext` entries when a `browzer explore/search/deps/ask` returns more than 10 JSON results. |
| `PostToolUse(Bash)` | `track-cli.sh` | `browzer hook track-cli` | Telemetry — records per-browzer-command duration / savedTokens for `browzer gain`. |
| `PostToolUse(Bash)` | `track-wasted.sh` | `browzer hook track-wasted` | Telemetry — records "wasted" tokens for `grep/rg/find/ls` invocations that could have been a single `browzer explore`. |
| `PostToolUse(Read\|Grep\|Glob)` | `postuse-{read,grep,glob}.sh` | `browzer hook postuse-{read,grep,glob}` | Telemetry / advisory follow-ups. |
| `PostToolUse(Edit\|Write)` | `incremental-sync.sh` | `browzer hook incremental-sync` | Fires a delta event so the daemon re-indexes the touched file. The retired `_auto-save-step.mjs` autosave bridge was removed in v5.0.0; phase skills write `staging/*.md` directly. |
| `UserPromptSubmit` | `prompt-guard.sh` | `browzer hook prompt-guard` | Auto-search vocabulary matcher (PT-BR + EN); honours `is_assistant_turn`; honours `exclude_keywords_assistant_only` in `.browzer/search-triggers.exclude.json`. |
| `SubagentStop` | `subagent-stop.sh` | `browzer hook subagent-stop` | Telemetry — per-subagent dispatch outcome. |
| `Stop` | `session-summary.sh` | `browzer hook session-summary` | Per-session token-economy summary (replaces `browzer gain --json` rendering). The quality-gate Stop hooks and the `PreCompact` re-anchor hook were retired in v5.4.0. |

Telemetry-flavoured handlers (`sync-on-push`, `track-cli`, `track-wasted`, `postuse-{read,grep,glob}`, `incremental-sync`, `subagent-stop`) carry `"async": true` in `hooks.json` so they never block the agent loop. The handler-fanout collapse landed here too: `rewrite-bash` 13 entries → 1; `sync-on-push` 7 → 1; `postuse-run` 4 → 1; `prd-frozen` 2 → 1 — the Go subcommand sees the full `tool_input.command` via stdin and applies its own internal filter. Host-only integration tests at `packages/skills/hooks/__tests__/{hooks-config,integration}.test.mjs` assert the manifest shape and exercise the shell delegators end-to-end (no references to the deleted `.mjs` guards remain). Disable per-hook with `BROWZER_HOOK_DISABLE=rewrite-bash,prompt-guard` or globally with `BROWZER_HOOK=off`. Opt-in audit log via `BROWZER_HOOK_AUDIT=1` (writes JSONL to `${BROWZER_AUDIT_DIR:-$HOME/.local/share/browzer}/hook-audit.log`).

### Step views (CLI-rendered)

`browzer get-step <ID> --id <feat>` (markdown by default, `--json` for the `#StepView` payload) renders an embedded Go template at `packages/cli/internal/workflow/view/templates/*.md.tmpl` (one per phase). It is **legacy** — it materialises views from `workflow.json`, which the markdown-chains pipeline no longer produces. In current skills, consuming prior workflow state means a direct `Read` of `docs/browzer/<feat>/staging/<PHASE>.md`. The CLI verb is preserved only for older features that still carry a `workflow.json`; new skill bodies should not introduce call-sites. The legacy `scripts/jq-helpers.sh` + `scripts/renderers/*.jq` projection layer was deleted in v5.0.0.

Two **virtual phases** existed only in the `workflow.json` era: `ORIGINAL_REQUEST` (verbatim operator ask) and `CONFIG` (`executionStrategy`, `mode`, `setAt`). In the markdown-chains pipeline they are materialised as concrete files in `staging/` — `CONFIG.md` is written by the orchestrator at entry, and `BRIEF.md` (or the operator's invocation prompt directly) carries the original request.

## Conventions when editing this package

- **Adding/changing a skill**: edit `skills/<name>/SKILL.md`, then run `pnpm validate-frontmatter`. Skills consume phase artefacts via `Read` against `docs/browzer/<feat>/staging/*.md` — `workflow.json` is legacy.
- **Schema changes (legacy `workflow.json` only)**: edit the upstream CUE source at `packages/cli/schemas/workflow-v1.cue`, run `make -C packages/cli/schemas all`. The CUE schema constrains the legacy CLI verbs (`workflow get-step`, `save-step`, `describe-step-type`); markdown-chains skills don't consult it and shouldn't carry mirrored schema prose.
- **Hooks**: every new hook needs an entry in `hooks/hooks.json` and a unit test next to it (see `hooks/__tests__/`). Hooks must return within ~50ms — long work goes in detached children spawned with `unref()`.
- **Trigger phrasing**: skill `description` frontmatter is the trigger surface — front-load concrete verbs and phrases the operator is likely to type. Vague descriptions silently misfire.
- **No `Co-authored-by:` for org attribution**: this monorepo uses `on-behalf-of: @browzeremb` per the `commit` skill. The `commit` skill encodes the canonical message format.
- **Bash `cd` convention**: The Claude Code Bash tool persists `cwd` across calls in the same session. To avoid surprising next-call resolution failures, ALWAYS use one of:
  - Absolute paths (`/abs/path/to/file`),
  - Repo-root-relative paths (when running from repo root),
  - Subshell-scoped `cd` (`(cd subdir && cmd)`) — the `()` isolates cwd from the outer shell.
    Never write `cd packages/cli && go vet` as a top-level Bash command — the next Bash call inherits the new cwd and fails for unrelated commands.

## Routing

When a user opens a session in a Browzer-indexed workspace:

- **Trivial ≤3-file read-only question** → answer inline, citing `path:line` from `browzer explore` / `search` / `deps`.
- **Multi-file feature, bugfix, or refactor** → delegate to `orchestrate-task-delivery`. Do NOT implement inline.
- **Refactor of a shared file** → run `browzer deps --reverse <path>` first to size the blast radius.

Surface assumptions and tradeoffs before acting; ask when ambiguous. Match existing style and scope.

## VERY IMPORTANT RULES

- This repository is a plugin for Claude Code that can be installed into other repositories. Therefore, everything here must remain agnostic, without any direct references to the current repository;
- Since this is an installed plugin, it will most likely be cached under `.claude/plugins/cache/browzer-marketplace/browzer/<version>`. Because of that, make sure that when making changes here and testing them, you are actually testing the correct and updated version:

```
Test your plugin
Run Claude Code with the --plugin-dir flag to load your plugin:
claude --plugin-dir ./my-first-plugin

Once Claude Code starts, try your new skill:
/my-first-plugin:hello
```

Reference: [Claude Code Plugins Documentation](https://code.claude.com/docs/en/plugins)
