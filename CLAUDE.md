# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative references (read first)

- **`docs/CLAUDE_CODE_PLUGIN.md`** — single source of truth for this plugin: layout, invariants, hooks, CI gates, frontmatter rules, token-economy tiers, session-log fixes, version trajectory, plugin-agnosticization checklist. Consult before any non-trivial change here.
- **`packages/cli/`** — the Go `browzer` CLI is the runtime side of this plugin. Skills are thin markdown wrappers around its commands; the workflow schema SSOT lives at `packages/cli/schemas/workflow-v1.cue`. This plugin MUST stay synchronized with the CLI: any change to a `browzer` subcommand surface (flags, JSON shape, exit codes, named queries, `get-step` view templates, `save-step` payload contract, mutator verbs like `append-step` / `append-steps` / `describe-step-type`) requires patching every skill body that invokes it in the same change, then rerunning `scripts/audit/skill-cli-references.mjs` + `skill-cli-sync-drift.mjs`. See `packages/cli/CLAUDE.md` for CLI-side conventions.

## What this package is

`@browzer/skills` is a **markdown-only Claude Code plugin**. It ships:

- Skills under `skills/<name>/` — each follows the canonical Anthropic Agent Skills layout: `SKILL.md` at the skill root, plus optional `template.md`, `examples/`, `scripts/`, `references/`. Single-skill content (templates, fixtures, refs loaded by exactly one skill) lives INSIDE the skill folder. The skill body is a frontmatter-prefixed markdown file driving an agent workflow around the `browzer` Go CLI (hybrid vector + Graph RAG).
- Lifecycle hooks under `hooks/guards/*.mjs` (Node ESM, no bundler) plus the `hooks/_auto-save-step.mjs` autosave bridge, wired by `hooks/hooks.json`.
- **Cross-skill shared references** under `references/` — ONLY for files loaded by **≥2 skills** (e.g. `subagent-preamble.md` consumed by every dispatching skill; `sensitive-paths.md` consumed by `code-review` fast-lane gate and `generate-task` Reviewer pass). Per-skill refs MUST live inside the skill (`skills/<name>/references/`); the `≥2-skill threshold` is the rule for promoting a doc to the global folder.
- Per-skill `scripts/` (only when the skill ships real helpers) — ESM modules and shell utilities tested via `node --test`. The plugin no longer ships `jq-helpers.sh` or `scripts/renderers/*.jq`: those depended on CLI verbs (`workflow patch`, `workflow set-status`, `workflow query`, `--render`) that were removed in CLI v3.0.0. State mutations now flow exclusively through the staging file → `PostToolUse(Write)` autosave → `browzer save-step` path; reads use `browzer get-step` markdown / `--json` views.

> **Host-only dev artifacts live at `scripts/packages/skills/` (monorepo root)** — NOT under `packages/skills/`. That host-only tree contains: `evals/<skill>/` (eval datasets), `regression/<skill>/iteration-N/` (regression fixtures), `audit/` (audit scripts), `__fixtures__/` (test fixtures), and the host-test scripts `run-skill-evals.mjs`, `test-skill-samples.mjs`, `validate-frontmatter.{mjs,test.mjs}`, `symlink-for-testing.mjs`, `detect-test-setup.mjs`. These are dev-only — they MUST NOT be added to `packages/skills/` because the plugin is mirrored to a public repo. The lefthook pre-push gate enforces this with `audit-skills-layout` + `skills-regression-smoke` under `glob: "packages/{cli,skills}/**"`, backed by `scripts/audit/check-skills-layout.mjs`.

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

The repo-wide quality gate (the one whose receipt shows up in `UserPromptSubmit` `additionalContext`) is `pnpm run browzer:gate` from the monorepo root — that is what this plugin's own Stop hook will run when developing inside a Browzer-initialized workspace.

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

`executionStrategy` resolution moved to Phase 3 in the v3.0.0 refactor — the orchestrator now picks `serial | parallel | parallel-worktrees | agent-teams` BEFORE `generate-task` runs, so the task plan is shaped by the chosen strategy. Step names (`BRAINSTORMING`, `PRD`, `TASKS_MANIFEST`, `TASK`, `CODE_REVIEW`, `RECEIVING_CODE_REVIEW`, `WRITE_TESTS`, `UPDATE_DOCS`, `FEATURE_ACCEPTANCE`, `COMMIT`) are an enum in `packages/cli/schemas/workflow-v1.cue`; adding a new phase means editing the CUE schema in the `browzer` Go CLI plus shipping the matching `internal/workflow/view/templates/<phase>.md.tmpl`, not this file.

