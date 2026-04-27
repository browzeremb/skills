---
name: workspace-management
description: List, inspect, delete, unlink, and relink Browzer workspaces in the caller's organization, and discover the JSON schema of a workspace zero-shot via `browzer workspace get --save`. Use to audit which Browzer workspaces exist, recover from an orphan workspace after a failed `browzer init`, free a plan slot, repoint `.browzer/config.json` at an existing workspace, or clean up stale Browzer indexes. Wraps `browzer workspace list/get/delete/unlink/relink`. Triggers - browzer, browzer workspace, browzer workspace list, browzer workspace get, browzer workspace delete, browzer workspace unlink, browzer workspace relink, list browzer workspaces, delete browzer workspace, browzer orphan workspace, browzer workspace schema, "which browzer workspaces", "what's indexed in browzer", browzer organization workspaces, browzer multi-tenant rag, browzer workspace audit, browzer workspace cleanup, free plan slot, repoint browzer config.
argument-hint: "[list|get|delete|unlink|relink] [<workspace-id>]"
allowed-tools: Bash(browzer *), Read
---

# workspace-management — list / get / delete Browzer workspaces

`browzer workspace` is the management surface for Browzer's per-workspace indexes. Use it to discover what exists, fetch the schema of a workspace zero-shot, and clean up orphans.

## Quick start

```bash
browzer status --json                                       # active workspace + auth
browzer workspace list --json --save /tmp/ws.json           # all workspaces in org
browzer workspace list --filter rag --json                  # case-insensitive substring on name OR id
browzer workspace get <id> --save /tmp/w.json               # single workspace (also: schema discovery) — no --json flag
browzer workspace delete <id> --confirm-name <name>          # destructive — confirm with user first; --confirm-name required in non-interactive shells
browzer workspace unlink                                     # drop local .browzer/config.json (server workspace UNCHANGED)
browzer workspace relink <id>                                # repoint local config at an existing workspace
```

## Unlink vs delete (free a plan slot)

`browzer workspace unlink` only removes the **local** `.browzer/config.json`. The workspace still exists server-side and **still consumes 1 slot of the user's plan**. Warn the user about this explicitly whenever they ask to "remove" or "unbind" a workspace — they almost always want `delete` if the goal is to free a slot.

```bash
browzer workspace unlink         # local-only; does NOT free plan slot
browzer workspace delete <id>    # server-side destroy; frees the slot
```

`relink <id>` is the inverse of `unlink`: it rewrites (or creates) `.browzer/config.json` with an existing workspace id, without creating anything on the server and without indexing anything. Use it after `unlink`, after cloning a repo that has no local config, or when recovering from a failed `browzer init` where the server workspace was created but the local config wasn't written.

## Checking plan usage

`GET /api/billing/usage` returns the caller's current plan slots, storage bytes, and chunk budget. `browzer status` already prints a one-line summary (`Plan: <plan> — workspaces <used>/<limit>`); for the full breakdown (storage + chunks) read the live footer inside `browzer workspace docs` (see `embed-documents`), which shows `storage_used / storage_limit` and `chunks_used / chunks_limit` in real time, or hit the endpoint directly.

**Why `browzer workspace delete` requires confirmation:** it removes the workspace, all documents, embeddings, and graph nodes. There is no undo. Always show the workspace details and ask the user before invoking it.

## Schema discovery (zero-shot)

```bash
# Discover the workspace shape without writing any code
browzer workspace get <id> --save /tmp/w.json   # --json flag does NOT exist on get; always emits JSON
Read /tmp/w.json
```

This is the agent-friendly equivalent of `infsh app get --json`: it lets you reason about the workspace fields without reading server source.

## Flag reference

| Subcommand                                                               | Purpose                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `browzer workspace list [--filter <substring>] [--json] [--save <file>]` | List all workspaces in the caller's organization (filter is a case-insensitive substring on name OR id) |
| `browzer workspace get <id> [--save <file>]`                             | Fetch one workspace by id — always emits JSON, no `--json` flag (schema discovery)                      |
| `browzer workspace delete <id> [--confirm-name <name>]`                  | **Destructive.** Removes workspace + all data (frees plan slot). `--confirm-name` required in non-interactive shells (guard hook) |
| `browzer workspace unlink`                                               | Remove local `.browzer/config.json` only. Server workspace stays (does NOT free the plan slot)          |
| `browzer workspace relink <id>`                                          | Rewrite `.browzer/config.json` to point at an existing workspace (no create, no index)                  |

## Common failures

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 4` on `get`/`delete`** → workspace id doesn't exist or belongs to a different org; verify with `list`.
- **`list` returns empty** → user is authenticated but has no workspaces; run `embed-workspace-graphs` (`browzer init`).
- **Orphan workspace after a failed init** → list, find the orphan id (no local `.browzer/config.json` matches it), then `relink` to keep it or `delete` to drop it.

## Tips

- Workspace ids are stable; the local `.browzer/config.json` just stores the id.
- For org-wide auth context use `auth-status`.
- This skill is read-mostly; the only mutation is `delete`, which is always destructive.

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `auth-status` — pre-flight context probe.
- `embed-workspace-graphs` — create a workspace via `browzer init` + index structure via `browzer workspace index`.
- `embed-documents` — interactive doc picker; shows live quota numbers from the same `/api/billing/usage` endpoint.
- `explore-workspace-graphs` — search the code graph of a workspace listed here.
- `semantic-search` — search the markdown corpus of a workspace listed here.

## Output contract

Emit ONE line per sub-command:

- **`list`:** `workspace-management: <N> workspaces in organization (active: <name>)` — or `workspace-management: <N> workspaces in organization (no active binding in cwd)`
- **`get <id>`:** `workspace-management: workspace <name> (<id>) — <chunks-used>/<chunks-limit> chunks, plan <plan>`
- **`delete <id>`:** `workspace-management: deleted workspace <name> (<id>); plan slot freed`
- **`unlink`:** `workspace-management: unlinked .browzer/config.json from workspace <id>; ⚠ server workspace unchanged (still consuming 1 slot — use delete to free it)`
- **`relink <id>`:** `workspace-management: .browzer/config.json repointed at workspace <name> (<id>)`
- **Failures (auth, 404, 403, etc.):** two lines per the failure contract.

Never paste the full workspace JSON in chat — cite `/tmp/ws.json` or `/tmp/w.json` if the operator needs to inspect.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
