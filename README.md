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

### Workflow — tier-aware markdown chains

The workflow skills persist their artefacts to plain `.md` files under `docs/browzer/feat-<date>-<slug>/staging/` — six per-phase subfolders (`planning/`, `tasks/`, `review/`, `review-lanes/`, `fixes/`, `acceptance/`), gitignored. Each phase skill writes its output via the `Write` tool; the next phase reads it via `Read`. The single committed artefact is `docs/browzer/<feat>/README.md` (written by `finalize-feature`). State is filesystem-driven; the orchestrator picks the next phase by inspecting which files exist.

A haiku probe at orchestrator Step 0.5 picks `tier ∈ {express, standard, full}` once per feat (persisted to `CONFIG.tier`). Express skips PRD/scope/task-plan entirely (orchestrator inline-writes a `## PRD-compact` heading into BRIEF.md and a single `tasks/TASK_01.md`). Standard runs the planning phases with compact templates and caps. Full runs the planning phases at full depth.

| Skill                            | Wraps                                         | Use it for                                                                 |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| [generate-prd](skills/generate-prd/)         | `browzer explore`/`deps`/`search`             | PRD grounded in real repo context; writes `planning/PRD.md`. Skipped at `tier=express`. Standard uses a compact template (3 required + 1 optional section, 200–400 lines); full uses the full template (3 required + 5 optional, 800–1000 lines). |
| [scope-feature](skills/scope-feature/)       | `browzer explore`/`deps`/`search` + find-skills | Translates PRD into concrete repo coordinates. Writes `planning/EXPLORATION.md` (strict intermediate consumed ONLY by `generate-task`). Skipped at `tier=express` (orchestrator runs `browzer deps --reverse` + find-skills inline). |
| [generate-task](skills/generate-task/)       | `browzer explore`/`deps`/`search`             | Decomposes PRD + EXPLORATION into per-task closed-prompt `tasks/TASK_NN.md` files. Skipped at `tier=express`. Standard caps at 5 tasks. |
| [execute-task](skills/execute-task/) | `browzer explore`/`deps`/`search` + `browzer:coder` subagent | Implements one TASK_NN.md AND writes the inline tests (one per `testSpecs[]`) in the same change. **Hard-fail host quality gate** (`lint + typecheck + test`; + `build` at `tier=full` when public API drifted) runs BEFORE the atomic rename to `.completed.md`. Up to 2 retries before giving up. |
| [commit](skills/commit/)   | `git`, `gh`, `glab`                           | Conventional Commits only. Veto-gated: ACCEPTANCE.md.verdict must be `accepted` AND README.md must exist before the commit lands. |

### Quality (always part of the pipeline)

| Skill                                                                | Wraps                                                       | Use it for                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| [brainstorming](skills/brainstorming/)                               | `browzer explore`/`search` + parallel research subagents    | Step 0 — converge on intent before any PRD. Asks one question at a time until a convergence checklist is fully resolved; dispatches up to 3 parallel research agents (WebFetch / WebSearch / MCPs) for doubts neither operator nor agent can answer. |
| [code-review](skills/code-review/)                                   | parallel agents + aggregator                                | 4 mandatory Opus lanes — senior-engineer (cyclomatic + DRY + clean code), software-architect (race conditions + clean architecture + caching + perf), qa (regressions + edge cases + butterfly-effect), regression-tester (baseline-failure detection against `main` via git-stash) — plus a cheap haiku `pr-coherence` lane (AC-contract shape check) and N dynamic specialists from `/find-skills`. The regression-tester is non-collapsible — it is the only lane producing empirical evidence. Mutation testing is **not** part of any lane (removed from the workflow entirely per Lever C). Read-only — `receiving-code-review` applies fixes next. |
| [receiving-code-review](skills/receiving-code-review/)               | per-finding fix-agent dispatch + aggregator                 | Closes EVERY code-review finding (high → low) with a 7-step ladder: sonnet → sonnet retry → research-then-sonnet → opus → opus retry → research-then-opus → log to tech-debt. Zero-tech-debt by default. Haiku is forbidden for fix dispatch. Single-writer aggregator (`aggregate-fixes.mjs`) runs once after all fixers land — writes `fixes/FIXES.md` and in-place patches `review/CODE_REVIEW.md.findings[].fixStatus`. |
| [regression-guard](skills/regression-guard/)                         | the host quality gate (lint+typecheck+test+build?)          | Re-runs the host quality gate over the **aggregate post-fix diff**. Failures emit synthetic HIGH findings into `review/CODE_REVIEW.md` and loop back through the fix ladder. Max 3 rounds total (initial + 2 reruns) before HALT. State-machine bypass when `fixes/` is empty. Runs identically across all tiers. |
| [feature-acceptance](skills/feature-acceptance/)                     | capability probe + AskUserQuestion mode picker + scoped tests / Agent inspection / live-verify probes | Verifies every PRD `acceptanceCriteria[]`, `nonFunctionalRequirements[]`, and `successMetrics[]`. Mode picked per tier: `express → smoke` (verify ACs touched in diff; no stack boot), `standard → hybrid` (boot only apps with TASK-touched files), `full → autonomous-with-stack-boot` when capabilities permit. Un-runnable items are routed to `operatorActionsRequested[]` with concrete copy-pasteable steps. Operator override `--override-gate` records `gateOverride` in ACCEPTANCE.md when accepting a failing regression-guard verdict. |
| [finalize-feature](skills/finalize-feature/)                         | inline browzer discovery + `render-readme.mjs`              | Phase A: patches host markdown docs whose accuracy depends on the feature's exported-symbol surface (smart-skip when no exported-symbol drift). Phase B: renders the self-contained committed `docs/browzer/<feat>/README.md` summary. |

