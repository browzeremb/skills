# @browzer/skills

Claude Code SKILLs for [Browzer](https://browzeremb.com) — hybrid vector + Graph RAG search and ingestion for codebases and document workspaces, wrapping the [`browzer` CLI](https://github.com/browzeremb/browzer-cli) (a single static Go binary, no Node required).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Contents

- [Install as Claude Code Plugin](#claude-code-plugin)
- [Install as Skills](#install-as-skills)
- [CLI Setup](#cli-setup)
- [Available Skills](#available-skills)
- [Configure](#configure)
- [Documentation](#documentation)

---

## Claude Code Plugin (recommended)

Install all skills as a Claude Code plugin:

```bash
/plugin marketplace add browzeremb/skills
/plugin install browzer@browzer-marketplace
```

After install, skills are available as `/browzer:explore-workspace-graphs`, `/browzer:semantic-search`, `/browzer:generate-prd`, etc.

---

## Install as Skills

### Local dev

```bash
git clone https://github.com/browzeremb/skills
claude --plugin-dir ./skills
```

Run `/reload-plugins` inside Claude Code if you edit a SKILL.

---

## CLI Setup

> Requires the `browzer` CLI. [Install instructions](./cli-install.md)

```bash
# Pick ONE channel:
curl -fsSL https://browzeremb.com/install.sh | sh        # macOS / Linux / WSL
# brew install browzeremb/tap/browzer                    # Homebrew
# scoop install browzer                                  # Windows
# go install github.com/browzeremb/browzer-cli/cmd/browzer@latest

browzer login
browzer status --json
```

A `SessionStart` hook runs `browzer status --json` at the top of every session so the agent boots already knowing which workspace is active.

---

## Available Skills

### RAG (search + ingestion)

| Skill                                                        | Wraps                             | Use it for                                   |
| ------------------------------------------------------------ | --------------------------------- | -------------------------------------------- |
| [embed-workspace-graphs](skills/embed-workspace-graphs/)     | `browzer init`, `workspace index` | Create workspace + index code structure      |
| [embed-documents](skills/embed-documents/)                   | `browzer workspace docs`          | Interactive TUI picker for markdown/PDF docs |
| [explore-workspace-graphs](skills/explore-workspace-graphs/) | `browzer explore`                 | Hybrid vector + Graph RAG over **code**      |
| [semantic-search](skills/semantic-search/)                   | `browzer search`                  | Semantic search over **docs**                |
| [dependency-graph](skills/dependency-graph/)                 | `browzer deps`                    | Per-file import graph + blast radius         |
| [ingestion-jobs](skills/ingestion-jobs/)                     | `browzer job get`                 | Poll async batches + parse gates             |

### Workflow (`generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace`)

The workflow skills persist their artefacts to a single `docs/browzer/feat-<date>-<slug>/workflow.json` per feature — schema v1, mutated only via the `browzer workflow *` CLI surface. Downstream skills consume by **named query** + **--render** templates instead of re-walking chat history, so a 20-task plan keeps the main thread's working set O(1).

| Skill                            | Wraps                                         | Use it for                                                                 |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| [generate-prd](skills/generate-prd/)         | `browzer explore`/`deps`/`search`             | Step 1 — PRD grounded in real repo context; writes `STEP_02_PRD` to `workflow.json`. Auto-routes through `brainstorming` (step 0) when the input is vague. |
| [generate-task](skills/generate-task/)       | `browzer explore`/`deps`/`search`             | Step 2 — Explorer + Reviewer two-pass decomposition; writes `STEP_03_TASKS_MANIFEST` + per-task steps |
| [execute-task](skills/execute-task/) | `browzer explore`/`deps`/`search` + subagents | Step 3 (serial strategy) — implement one task end-to-end via per-domain specialist dispatch |
| [execute-with-teams](skills/execute-with-teams/) | TeamCreate + TaskList + N specialists | Step 3 (agent-teams strategy) — domain-bound parallel specialists with a standing test-and-mutation specialist; zero merge conflicts when domain isolation holds |
| [update-docs](skills/update-docs/)   | `browzer deps --reverse`, `browzer explore`/`search`, markdown files | Step 4 — patches every doc that the three signals (mentions + direct-ref + concept-level) surface; no per-run search budget |
| [commit](skills/commit/)   | `git`, `gh`, `glab`                           | Step 5 — Conventional Commits only; pending-SHA two-commit pattern when the staged diff carries placeholders |
| [sync-workspace](skills/sync-workspace/)       | `browzer workspace sync`                      | Step 6 — re-index code + reconcile docs                                    |

### Quality (always part of the pipeline)

| Skill                                                                | Wraps                                                       | Use it for                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| [brainstorming](skills/brainstorming/)                               | `browzer explore`/`search` + parallel research subagents    | Step 0 — converge on intent before any PRD. Asks one question at a time until a convergence checklist is fully resolved; dispatches up to 3 parallel research agents (WebFetch / WebSearch / MCPs) for doubts neither operator nor agent can answer. |
| [code-review](skills/code-review/)                                   | parallel agents + consolidator                              | 4 mandatory agents — senior-engineer (cyclomatic + DRY + clean code), software-architect (race conditions + clean architecture + caching + perf), qa (regressions + edge cases + butterfly-effect), regression-tester (scoped tests over modified files + browzer deps) — plus domain specialists from `/find-skills`. The regression-tester is non-collapsible even when the consolidator falls into single-pass mode (it is the only lane producing empirical evidence). Read-only — `receiving-code-review` applies fixes next. |
| [receiving-code-review](skills/receiving-code-review/)               | per-finding fix-agent dispatch                              | Closes EVERY code-review finding (high → low) with a 7-step ladder: sonnet → sonnet retry → research-then-sonnet → opus → opus retry → research-then-opus → log to tech-debt. Zero-tech-debt by default. Haiku is forbidden for fix dispatch. |
| [write-tests](skills/write-tests/)                                   | repo's test runner + Stryker / mutmut / go-mutesting        | Authors green tests AND runs mutation testing in the same pass against the FINAL post-fix file set. Phase 1.0 pre-flight probes the repo's test infra (`pnpm test:env:wake`, Playwright Chromium install, Docker fixtures) before declaring "no test setup" — deferral requires a real probe, not a guess. Each authored test is mutation-resistant by design. |
| [feature-acceptance](skills/feature-acceptance/)                     | scoped tests + Agent inspection + live-verify probes         | Verifies every PRD `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]`. Phase 1.5 probes available local-verification tooling (`pnpm dev:local`, `mcp__claude-in-chrome__*`, `agent-browser` skill) BEFORE deferring manual-AC items to operator follow-up — the autonomous path tries to live-verify before logging an `operatorActionsRequested[]` entry. |

### Orchestration (meta)

| Skill                                          | Wraps                                   | Use it for                                                                 |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| [orchestrate-task-delivery](skills/orchestrate-task-delivery/) | the full pipeline | Master router — drives `brainstorming?` → `generate-prd` → `generate-task` → (per task: `execute-task`) → `code-review` → `receiving-code-review` → `write-tests` → `update-docs` → `feature-acceptance` → `commit` → `sync-workspace` end-to-end. Use for any non-trivial task, idea-to-ship flows, mid-flow entries (`execute-task TASK_03`, `commit what's staged`), or when a request spans code + docs + ops. |

### Ops + tools

| Skill                                                      | Wraps                                               | Use it for                                  |
| ---------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| [use-rag-cli](skills/use-rag-cli/)                         | `browzer login/logout/upgrade`                      | Install + auth (anchor skill)               |
| [browzer-bootstraper](skills/browzer-bootstraper/) | `browzer init`/`index`/`sync` + doc reconciliation against actual code | Onboard a repo into Browzer: audit existing docs against the codebase, delete stale/duplicate/incorrect content outright, present diff for operator confirmation, commit, then index/sync against the cleaned docs |
| [auth-status](skills/auth-status/)                         | `browzer status --json`                             | Pre-flight context probe                    |
| [workspace-management](skills/workspace-management/)       | `browzer workspace {list,get,delete,unlink,relink}` | Multi-tenant workspace management           |

---

## Skill output contract (normative)

Every skill in this package conforms to a single-line output contract. A skill is non-conforming if it prints a multi-line summary, a copy of the artefact it just wrote, or a "Next steps" block.

The contract exists because skills compose: `orchestrate-task-delivery` dispatches six to ten of them in sequence, and if each skill prints twenty lines of recap the main thread's context is full by phase four. The contract holds main-thread tokens constant regardless of plan size, which is the only way a 20-task run remains cost-viable.

### Success — one confirmation line

On success, a skill emits exactly one line of user-visible text:

```
<skill-name>: <verb-past> <path> (<metric>)
```

Examples:

```
generate-prd: wrote docs/browzer/feat-20260422-user-auth-flow/PRD.md (186 lines)
generate-task: wrote 5 TASK_NN.md files under docs/browzer/feat-20260422-user-auth-flow/; receipt at .meta/activation-receipt.json
execute-task: TASK_03 ok (3 files, 2 subagents, gates green); report at .meta/HANDOFF_03.json
execute-task: TASK_07 ok (1 file inlined, gates green); report at .meta/HANDOFF_07.json
update-docs: patched 4 markdown files (2 direct refs, 2 concept-level); report at .meta/UPDATE_DOCS_20260422T174500Z.json
commit: 3f2e1a0 fix(api/auth): close TOCTOU in session refresh
sync-workspace: re-indexed 12 code files, reconciled docs (3 reuploaded, 1 deleted, 8 skipped); payload at /tmp/sync.json
```

The `inlined` marker on `execute-task` is used when zero subagents were dispatched and the task met the <15-line integration-glue cap — see `skills/execute-task/SKILL.md` §Phase 9 for the guidance. `sync-workspace` never inserts new docs (use `embed-documents` for that) — the example vocabulary (reuploaded / deleted / skipped) matches the actual payload shape declared in `skills/sync-workspace/SKILL.md` §Output contract.

Shape rules:

- Start with the skill's own name (not "I wrote…", not "Here's…"). The name is the machine-readable key downstream skills grep for.
- Past-tense verb for what happened (`wrote`, `patched`, `ok`, `re-indexed`, `failed`). Present tense reads like narration; past tense reads like a log line.
- Then the path (where the artefact lives) or the identifier (`TASK_03`, the commit SHA). Something the operator can act on.
- Then one compact metric in parentheses — line count, file count, gates status. Enough to know whether to look further.

### Warnings append with `;`

Non-fatal warnings (staleness gates, degraded indexes, budget truncation, worktree isolation skipped by assertion) append to the confirmation line after a `;` separator. No multi-paragraph warning blocks, no reprinting the full warning that the CLI already emitted to stderr.

```
generate-prd: wrote docs/browzer/feat-.../PRD.md (186 lines); ⚠ index 23 commits behind HEAD
update-docs: patched 3 markdown files (1 direct ref, 2 concept-level); report at .meta/UPDATE_DOCS_20260422T174500Z.json; ⚠ search budget exhausted at 8 calls, 2 candidates unverified
```

**Precedence when multiple `;`-separated clauses apply**: metric first (inside the parens), then the report path, then warnings — in that order. A success line with all three looks like `<skill>: <verb> <path> (<metric>); report at <path>; ⚠ <warning>`. This precedence is the only way the line stays parseable by the orchestrator — it greps for `; report at` and `; ⚠` as distinct suffixes.

### Failure — one cause line plus one hint

On failure, two lines. Nothing more.

```
<skill-name>: failed — <one-line cause>
hint: <single actionable next step>
```

Example:

```
sync-workspace: failed — server returned 500 for 3 consecutive retries (10s/20s/30s backoff)
hint: inspect `browzer status --json` and retry; or isolate the failing leg with `sync-workspace --skip-docs` (code-only) or `--skip-code` (docs-only)
```

No stack traces. No "I tried X then Y then Z" narrative. No menu of five alternatives — one hint.

### Machine-readable reports

Some skills (`execute-task`, `update-docs`, `generate-task`) emit a structured JSON report for downstream consumers (the orchestrator's next phase, retros, billing, audit). The report is written to a known path — `docs/browzer/feat-<slug>/.meta/<NAME>.json` — and is **not** printed in chat. The confirmation line names the path; callers open the file when they need to decide something.

### What is banned

The rule is intent-based. Anything whose effect is to re-display information the operator already has (the file they just wrote, the diff they just staged, the step they are about to take) is non-conforming:

- `Next steps` / `Here's what I did` / `Summary of changes` blocks.
- TODO / checklist blocks at the end of the skill's output.
- Inline copies of the written artefact (PRD body, task spec, commit diff, HANDOFF JSON).
- Multi-line status reports describing subagent work — keep the ACK, drop the narrative.
- "Workflow stage: execute-task (3/6) · previous: … · next: …" footers — the orchestrator knows the phase; the user does not need it pasted per skill.

### Clarifying questions are allowed

This contract governs the **result** of a successful skill run, not the conversation that leads up to it. A skill that legitimately needs to ask the operator one clarifying question (ambiguous slug, collision on feat folder, destructive op) still asks — the contract kicks in once the skill has the information it needs and has produced or attempted its artefact.

### Rationale

The contract was codified after internal retrospectives documented repeated cases where sub-skill "completion reports" and "Next steps" blocks were the single largest consumer of main-thread tokens across a multi-task run. Prior to this contract, the cumulative per-skill output grew linearly with plan size — a 20-task run carried ~7k lines of recap, re-stated artefacts, and narrative footers in the main thread. The contract plus the existing file-handoff discipline (`docs/browzer/feat-<slug>/`, `HANDOFF_NN.json`) drops that to ~100 lines.

Each `SKILL.md` links back to this section rather than repeating the contract verbatim. When you edit a skill, check that its final emission matches the shape above — if it prints more, it is broken.

---

## Configure

On install, Claude Code prompts for two optional values (defined in `.claude-plugin/plugin.json#userConfig`):

- `BROWZER_SERVER` — gateway URL. Defaults to `https://browzeremb.com`. Set to `http://localhost:8080` for local prod-parity testing.
- `BROWZER_API_KEY` — optional API key for non-interactive login (CI / agent loops).

### Agent-friendly CLI contract

Every read/run command follows the same shape:

- `--json` — machine-readable JSON on stdout
- `--save <file>` — clean JSON to a file (no banners, no ANSI). **Always preferred in agent loops**
- `--schema` — discover the response shape without running a query
- `--key <api-key>` — non-interactive login

### Exit codes

| Code  | Meaning                                 |
| ----- | --------------------------------------- |
| `0`   | Success                                 |
| `1`   | Generic / user error                    |
| `2`   | Not authenticated → run `browzer login` |
| `3`   | No Browzer project → run `browzer init` |
| `4`   | Not found (workspace / document)        |
| `10`  | CLI outdated (run `browzer upgrade`)    |
| `130` | Interrupted (SIGINT)                    |
| `143` | Terminated (SIGTERM)                    |

---

## Quality Gate (Stop hook)

The plugin ships a `Stop` event hook that fires when the model finishes a
turn, runs your project's quality gate (lint / typecheck / tests) in the
background, and surfaces the result on the next prompt via
`UserPromptSubmit` `additionalContext`. The agent never blocks on the gate —
it gets a fresh pass/fail signal every turn for free.

### What it does

1. **Stop hook** (`hooks/guards/quality-gate-stop.mjs`)
   - Resolves a gate command via the cascade described below.
   - Computes a sha256 fingerprint of the working tree
     (`git ls-files -m -o --exclude-standard -z` + per-file mtime/size + HEAD).
   - Writes a `pending` receipt under `.browzer/.gate-receipts/` and spawns a
     detached Node child that runs the gate, captures last-32-line
     stdout/stderr tails, and atomically rewrites the receipt with
     `passed | failed`, `exitCode`, and `durationMs`.
   - Returns within ~50ms so the agent loop is never delayed.
2. **UserPromptSubmit hook** (`hooks/guards/quality-gate-context.mjs`)
   - Reads the most recent valid receipt and emits a ~400-char
     `additionalContext` block on the next agent turn:
     `[browzer] quality gate passed (cmd: pnpm test) took 2.4s` or, on
     failure, the stderr tail.

### Cascade (first non-null wins)

1. **`.browzer/skills.config.json#gates.affected`** — explicit project config.
2. **`package.json#scripts["browzer:gate"]`** — runs via the detected package
   manager (lockfile probe `pnpm-lock.yaml > yarn.lock > package-lock.json >
   bun.lockb`, with `package.json#packageManager` field as override).
3. **Auto-detect** by manifest:
   - `turbo.json` → `${pm} turbo lint typecheck test --filter='...[origin/main]'`
     (or `npx turbo …` when no PM lockfile is present).
   - `package.json#scripts.test` → `${pm} test`.
   - `pyproject.toml` → `pytest && ruff check`.
   - `go.mod` → `go test ./... && go vet ./...`.
   - `Cargo.toml` → `cargo test && cargo clippy -- -D warnings`.

### Configure

`.browzer/skills.config.json` (anchored at the workspace root):

```json
{
  "version": 1,
  "gates": {
    "affected": "make ci",
    "full": "make full"
  },
  "hooks": {
    "qualityGate": {
      "enabled": true,
      "timeout": 120,
      "receipt": {
        "ttl": 300,
        "directory": ".browzer/.gate-receipts"
      }
    }
  }
}
```

Schema bounds: `version === 1`, `timeout` ∈ [0, 1800], `receipt.ttl` ∈ [60, 3600].
Invalid configs are ignored with a one-shot stderr advisory; the cascade
falls through to the next step.

### Disable

Either of:

- `BROWZER_HOOK=off` (env, per-shell escape hatch).
- `"hooks": { "qualityGate": { "enabled": false } }` in
  `.browzer/skills.config.json`.

### Receipts

- Path: `.browzer/.gate-receipts/<fingerprint-12char-prefix>.json`
- Background log file: `.browzer/.gate-receipts/<prefix>.log` — captures the
  full stdout/stderr stream of the detached gate child for post-mortem when
  the receipt's tails aren't enough.
- Bounded directory size: receipts older than 24h are pruned on every read;
  same fingerprint → same slot, so the working set stays small (~20 files).

### Verify

```bash
# Manual: trigger a Stop event in a Browzer-initialized repo and watch the
# receipt land. Dry-run mode short-circuits the spawn for tests:
echo '{}' | BROWZER_GATE_DRY_RUN=1 \
  node packages/skills/hooks/guards/quality-gate-stop.mjs
ls -la .browzer/.gate-receipts/
```

---

## Documentation

- [Website](https://browzeremb.com)
- [CLI install recipe](./cli-install.md)
- [CLI source (public mirror)](https://github.com/browzeremb/browzer-cli)
- [Releases](https://github.com/browzeremb/browzer-cli/releases)
- [Issues](https://github.com/browzeremb/browzer-cli/issues)
