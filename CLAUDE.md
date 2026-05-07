# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative references (read first)

- **`docs/CLAUDE_CODE_PLUGIN.md`** — single source of truth for this plugin: layout, invariants, hooks, CI gates, frontmatter rules, token-economy tiers, session-log fixes, version trajectory, plugin-agnosticization checklist. Consult before any non-trivial change here.
- **`packages/cli/`** — the Go `browzer` CLI is the runtime side of this plugin. Skills are thin markdown wrappers around its commands; the workflow schema SSOT lives at `packages/cli/schemas/workflow-v1.cue` and codegen produces `packages/skills/references/workflow-schema.md` plus the per-skill mirrors. This plugin MUST stay synchronized with the CLI: any change to a `browzer` subcommand surface (flags, JSON shape, exit codes, named queries, `--render` templates, mutator verbs like `append-step` / `append-steps` / `patch` / `describe-step-type`) requires patching every skill body that invokes it in the same change, regenerating mirrored references via `make -C packages/cli/schemas all` + `node packages/skills/scripts/sync-shared-refs.mjs`, and rerunning `scripts/audit/skill-cli-references.mjs` + `skill-cli-sync-drift.mjs`. See `packages/cli/CLAUDE.md` for CLI-side conventions.

## What this package is

`@browzer/skills` is a **markdown-only Claude Code plugin**. It ships:

- 24 skills under `skills/<name>/SKILL.md` — each is a frontmatter-prefixed markdown file driving an agent workflow around the `browzer` Go CLI (hybrid vector + Graph RAG).
- 9 lifecycle hooks under `hooks/guards/*.mjs` (Node ESM, no bundler) wired by `hooks/hooks.json`.
- Shared cross-skill reference docs under `references/` (workflow-schema, pipeline-phases, mode-contract, subagent preambles).
- Build/validation tooling under `scripts/` (frontmatter validator, jq render templates, eval harness, sample tester).

There is no source compilation step — the package distributes raw markdown + ESM scripts. `lint` and `typecheck` are no-ops by design.

## Commands

Run from this package directory (`packages/skills/`) unless noted.

```bash
# Validate every SKILL.md frontmatter against the spec
pnpm validate-frontmatter

# Full test gate (frontmatter + script unit tests)
pnpm test

# Just the script-level node:test runs
pnpm test:scripts

# Replay --render template golden samples (jq renderers under scripts/renderers/)
pnpm test:skill-samples

# Skill eval harness — needs ../../.env.local (Anthropic key, etc.)
pnpm test:evals

# Per-skill eval (skl1 = single skill, see scripts/run-skill-evals.mjs)
pnpm test:evals:skl1
```

Run a single test file directly:

```bash
node --test scripts/validate-frontmatter.test.mjs
node --test skills/<skill>/scripts/<file>.test.mjs
```

The repo-wide quality gate (the one whose receipt shows up in `UserPromptSubmit` `additionalContext`) is `pnpm run browzer:gate` from the monorepo root — that is what this plugin's own Stop hook will run when developing inside a Browzer-initialized workspace.

## Architecture — big picture

### Skills are markdown contracts, not code

Each `skills/<name>/SKILL.md` has a YAML frontmatter (`name`, `description`, model hints) followed by a prose contract that an agent loads at trigger time. Triggering is description-driven: write descriptions that begin with concrete trigger phrases ("Use when…", verb lists), since Claude Code matches on description text. `validate-frontmatter.mjs` enforces the schema; do not bypass it.

Some skills carry their own `scripts/` subfolder — these are real ESM helpers (e.g. `--render` template harnesses) shipped alongside the markdown and tested via `node --test`.

### The workflow pipeline (the heart of the plugin)

`orchestrate-task-delivery` is the master orchestrator. It runs a fixed phase chain on any non-trivial change:

```
brainstorming → generate-prd → generate-task → execute-task (× N) →
write-tests → code-review → receiving-code-review → update-docs →
PRE_PUSH_GATE → feature-acceptance → commit → sync-workspace
```

Phase-to-skill mapping is canonical in `references/pipeline-phases.md` §1. Step names (`BRAINSTORMING`, `PRD`, `TASKS_MANIFEST`, `TASK`, `CODE_REVIEW`, `RECEIVING_CODE_REVIEW`, `WRITE_TESTS`, `UPDATE_DOCS`, `FEATURE_ACCEPTANCE`, `COMMIT`) are an enum in the workflow schema (`references/workflow-schema.md` §2) — adding a new phase means editing the upstream CUE schema in the `browzer` Go CLI, not this file.

### State lives in `workflow.json`, not chat history

