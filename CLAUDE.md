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

> **Host-only dev artifacts live at `scripts/packages/skills/` (monorepo root)** — NOT under `packages/skills/`. That host-only tree contains: `evals/<skill>/` (eval datasets), `regression/<skill>/iteration-N/` (canonical regression fixtures) plus `regression/<skill>/iteration-N-<tag>/` and `regression/iteration-N-baseline/` for ad-hoc / cross-skill baselines, `lib/` (shared ESM helpers consumed by the eval runners — e.g. `grader.mjs`, the assertion grader that handles both `{name, check}` and `{text, type, value|pattern}` shapes), `audit/` (audit scripts), `__fixtures__/` (test fixtures), and the host-test scripts `run-skill-evals.mjs`, `test-skill-samples.mjs`, `validate-frontmatter.{mjs,test.mjs}`, `symlink-for-testing.mjs`, `detect-test-setup.mjs`. These are dev-only — they MUST NOT be added to `packages/skills/` because the plugin is mirrored to a public repo. The lefthook pre-push gate enforces this with `audit-skills-layout` + `skills-regression-smoke` under `glob: "packages/{cli,skills}/**"`, backed by `scripts/audit/check-skills-layout.mjs`.

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

Smoke (~$2-7, 1 fixture) is the floor for every PR. `--tier=standard` (~$8) before pre-release. `--tier=full` (~$50, all 4 fixtures) before any refactor of `orchestrate-task-delivery` itself, plus on the post-merge `--update-baseline` commit. Always `--dry-run` first to see the cost estimate; never `--update-baseline` outside `--tier=full`. See `.claude/skills/baseline-regression-skills/SKILL.md` for the operator workflow and `scripts/packages/skills/baseline-regression/README.md` for the harness internals. If the harness reports regressions, the fix belongs in the skill body / CLI internals — not in `BASELINE.json`.

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

`executionStrategy` resolution moved to Phase 3 in the v3.0.0 refactor — the orchestrator now picks `serial | parallel | parallel-worktrees | agent-teams` BEFORE `generate-task` runs, so the task plan is shaped by the chosen strategy. Step names (`BRAINSTORMING`, `PRD`, `TASKS_MANIFEST`, `TASK`, `CODE_REVIEW`, `RECEIVING_CODE_REVIEW`, `WRITE_TESTS`, `UPDATE_DOCS`, `FEATURE_ACCEPTANCE`, `COMMIT`) are an enum in `packages/cli/schemas/workflow-v1.cue`; adding a new phase means editing the CUE schema in the `browzer` Go CLI plus shipping the matching `internal/workflow/view/templates/<phase>.md.tmpl`, not this file.

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

| Agent | Model | Dispatched by | Role |
|---|---|---|---|
| `browzer:explorer` | haiku | generate-task, execute-task, code-review, update-docs, orchestrate-task-delivery S6 | RAG discovery, blast-radius, find-skills programmatic mode |
| `browzer:pm` | sonnet / opus | orchestrate-task-delivery Phase 1 | PRD authoring, scaled by `$COMPLEXITY` |
| `browzer:po` | sonnet / opus | orchestrate-task-delivery Phase 2 | Task decomposition, scaled by PRD complexity |
| `browzer:coder` | sonnet / opus | execute-task | Implementation, model+effort from scope size |
| `browzer:code-reviewer` | opus | code-review | All 4 review lanes (senior-engineer, software-architect, qa, regression-tester) |
| `browzer:fixer` | sonnet / opus | receiving-code-review | Per-finding fixes, 7-step escalation ladder |
| `browzer:tester` | sonnet | write-tests | Test authoring + mutation testing |
| `browzer:doc-writer` | sonnet | update-docs Phase B | Doc patching from discovery receipts |

All agents carry `memory: project` — each accumulates a per-repo runbook at `.claude/agent-memory/<role>.md` across sessions. `browzer:code-reviewer` and `browzer:explorer` are read-only (`disallowedTools: [Write, Edit, MultiEdit]`).

`code-review` spawns 4 `browzer:code-reviewer` instances in parallel (one per lens). The regression-tester lane is non-collapsible — it is the only lane producing empirical evidence. `receiving-code-review` dispatches `browzer:fixer` per finding through a 7-step model-escalation ladder (sonnet → sonnet retry → research+sonnet → opus → opus retry → research+opus → tech-debt log). Haiku is forbidden for fix dispatch. Zero-tech-debt is the default.

`find-skills` operates in two modes: **interactive** (user-facing marketplace search) and **programmatic** (§0, invoked by `browzer:explorer` at S6 — scans installed skills under `.claude/skills/`, `.claude/plugins/`, `~/.claude/skills/` and returns only invocable `Skill(...)` names, never marketplace URLs). In programmatic mode the output JSON uses `installed` as the canonical top-level key for the skill list. **Anti-pattern:** do not emit `matched_installed_skills` as a top-level key — the judge contract and downstream dispatch agents expect `installed[]`; using any other key causes those agents to silently skip all discovered skills.

Universal subagent preamble lives at `references/subagent-preamble.md` (cross-skill, ≥2-skill threshold). It requires every code-touching subagent to run `browzer deps --reverse <file>` to probe blast radius before edits. Don't drop this when adding new dispatchers. Per-role preamble variants under `references/preambles/` were retired in v5.0.0 — the single shared preamble covers all dispatch lanes.

### Hooks under `hooks/guards/`

Wired by `hooks/hooks.json`:

