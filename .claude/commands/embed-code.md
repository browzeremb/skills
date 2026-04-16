---
name: embed-workspace-graphs
description: Index a codebase's *structure* (folders, files, symbols) into Browzer's workspace graph via `browzer init` and `browzer workspace index`. This is the cheap, regex-based structural parser — no embeddings, no documents, no markdown, no PDFs. Use when onboarding a new repo (`browzer init` creates the workspace + config; `browzer workspace index` walks the tree and populates the graph), after meaningful structural changes (new modules, large refactors, file moves), or as a CI hook to keep the graph in sync. For indexing markdown/PDF/text documents (the embedding-heavy path) use the sister skill `embed-documents` instead. Triggers - browzer, browzer init, browzer workspace index, index code structure, embed workspace graph, index codebase, graph rag setup, register workspace, onboard repo, refresh code graph, CI index hook, "index this repo", "set up browzer here", structural parser, folders files symbols.
allowed-tools: Bash(browzer *), Read
---

# embed-workspace-graphs — index code structure into the workspace graph

This skill indexes a repository's **structure** — folders, files, and symbols — into Browzer's workspace graph. It is backed by a cheap server-side regex parser: no embeddings, no chunking, no LLM calls. Fast enough to run on every push.

**Structure only — for markdown/PDF/text documents use `embed-documents` (the only path that produces doc embeddings).**

## Quick start

```bash
# 0. Authenticated?
browzer status --json

# 1. Create the workspace on the server + write .browzer/config.json
browzer init

# 2. Walk the tree and populate the graph (folders/files/symbols)
browzer workspace index

# Force re-parse even with pending ingestion jobs:
browzer workspace index --force

# 3. Verify
browzer status --json
```

`browzer init` is now scoped to **workspace creation + local config only** — it does NOT walk the repo, parse anything, or upload docs. After `init`, the CLI prints a hint pointing at `browzer workspace index` (structure) and `browzer workspace docs` (documents). Run them in whichever order makes sense for the project.

## Parse gates

Re-running `browzer workspace index` (or `browzer workspace sync`) is subject to three server- and CLI-side gates. Knowing which one fired tells you whether `--force` is safe.

- **Fingerprint** — if the parse tree is byte-identical to the last successful parse, the server short-circuits with `{status: "unchanged"}` and the CLI prints `No changes detected — skipped re-parse`. No writes happen, no quota consumed. `--force` has no effect here; it's already a no-op.
- **Cooldown (30s)** — if you re-parse within 30 seconds of the last parse, the server returns HTTP 429 `parse_cooldown` with a `Retry-After` header. Wait the indicated seconds or re-run with `--force`. This is a rate-limit only — `--force` is safe.
- **Jobs-in-flight preflight** — if there are pending BullMQ ingestion jobs on this workspace, the CLI aborts with exit 1 and prints `N ingestion job(s) still in flight ... Re-run with --force to bypass.` Use `--force` only if you're sure the pending jobs won't race the re-parse (e.g. they target different files). When in doubt, poll via `browzer job get <batchId>` until they drain — see the `ingestion-jobs` skill.

## What this skill does (and doesn't)

- **Does**: `browzer init` (register workspace + config), `browzer workspace index` (walk + regex-parse folders/files/symbols into the graph).
- **Does NOT**: embed documents, upload markdown/PDF, generate chunks, or consume your per-plan chunk quota. All of that lives in `embed-documents`.

The structural index is what powers `explore-workspace-graphs` (code navigation, callers/callees, symbol lookup). Re-run `browzer workspace index` after any change that meaningfully shifts the file/symbol shape of the repo — a new package, a big refactor, a rename sweep. Day-to-day edits usually don't need it.

## When to run

- **Onboarding**: `browzer init` once, then `browzer workspace index` once.
- **Structural changes**: after adding/removing modules, moving large file trees, or splitting a monolith.
- **CI hook**: safe to run on every merge to main — no embeddings means no cost and no rate-limit risk.

## Recovery: orphan workspace after a failed init

`browzer init` only touches the server and `.browzer/config.json`; there is no partial ingestion state to clean up. If something goes wrong mid-command (network flap, interrupted), the worst case is a server-side workspace with no local config. Recover with:

```bash
browzer workspace list --json --save /tmp/ws.json   # find the orphan id
browzer workspace relink <id>                        # repoint local config at it
# or
browzer workspace delete <id>                        # destroy server-side (frees plan slot)
```

See `workspace-management` for the full unlink/relink/delete trio.

## Common failures

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 3` on `browzer workspace index`** → no `.browzer/config.json` in current directory; run `browzer init` first, or `browzer workspace relink <id>`.
- **`exit 4`** → the workspace id in `.browzer/config.json` no longer exists server-side (deleted elsewhere); re-init or relink to a valid id.
- **`exit 1` "ingestion jobs still in flight"** → pending BullMQ jobs block the re-parse. Wait for them to drain (poll via `browzer job get <batchId>`) or re-run with `--force` if you're sure the pending jobs won't race.
- **HTTP 429 `parse_cooldown`** → 30s server-side cooldown since the last parse. Wait `Retry-After` seconds or re-run with `--force`.

## Tips

- Sensitive files (`.env`, `*.key`, credentials) and symlinks are dropped by the shared sensitive-filter **before** any disk read.
- The walker honors `.gitignore` and has a max depth of 32.
- Safe to re-run — `workspace index` is idempotent on unchanged structure.

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `auth-status` — pre-flight context probe.
- `embed-documents` — the ONLY path that indexes markdown/PDF/text docs (embedding-heavy).
- `explore-workspace-graphs` — search the code graph this skill produces.
- `workspace-management` — list / relink / unlink / delete workspaces.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
