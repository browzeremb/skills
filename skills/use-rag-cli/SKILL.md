---
name: use-rag-cli
description: Install, authenticate, and operate the `browzer` CLI — the hybrid vector + Graph RAG entrypoint. Wraps `browzer login` / `logout`; documents the command table, exit codes, and JSON agent contract (`--json`, `--save`, `--no-wait`, `--schema`, `--key`). Use for first-time setup, login (interactive or API key), or recovering from "exit code 2 — not authenticated". Triggers - install browzer, browzer cli, set up browzer, browzer login, browzer logout, authenticate browzer, BROWZER_API_KEY, BROWZER_SERVER, browzer device flow, exit code 2, rag cli, hybrid rag setup.
---

# use-rag-cli — install + authenticate the browzer CLI

The `browzer` CLI is the single client surface for Browzer's hybrid vector + Graph RAG platform. Every other Browzer skill in this plugin assumes this CLI is installed and authenticated.

## Quick start

```bash
# 1. Install (single static Go binary — pick ONE channel). Full matrix in `cli-install.md`.
curl -fsSL https://browzeremb.com/install.sh | sh
# brew install browzeremb/tap/browzer                # Homebrew
# scoop install browzer                              # Windows (after `scoop bucket add browzeremb https://github.com/browzeremb/scoop-bucket`)
# go install github.com/browzeremb/browzer-cli/cmd/browzer@latest   # any Go ≥ 1.25

# 2. Authenticate (interactive device flow)
browzer login

# 2b. Or non-interactive (CI / agents) — export first so the flag expands the same value
export BROWZER_API_KEY=brz_xxx
browzer login --key "$BROWZER_API_KEY"

# 3. Verify
browzer status --json
```

`BROWZER_SERVER` overrides the default server (e.g. `BROWZER_SERVER=http://localhost:8080 browzer login` for the local prod-parity gateway).

**Why `--json` / `--save` everywhere:** Browzer commands print human-formatted output by default. Agents must always use `--json` (single JSON document on stdout) or `--save <file>` (clean JSON to a file, no banners or ANSI). Parsing the human format is brittle and wastes context.

## Master command table

| Command                                                                   | Purpose                                                             | Skill                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| `browzer login [--key <key>]`                                             | Device-flow or API-key auth                                         | this skill                 |
| `browzer logout`                                                          | Drop stored credentials                                             | this skill                 |
| `browzer status [--json] [--save <file>]`                                 | Show auth + workspace context                                       | `auth-status`              |
| `browzer init [--json] [--save <file>] [--dry-run] [--name <name>]`       | Create workspace on server + write `.browzer/config.json` (only)    | `embed-workspace-graphs`   |
| `browzer workspace index [--force] [--dry-run] [--json] [--save <file>]`  | Walk tree, regex-parse folders/files/symbols into the graph (cheap) | `embed-workspace-graphs`   |
| `browzer workspace docs`                                                  | Interactive TUI picker (+ `--add/--remove/--replace/--plan`) for markdown/PDF/text docs | `embed-documents` |
| `browzer workspace sync` (alias: `browzer sync`) `[--force]`              | Non-interactive: re-index code THEN reconcile existing docs (no new adds). `--skip-code`, `--skip-docs`, `--dry-run` | `sync-workspace`          |
| `browzer workspace unlink`                                                | Remove local `.browzer/config.json` (server workspace stays)        | `workspace-management`     |
| `browzer workspace relink <id>`                                           | Repoint local `.browzer/config.json` at an existing workspace       | `workspace-management`     |
| `browzer workspace {list,get,delete}`                                     | List / inspect / destructively delete workspaces                    | `workspace-management`     |
| `browzer explore [query] [--limit N] [--json] [--save <file>] [--schema]` | Hybrid vector + graph search over the **code** graph                | `explore-workspace-graphs` |
| `browzer deps <path> [--reverse] [--limit N] [--json] [--save <file>] [--schema]` | Per-file dependency graph — forward imports + `importedBy` (blast radius) | `dependency-graph` |
| `browzer search <query> [--limit N] [--json] [--save <file>] [--schema] [--workspaces <ids>] [--all-workspaces]` | Semantic search over indexed **markdown docs**; supports cross-workspace fan-out | `semantic-search` |
| `browzer ask <question> [--workspace <id>] [--json] [--save <file>]`      | End-to-end RAG Q&A over the workspace (uses the answer cache; 3-tier workspace fallback) | no dedicated skill — run directly; pair with `explore-workspace-graphs` or `semantic-search` if you need the raw hits |
| `browzer upgrade [--check] [--json] [--save]`                             | Check if a newer CLI is available and show the right upgrade command | this skill                 |
| `browzer job get <batchId> [--json]`                                      | Inspect async ingestion batch status returned by `sync --no-wait`   | `ingestion-jobs`           |

