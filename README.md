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

After install, skills are available as `/browzer:explore-workspace-graphs`, `/browzer:semantic-search`, `/browzer:prd`, etc.

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

### Workflow (`prd → task → execute → commit → sync`)

The workflow skills persist their artefacts to `docs/browzer/feat-<date>-<slug>/` inside the target repo — `PRD.md` from `prd`, `TASK_NN.md` siblings from `task`, plus `.meta/activation-receipt.json` (and `HANDOFF_NN.json` when `task-orchestrator` dispatches subagents). Downstream skills consume by **path**, not by scanning chat history — so a 20-task plan keeps the main thread's working set O(1).

| Skill                      | Wraps                                         | Use it for                                                                 |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| [prd](skills/prd/)         | `browzer explore`/`deps`/`search`             | Step 1 — PRD grounded in real repo context; writes `docs/browzer/feat-<date>-<slug>/PRD.md` |
| [task](skills/task/)       | `browzer explore`/`deps`/`search`             | Step 2 — decompose PRD into PR-sized tasks; writes `TASK_NN.md` siblings next to the PRD |
| [execute](skills/execute/) | `browzer explore`/`deps`/`search` + subagents | Step 3 — implement one task end-to-end; reads spec from `docs/browzer/feat-<date>-<slug>/TASK_NN.md` |
| [commit](skills/commit/)   | `git`, `gh`, `glab`                           | Step 4 — Conventional Commits + doc-sync                                   |
| [sync](skills/sync/)       | `browzer workspace sync`                      | Step 5 — re-index code + reconcile docs                                    |

### Orchestration (meta)

| Skill                                          | Wraps                                   | Use it for                                                                 |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| [task-orchestrator](skills/task-orchestrator/) | the five workflow skills above          | Master router — loads domain specialists first, then drives `prd → task → execute → commit → sync` end-to-end. Use for any non-trivial task, PRD-to-ship flows, mid-flow entries (`execute TASK_03`, `commit what's staged`), or when a request spans code + docs + ops. |

### Ops + tools

| Skill                                                      | Wraps                                               | Use it for                                  |
| ---------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| [use-rag-cli](skills/use-rag-cli/)                         | `browzer login/logout/upgrade`                      | Install + auth (anchor skill)               |
| [give-claude-rag-steroids](skills/give-claude-rag-steroids/) | `browzer init`/`index`/`docs` + subagents           | One-shot end-to-end RAG onboarding per repo |
| [auth-status](skills/auth-status/)                         | `browzer status --json`                             | Pre-flight context probe                    |
| [workspace-management](skills/workspace-management/)       | `browzer workspace {list,get,delete,unlink,relink}` | Multi-tenant workspace management           |

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