- `SessionStart`: `browzer-session-start.mjs` runs `browzer status --json` so the agent boots with workspace context already injected.
- `PreToolUse(Bash)`: rewrites grep/find-style commands to `browzer explore`/`search`, enforces the contract, and intercepts `browzer init` flow. Also rewrites git (status/log/diff/push/pull — `git status` collapses to a single `branch=… M:N clean` line; `git log` collapses to `N commits; latest: <sha> <subject>` when >10 lines), vitest (standalone, `npx vitest`, and `pnpm run/exec/--filter vitest`), pnpm turbo test, go test (all-pass emits `"ok (N pass)"`; `[no test files]` lines suppressed), cargo test, biome, and tsc invocations to `browzer run <cmd>` so their stdout is compressed before the LLM sees it (failures-only for test runners; error lines + summary for linters). Compound commands containing pipes or redirects are not rewritten.
- `PreToolUse(Read|Glob|Grep)`: rewrites/blocks broad codebase reads in favor of `browzer explore` (semantic) so the main thread doesn't blow context on a manual repo walk.
- `PostToolUse(Bash)` (`browzer-postuse-run.mjs`): injects top-5 `additionalContext` entries when `browzer explore`/`search`/`deps`/`ask` returns more than 10 JSON entries, surfacing the most relevant results without bloating the context window.
- `PostToolUse(Bash)`: `browzer-sync-on-push.mjs` triggers re-index after `git push`.
- `PostToolUse(Edit|Write)`: `auto-format.mjs` + `incremental-sync.mjs` keep formatters and the index in sync per edit.
- `PostToolUse(Edit|Write)`: `auto-format.mjs` + `incremental-sync.mjs` keep formatters and the index in sync per edit. The `_auto-save-step.mjs` autosave bridge (which previously matched `Write(docs/browzer/*/staging/**)` and called `browzer save-step`) was retired in v5.0.0 along with the staging directory and `workflow.json`. Phase skills now write output `.md` files directly and no hook mediates persistence.
- `UserPromptSubmit`: `user-prompt-browzer-search.mjs` (auto-search; honors `is_assistant_turn` flag and `exclude_keywords_assistant_only` field in `.browzer/search-triggers.exclude.json` to suppress searches on assistant-initiated prompts) + `quality-gate-context.mjs` (pulls latest gate receipt; suppresses pre-existing failures using word-boundary regex rather than naive substring match).
- `PreCompact`: `precompact-reanchor.mjs` re-injects critical workflow state before context compression.
- `SubagentStop`: telemetry.
- `Stop`: `quality-gate-stop.mjs` spawns a detached gate run keyed by `sessionId` (baseline captured at `$TMPDIR/.browzer-gate/<sessionId>-baseline.json` via peer module `hooks/_session-baseline.mjs`), writes a fingerprinted receipt under `.browzer/.gate-receipts/<sha-12>.json`, and returns within ~50ms — the agent loop is never blocked. Receipts are surfaced on the next prompt by the matching `UserPromptSubmit` hook.

  **Dedup-key design (FR-13/R-30):** the dedup key is the git-tree fingerprint alone — not fingerprint+exitCode. A terminal receipt (passed OR failed) for a given fingerprint suppresses re-runs for the full TTL; the developer must change the tree to get a new fingerprint. Default TTL is **1800s** (30 min); override via `.browzer/skills.config.json#hooks.qualityGate.receipt.ttl`. Stale pending receipts (detached child lost to SIGKILL/sleep) are evicted by `pruneOldReceipts` on the next Stop event once `startedAt + timeoutSec > now`.

Gate command resolution cascade (first non-null wins): `.browzer/skills.config.json#gates.affected` → `package.json#scripts["browzer:gate"]` → manifest auto-detect (`turbo.json` → turbo affected, else `pnpm test`, else pytest/go/cargo).

Disable hook with `BROWZER_HOOK=off` env or `hooks.qualityGate.enabled: false` in `.browzer/skills.config.json`.

### Step views (CLI-rendered)

The canonical "give me a token-economical view of step X" surface is now `browzer get-step <ID> --id <feat>` (markdown by default, `--json` for the `#StepView` payload). The view templates are embedded inside the Go binary at `packages/cli/internal/workflow/view/templates/*.md.tmpl` (one per phase) — when adding a new skill that consumes prior workflow state, extend those templates rather than hand-rolling jq projections. The legacy `scripts/jq-helpers.sh` + `scripts/renderers/*.jq` projection layer was deleted in v5.0.0; `get-step --json` returns the canonical `#StepView` directly.

Two **virtual phases** are materialized read-only by `get-step` and never written directly: `ORIGINAL_REQUEST` (verbatim operator ask) and `CONFIG` (carries `executionStrategy`, `mode`, `setAt`). In the markdown-chains pipeline these are not needed — the operator request is in the conversation context and strategy is documented in `TASK_GRAPH.md`.

## Conventions when editing this package

- **Adding/changing a skill**: edit `skills/<name>/SKILL.md`, then run `pnpm validate-frontmatter`. If the skill consumes `workflow.json` data, add or update its renderer + fixture sample.
- **Schema changes**: edit the upstream CUE source at `packages/cli/schemas/workflow-v1.cue`, run `make -C packages/cli/schemas all`. Skills no longer carry mirrored schema prose — they discover shapes at runtime via `browzer workflow describe-step-type <NAME> --json`.
- **Hooks**: every new hook needs an entry in `hooks/hooks.json` and a unit test next to it (see `hooks/__tests__/`). Hooks must return within ~50ms — long work goes in detached children, like `quality-gate-stop.mjs`.
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