## Agent-friendly conventions

Every read/search command supports the same JSON contract:

- `--json` → stdout becomes a single JSON document.
- `--save <file>` → writes clean JSON to `<file>` (implies `--json`); avoids any banner pollution from progress messages. **Always prefer `--save` in agent loops.**
- `--schema` (on `explore`, `search`, `deps`, `mentions`, `ask`, `status`, `init`, `upgrade`) → prints the JSON schema of the response without running a query — discover shape zero-shot. Inspect the schema first; the top-level key differs per verb (`explore`/`search` → `{ entries: [...] }`; `mentions` → `{ path, workspaceId, meta, mentions: [...] }`; `deps` → `{ path, exports, imports, importedBy }`).
- `--key <key>` (on `login`) → non-interactive login from `$BROWZER_API_KEY`.
- `--llm` (persistent) or `BROWZER_LLM=1` → strips banner + ANSI + spinners. Pays off in commands that ship a TUI or progress reporter (`sync`, `workspace docs`, `init`, `login`, `upgrade`); read/search commands are already silent under `--json --save`, so the flag is mostly a no-op there. Use it whenever a skill dispatcher pipes stdout to a parser AND the underlying verb has progress UI.
- `--ultra` → ultra-compact human-readable output. **Avoid in agent loops** — empirically truncates score fields for `explore`/`search` to `0.000`, breaking any consumer that ranks results. Use `--json --save` instead.
- `--quiet` (per command) → suppresses info-level stderr (errors still print). Accepted as a no-op when the verb has nothing to silence. Worth setting when piping stderr into a tracer.

## Exit codes

| Code  | Meaning                                                                          | Where it can appear                                              |
| ----- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `0`   | Success                                                                          | every command                                                    |
| `1`   | Generic / user error                                                             | every command                                                    |
| `2`   | Not authenticated → run `browzer login`                                          | any command needing auth                                         |
| `3`   | No Browzer project in current directory → run `browzer init`                     | any workspace-bound command                                      |
| `4`   | Not found (workspace / document / batchId)                                       | `workspace get/delete`, `job get`, `codereview aggregate`        |
| `7`   | Partial ingestion failure — some docs failed; at least one succeeded             | `sync`, `workspace docs --add`                                   |
| `8`   | Total ingestion failure — all docs failed                                        | `sync`, `workspace docs --add`                                   |
| `10`  | CLI outdated (run `browzer upgrade`)                                             | **only** `browzer upgrade --check`                               |
| `130` | Interrupted (SIGINT)                                                             | long-running commands (`sync`, `workspace docs --interactive`)   |
| `143` | Terminated (SIGTERM)                                                             | same                                                             |

## Common failures

- **`exit 2` after a fresh install** → device-flow login wasn't completed; re-run `browzer login` and approve in the browser.
- **`exit 2` mid-session** → API key rotated or server URL changed; re-run `browzer login --key "$BROWZER_API_KEY"`.
- **`browzer: command not found` after install** → the install dir is not on `$PATH`. `curl|sh` drops the binary in `~/.local/bin` (POSIX) or `~/bin`; `go install` uses `$(go env GOPATH)/bin`. Add the right one to `$PATH` and re-open the shell.
- **`refusing cloud metadata IP` / `refusing private/link-local host` on `browzer login --server …`** → SSRF guard. Pass a public host or a documented loopback (`http://localhost:8080`, `http://127.0.0.1:*`, `http://[::1]:*`). `BROWZER_ALLOW_INSECURE=1` only relaxes http→public, NOT the SSRF block.

## Tips

- The CLI honors `BROWZER_HOME` for credential isolation — useful when multiple agents run in parallel.
- A failed `browzer init` can leave a server-side workspace with no local config. Recovery: `browzer workspace list --json` → `browzer workspace relink <id>` (keep it) or `browzer workspace delete <id>` (drop it) — see `workspace-management`.
## Output contract

Emit ONE line per sub-command:

- **After install:** `use-rag-cli: installed browzer <version> (path: <bin-path>)`
- **After `login` — device flow:** `use-rag-cli: authenticated as <email> on <server>` (append ` (workspace <name>)` only if a workspace is already bound to the current directory)
- **After `login --key` — non-interactive:** `use-rag-cli: authenticated via api-key on <server>`
- **After `logout`:** `use-rag-cli: logged out; credentials cleared`
- **After `upgrade`:** `use-rag-cli: upgraded browzer <old> → <new>` or `use-rag-cli: already on latest (<version>)`
- **Failure (install error, device-flow timeout, SSRF-block, 401 on key, etc.):** two lines per the failure contract.

Never echo the API key, OAuth tokens, or any secret in the confirmation line — trim or omit entirely.