### Orchestration (meta)

| Skill                                          | Wraps                                   | Use it for                                                                 |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| [orchestrate-task-delivery](skills/orchestrate-task-delivery/) | the full pipeline | Master router — drives `brainstorming?` → `probe-tier` → `generate-prd?` → `scope-feature?` → `generate-task?` → (per task: `execute-task` with inline tests + hard-fail gate) → `code-review` → `receiving-code-review` → `regression-guard` → `feature-acceptance` → `finalize-feature` → `commit` end-to-end. Phases marked `?` are skipped or inline-written when `tier=express`. Use for any non-trivial task, idea-to-ship flows, mid-flow entries (`execute-task TASK_03`, `commit what's staged`), or when a request spans code + docs + ops. |

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
finalize-feature: 4 docs patched, README.md written for feat-20260422-user-auth-flow
commit: 3f2e1a0 fix(api/auth): close TOCTOU in session refresh
commit: 3f2e1a0 chore(feat-20260422): land feature with verdict=accepted
```

The `inlined` marker on `execute-task` is used when zero subagents were dispatched and the task met the <15-line integration-glue cap — see `skills/execute-task/SKILL.md` §Trivial fast-path for the guidance. The `qualityGate` line carried into `tasks/TASK_NN.completed.md` frontmatter records the host-detected gate verdict (lint / typecheck / test / build?) per Lever C.

Shape rules:

- Start with the skill's own name (not "I wrote…", not "Here's…"). The name is the machine-readable key downstream skills grep for.
- Past-tense verb for what happened (`wrote`, `patched`, `ok`, `re-indexed`, `failed`). Present tense reads like narration; past tense reads like a log line.
- Then the path (where the artefact lives) or the identifier (`TASK_03`, the commit SHA). Something the operator can act on.
- Then one compact metric in parentheses — line count, file count, gates status. Enough to know whether to look further.

### Warnings append with `;`

Non-fatal warnings (staleness gates, degraded indexes, budget truncation, worktree isolation skipped by assertion) append to the confirmation line after a `;` separator. No multi-paragraph warning blocks, no reprinting the full warning that the CLI already emitted to stderr.

```
generate-prd: wrote docs/browzer/feat-.../PRD.md (186 lines); ⚠ index 23 commits behind HEAD
finalize-feature: 3 docs patched, README.md written for feat-20260422-user-auth-flow; ⚠ Phase A discovery budget exhausted at 60s, 2 candidate docs unverified
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
regression-guard: failed — gate=test exited non-zero on round 3 (max rounds reached, no operator override)
hint: inspect `staging/review/GATE_REPORT.md` for the failing command's output; either fix manually and re-invoke `/orchestrate-task-delivery <feat>`, or pass `--override-gate` to `/feature-acceptance <feat>` to record gateOverride and accept the regression
```

No stack traces. No "I tried X then Y then Z" narrative. No menu of five alternatives — one hint.

### Machine-readable reports

Most skills emit their structured state directly into the matching `staging/` subfolder (e.g. `staging/tasks/TASK_NN.completed.md`, `staging/review/CODE_REVIEW.md`, `staging/fixes/FIXES.md`, `staging/acceptance/ACCEPTANCE.md`, `staging/review/GATE_REPORT.md`). Downstream phases consume those via the `Read` tool — there is no `workflow.json` and no separate `.meta/<NAME>.json` audit file. The confirmation line names the artefact path; callers open the file when they need to decide something.

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

## Documentation

- [Website](https://browzeremb.com)
- [CLI install recipe](./cli-install.md)
- [CLI source (public mirror)](https://github.com/browzeremb/browzer-cli)
- [Releases](https://github.com/browzeremb/browzer-cli/releases)
- [Issues](https://github.com/browzeremb/browzer-cli/issues)