Every workflow run persists to `docs/browzer/feat-<YYYYMMDD>-<slug>/workflow.json` (schema v2 today; v1 is read-only legacy). It is **only** mutated through the `browzer workflow {append-step,patch,set-config,set-status,set-current-step,complete-step}` CLI surface — never by direct `jq` writes, never by editing the file, never via Edit/Write tools. Downstream skills consume by **named query** + `--render` jq templates (`scripts/renderers/*.jq`) so a 20-task plan keeps the main thread's working set O(1).

`--await` (default) blocks until durable fsync (~50–120ms with daemon, ~500ms standalone). `--async` returns immediately for non-load-bearing writes; see `references/pipeline-phases.md` §2 for the heuristics.

### Subagent dispatch contract

`code-review` always spawns 4 mandatory parallel agents (senior-engineer, software-architect, qa, regression-tester) plus domain specialists discovered via `find-skills`. The regression-tester lane is non-collapsible — it is the only lane producing empirical evidence. `receiving-code-review` then closes EVERY finding (high → low) on a 7-step model-escalation ladder (sonnet → sonnet retry → research+sonnet → opus → opus retry → research+opus → tech-debt log). Haiku is forbidden for fix dispatch. Zero-tech-debt is the default.

Universal subagent preamble (`references/subagent-preamble.md`, plus per-role preambles under `references/preambles/`) requires every code-touching subagent to run `browzer deps --reverse <file>` to probe blast radius before edits. Don't drop this when adding new dispatchers.

### Hooks under `hooks/guards/`

Wired by `hooks/hooks.json`:

- `SessionStart`: `browzer-session-start.mjs` runs `browzer status --json` so the agent boots with workspace context already injected.
- `PreToolUse(Bash)`: rewrites grep/find-style commands to `browzer explore`/`search`, enforces the contract, and intercepts `browzer init` flow.
- `PreToolUse(Read|Glob|Grep)`: rewrites/blocks broad codebase reads in favor of `browzer explore` (semantic) so the main thread doesn't blow context on a manual repo walk.
- `PostToolUse(Bash)`: `browzer-sync-on-push.mjs` triggers re-index after `git push`.
- `PostToolUse(Edit|Write)`: `auto-format.mjs` + `incremental-sync.mjs` keep formatters and the index in sync per edit.
- `UserPromptSubmit`: `user-prompt-browzer-search.mjs` (auto-search) + `quality-gate-context.mjs` (pulls latest gate receipt).
- `PreCompact`: `precompact-reanchor.mjs` re-injects critical workflow state before context compression.
- `SubagentStop`: telemetry.
- `Stop`: `quality-gate-stop.mjs` spawns a detached gate run, writes a fingerprinted receipt under `.browzer/.gate-receipts/<sha-12>.json`, and returns within ~50ms — the agent loop is never blocked. Receipts are surfaced on the next prompt by the matching `UserPromptSubmit` hook.

Gate command resolution cascade (first non-null wins): `.browzer/skills.config.json#gates.affected` → `package.json#scripts["browzer:gate"]` → manifest auto-detect (`turbo.json` → turbo affected, else `pnpm test`, else pytest/go/cargo).

Disable hook with `BROWZER_HOOK=off` env or `hooks.qualityGate.enabled: false` in `.browzer/skills.config.json`.

### Renderers (`scripts/renderers/*.jq`)

jq templates that downstream skills invoke via `browzer workflow get --render <template>`. They produce token-economical projections of `workflow.json` (e.g., a TASK with only its scope + skillsFound). When adding a new skill that consumes prior workflow state, write a `.jq` renderer rather than parsing the whole `workflow.json` in-band — and add a golden sample under `scripts/__fixtures__/` covered by `pnpm test:skill-samples`.

## Conventions when editing this package

- **Adding/changing a skill**: edit `skills/<name>/SKILL.md`, then run `pnpm validate-frontmatter`. If the skill consumes `workflow.json` data, add or update its renderer + fixture sample.
- **Schema changes**: do **not** edit `references/workflow-schema.md` (it is generated from the upstream CUE source in the `browzer` CLI). Edit there, regenerate.
- **Hooks**: every new hook needs an entry in `hooks/hooks.json` and a unit test next to it (see `hooks/__tests__/`). Hooks must return within ~50ms — long work goes in detached children, like `quality-gate-stop.mjs`.
- **Trigger phrasing**: skill `description` frontmatter is the trigger surface — front-load concrete verbs and phrases the operator is likely to type. Vague descriptions silently misfire.
- **No `Co-authored-by:` for org attribution**: this monorepo uses `on-behalf-of: @browzeremb` per the `commit` skill. The `commit` skill encodes the canonical message format.