### State lives in `workflow.json`, not chat history

Every workflow run persists to `docs/browzer/feat-<YYYYMMDD>-<slug>/workflow.json` (schema v2 today; v1 is read-only legacy). The v3.0.0 contract is **stage + autosave**: each phase skill writes its artefact to `docs/browzer/<feat>/staging/<PHASE>.{md,json}` via the standard `Write` tool, the `PostToolUse` autosave hook (`hooks/_auto-save-step.mjs`, matcher `Write`, `if: "Write($CLAUDE_PROJECT_DIR/docs/browzer/*/staging/**)"`, `asyncRewake: true`, 15s timeout) calls `browzer save-step <PHASE> --id <feat> --from <staged-file>`, and the CLI validates against CUE + writes `workflow.json` atomically. Downstream skills read via `browzer get-step <ID> --id <feat>` (markdown by default; `--json` for the `#StepView`). Direct `jq` writes / `Edit` / `Write` against `workflow.json` are still banned.

`--await` (default) blocks until durable fsync (~50–120ms with daemon, ~500ms standalone). `--async` returns immediately for non-load-bearing writes — but most phase skills now defer this to the autosave hook, which is `asyncRewake`-driven and never blocks the agent loop.

### Subagent dispatch contract

`code-review` always spawns 4 mandatory parallel agents (senior-engineer, software-architect, qa, regression-tester) plus domain specialists discovered via `find-skills`. The regression-tester lane is non-collapsible — it is the only lane producing empirical evidence. `receiving-code-review` then closes EVERY finding (high → low) on a 7-step model-escalation ladder (sonnet → sonnet retry → research+sonnet → opus → opus retry → research+opus → tech-debt log). Haiku is forbidden for fix dispatch. Zero-tech-debt is the default.

Universal subagent preamble lives at `references/subagent-preamble.md` (cross-skill, ≥2-skill threshold). It requires every code-touching subagent to run `browzer deps --reverse <file>` to probe blast radius before edits. Don't drop this when adding new dispatchers. Per-role preamble variants under `references/preambles/` were retired in v5.0.0 — the single shared preamble covers all dispatch lanes.

### Hooks under `hooks/guards/`

Wired by `hooks/hooks.json`:

- `SessionStart`: `browzer-session-start.mjs` runs `browzer status --json` so the agent boots with workspace context already injected.
- `PreToolUse(Bash)`: rewrites grep/find-style commands to `browzer explore`/`search`, enforces the contract, and intercepts `browzer init` flow. Also rewrites git (status/log/diff/push/pull — `git status` collapses to a single `branch=… M:N clean` line; `git log` collapses to `N commits; latest: <sha> <subject>` when >10 lines), vitest (standalone, `npx vitest`, and `pnpm run/exec/--filter vitest`), pnpm turbo test, go test (all-pass emits `"ok (N pass)"`; `[no test files]` lines suppressed), cargo test, biome, and tsc invocations to `browzer run <cmd>` so their stdout is compressed before the LLM sees it (failures-only for test runners; error lines + summary for linters). Compound commands containing pipes or redirects are not rewritten.
- `PreToolUse(Read|Glob|Grep)`: rewrites/blocks broad codebase reads in favor of `browzer explore` (semantic) so the main thread doesn't blow context on a manual repo walk.
- `PostToolUse(Bash)` (`browzer-postuse-run.mjs`): injects top-5 `additionalContext` entries when `browzer explore`/`search`/`deps`/`ask` returns more than 10 JSON entries, surfacing the most relevant results without bloating the context window.
- `PostToolUse(Bash)`: `browzer-sync-on-push.mjs` triggers re-index after `git push`.
- `PostToolUse(Edit|Write)`: `auto-format.mjs` + `incremental-sync.mjs` keep formatters and the index in sync per edit.
- `PostToolUse(Write)` (gated by `if: "Write($CLAUDE_PROJECT_DIR/docs/browzer/*/staging/**)"`): `hooks/_auto-save-step.mjs` validates the staged artefact and calls `browzer save-step` (asyncRewake, 15s timeout) — this is how phase skills persist their step output.

  **Autosave matcher invariant (resolved 2026-05-07):** The `if:` value in `hooks.json` is `Write(docs/browzer/*/staging/**)` (relative glob, no `$CLAUDE_PROJECT_DIR` prefix). Claude Code evaluates the `if:` rule against the absolute `file_path` from the Write payload. The hook fires correctly because `_auto-save-step.mjs` uses `STAGING_RE = /docs\/browzer\/([^/]+)\/staging\/([A-Z_0-9]+)\.(md|json)$/` — a **suffix match with no `^` anchor** — so it matches both relative paths (e.g. `docs/browzer/feat-x/staging/PRD.md`) and absolute paths (e.g. `/abs/path/docs/browzer/feat-x/staging/PRD.md`). The `if:` glob is also suffix-evaluated by Claude Code's permission rule engine, so the two align. **Do not add a `^` anchor to `STAGING_RE`** or the hook will silently stop firing for absolute paths. Verified by `hooks/__tests__/_auto-save-step.smoke.test.mjs`.
- `UserPromptSubmit`: `user-prompt-browzer-search.mjs` (auto-search) + `quality-gate-context.mjs` (pulls latest gate receipt).
- `PreCompact`: `precompact-reanchor.mjs` re-injects critical workflow state before context compression.
- `SubagentStop`: telemetry.
- `Stop`: `quality-gate-stop.mjs` spawns a detached gate run, writes a fingerprinted receipt under `.browzer/.gate-receipts/<sha-12>.json`, and returns within ~50ms — the agent loop is never blocked. Receipts are surfaced on the next prompt by the matching `UserPromptSubmit` hook.

Gate command resolution cascade (first non-null wins): `.browzer/skills.config.json#gates.affected` → `package.json#scripts["browzer:gate"]` → manifest auto-detect (`turbo.json` → turbo affected, else `pnpm test`, else pytest/go/cargo).

Disable hook with `BROWZER_HOOK=off` env or `hooks.qualityGate.enabled: false` in `.browzer/skills.config.json`.

### Step views (CLI-rendered)

The canonical "give me a token-economical view of step X" surface is now `browzer get-step <ID> --id <feat>` (markdown by default, `--json` for the `#StepView` payload). The view templates are embedded inside the Go binary at `packages/cli/internal/workflow/view/templates/*.md.tmpl` (one per phase) — when adding a new skill that consumes prior workflow state, extend those templates rather than hand-rolling jq projections. The legacy `scripts/jq-helpers.sh` + `scripts/renderers/*.jq` projection layer was deleted in v5.0.0; `get-step --json` returns the canonical `#StepView` directly.

Two **virtual phases** are materialized read-only by `get-step` and never staged or saved: `ORIGINAL_REQUEST` (verbatim operator ask captured at `workflow init` time) and `CONFIG` (carries `executionStrategy`, `mode`, `setAt`). Skills consume them like any other phase — `browzer get-step ORIGINAL_REQUEST --id <feat>` / `browzer get-step CONFIG --id <feat>` — but no `save-step` exists for them.

## Conventions when editing this package

- **Adding/changing a skill**: edit `skills/<name>/SKILL.md`, then run `pnpm validate-frontmatter`. If the skill consumes `workflow.json` data, add or update its renderer + fixture sample.
- **Schema changes**: edit the upstream CUE source at `packages/cli/schemas/workflow-v1.cue`, run `make -C packages/cli/schemas all`. Skills no longer carry mirrored schema prose — they discover shapes at runtime via `browzer workflow describe-step-type <NAME> --json`.
- **Hooks**: every new hook needs an entry in `hooks/hooks.json` and a unit test next to it (see `hooks/__tests__/`). Hooks must return within ~50ms — long work goes in detached children, like `quality-gate-stop.mjs`.
- **Trigger phrasing**: skill `description` frontmatter is the trigger surface — front-load concrete verbs and phrases the operator is likely to type. Vague descriptions silently misfire.
- **No `Co-authored-by:` for org attribution**: this monorepo uses `on-behalf-of: @browzeremb` per the `commit` skill. The `commit` skill encodes the canonical message format.

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
