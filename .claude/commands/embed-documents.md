---
name: embed-documents
description: "Add, remove, replace, or audit the markdown/PDF/text documents of a Browzer workspace via `browzer workspace docs`. Supports an interactive TUI picker (humans) AND a full non-interactive flag surface (SKILLs / CI / agents): `--add <spec>`, `--remove <spec>`, `--replace <spec>`, `--plan --json`, `--yes`, `--dry-run`. Spec syntax: sentinels (`new`/`all`/`none`), `@file` path lists, globs (`docs/*.md`), or comma-separated paths. This is the ONLY way to ingest documentation into Browzer; live plan + storage + chunk quota is enforced server-side before any upload. Use when the user wants to add docs, refresh stale doc embeddings, audit what's indexed, free up quota, or curate the doc surface `semantic-search` exposes. Triggers: browzer workspace docs, embed docs, index documentation, refresh doc embeddings, curate docs, doc quota, free chunk quota, 'add the README', 'index these docs', 'show me what docs are indexed'."
argument-hint: "[add|remove|replace|audit] [<path-or-glob>]"
allowed-tools: Bash(browzer *), Read
---

# embed-documents — add, remove, replace, or audit workspace docs

`browzer workspace docs` is the single entrypoint for indexing markdown, PDF, and text documents into a Browzer workspace. Documents can live at the workspace level (`workspaceId` set) or at the org level (`workspaceId = null`). For org-level docs, use `/api/documents?scope=org` or `browzer org docs list`. It supports two modes:

- **Interactive** (default, when stdin is a TTY) — opens a `huh` multi-select picker where already-indexed items come pre-checked.
- **Non-interactive** — driven entirely by flags. The four mutation modes (`--add`, `--remove`, `--replace`, `--plan`) let SKILLs / CI / agents run the same delta machinery without any TUI.

**Docs only — for folders/files/symbols use `embed-workspace-graphs` instead.**

## Quick start

```bash
# 0. Authenticated + workspace bound?
browzer status --json

# 1a. Human workflow: open the interactive picker
browzer workspace docs

# 1b. Agent workflow: add two specific docs
browzer workspace docs --add docs/intro.md,docs/api.md --yes

# 1c. Agent workflow: remove one doc
browzer workspace docs --remove docs/old.md --yes

# 1d. Agent workflow: audit what's currently indexed (read-only)
browzer workspace docs --plan --json

# 2. Verify afterwards with a quick search
browzer search "anything from the freshly-indexed docs" --json --save /tmp/d.json
```

## Command recipes for common user prompts

| User prompt                          | Command                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| "Add docs/a.md and docs/b.md"        | `browzer workspace docs --add docs/a.md,docs/b.md --yes`                                    |
| "Remove docs/old.md"                 | `browzer workspace docs --remove docs/old.md --yes`                                         |
| "Index all new docs"                 | `browzer workspace docs --add new --yes`                                                    |
| "Replace with just this one doc"    | `browzer workspace docs --replace docs/new.md --i-know-what-im-doing --yes`                 |
| "Show me what's indexed"             | `browzer workspace docs --plan --json`                                                      |
| "Clear all docs from workspace"      | `browzer workspace docs --replace none --i-know-what-im-doing --yes`                        |
| "Add every markdown under docs/"     | `browzer workspace docs --add 'docs/*.md' --yes`                                            |
| "Add the paths in paths.txt"         | `browzer workspace docs --add @paths.txt --yes`                                             |

## Spec syntax (`--add`, `--remove`, `--replace`)

Checked in order:

1. **Sentinel** (exact string) — `new` (for `--add` only; means "all not-yet-indexed local docs"), `all` (for `--replace` only; every local file), `none` (for `--replace` only; empty set = delete everything).
2. **`@file`** — read paths from the file, one per line. Lines starting with `#` and blank lines are ignored.
3. **Glob** — contains `*`, `?`, or `[`. Uses Go stdlib `filepath.Match`. **`**` is NOT supported** — use comma lists for multi-level matches.
4. **Comma list** — fall-through. Whitespace around entries is trimmed.

## Safety

Any destructive operation is protected by two gates:

- **`--yes`** is required for any mutation submitted from a non-TTY shell (CI, Claude Code, subprocess). Without it, the command refuses before touching the server.
- **`--i-know-what-im-doing`** is required when the computed delta would delete **5 or more** indexed documents. Without it, the command prints the list of paths that would be deleted and refuses. This is how we keep an over-eager agent from wiping a workspace with a single typo in `--replace`.

**When to pause and ask the human**: any `--remove` or `--replace` that would delete 5 or more docs MUST be confirmed by the user in the conversation before you re-run with `--i-know-what-im-doing`. Paste the refusal output (including the deleted-path list) back to the user and wait for explicit approval.

## Idempotency

- `--add docs/foo.md` when `docs/foo.md` is already indexed with the same content hash is a **no-op**. It shows up in the `skipped` list in the JSON output with `reason: "already indexed, hash unchanged"`.
- Safe to run `--add` in loops — the cache + server-side hash comparison deduplicate.
- `--remove docs/gone.md` when the path is not currently indexed produces a stderr warning and exits 0 (not an error). Safe to chain.

## Non-interactive contract (JSON shapes)

### `--plan --json` — read-only payload

```json
{
  "items": [
    {
      "path": "docs/intro.md",
      "indexed": true,
      "localHash": "abc123",
      "localSize": 4096,
      "serverDocumentId": "doc-uuid",
      "serverChunks": 12,
      "serverBytes": 4096,
      "status": "completed"
    }
  ],
  "quota": {
    "plan": "free",
    "storage": {"used": 123456, "limit": 52428800},
    "chunks": {"used": 12, "limit": 100},
    "workspaces": {"used": 1, "limit": 1}
  }
}
```

> **Note**: the server response includes a `sourceHash` field per document but the current CLI release does not decode it into the `--plan` output. A future CLI release will surface it as `serverSourceHash` — until then, compare `localHash` against the server state via `browzer workspace docs --plan --json` output changes across runs, not against a single `serverSourceHash` field.

### `--add` / `--remove` / `--replace` submit payload

```json
{
  "inserted":   [{"path": "docs/new.md"}],
  "reuploaded": [{"path": "docs/modified.md", "documentId": "doc-uuid", "chunks": 5}],
  "deleted":    [{"path": "docs/old.md", "documentId": "doc-uuid"}],
  "skipped":    [{"path": "docs/same.md", "reason": "already indexed, hash unchanged"}],
  "quotaAfter": {
    "plan": "free",
    "storage": {"used": 126000, "limit": 52428800},
    "chunks": {"used": 15, "limit": 100},
    "workspaces": {"used": 1, "limit": 1}
  }
}
```

All four lists (`inserted`, `reuploaded`, `deleted`, `skipped`) are ALWAYS present as arrays — they are `[]` when empty, never `null`. `.inserted | length` in jq is always safe.

Pair with `--save <path>` to write the payload to a file instead of stdout (stdout stays silent, perfect for scripted post-processing).

## What this skill does (and doesn't)

- **Does**: scans the repo for candidate docs, merges with server state, enforces plan quotas server-side, embeds inserted/re-uploaded docs, deletes dropped docs.
- **Does NOT**: touch folders/files/symbols, walk source code, produce the structural graph used by `explore-workspace-graphs`. Use `embed-workspace-graphs` for that.

Embeddings — and therefore per-plan chunk-quota consumption — only happen here. `browzer init` and `browzer workspace index` never produce embeddings.

## Quota exhaustion recovery

When the preflight check rejects a submit you have three options:

1. Use `--remove` (or uncheck in the TUI) to free chunks from docs you no longer need — submit deletes + inserts run in the same transaction.
2. Free a whole workspace slot via `workspace-management` (`browzer workspace delete <id>`) — see that skill for the delete/unlink/relink flow.
3. Upgrade the plan out of band.

## Common errors

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 3`** → no `.browzer/config.json` in current directory; run `embed-workspace-graphs` (`browzer init`) first, or `browzer workspace relink <id>`.
- **`exit 4`** → workspace id in config doesn't exist server-side; relink or re-init.
- **`exit 1` with "quota exceeded"** → storage or chunk budget maxed; see the recovery section above.
- **`exit 1` with "would delete N indexed documents"** → safeguard tripped; confirm with the user and re-run with `--i-know-what-im-doing`.
- **`exit 1` with "paths not found in workspace candidates"** → the `--add`/`--replace` spec referenced a path that doesn't exist locally or on the server. Fix the path or the glob.
- **`exit 1` with "Non-interactive shells require --yes"** → add `--yes` to the command.

## Tips

- Deselecting / `--remove`-ing an indexed doc is **destructive** — the embeddings are deleted on submit. Double-check before hitting submit.
- Safe to re-run `--add` any time; the command is idempotent when content hasn't changed.
- Sensitive files (`.env`, `*.key`, credentials) are filtered out of the candidate list before they can ever be selected.
- `--dry-run` pairs with any mutation mode — prints the plan without mutating.

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `auth-status` — pre-flight context probe.
- `embed-workspace-graphs` — index code structure (folders/files/symbols) — the sibling, non-embedding path.
- `semantic-search` — search the markdown corpus this skill produces.
- `workspace-management` — list / relink / unlink / delete workspaces when you need to free a plan slot.

## Output contract

Emit ONE line per mutation:

- **Add:** `embed-documents: added <N> documents (<K> reuploaded, <S> skipped); quota <chunks-used>/<chunks-limit>`
- **Remove:** `embed-documents: removed <N> documents; quota <chunks-used>/<chunks-limit>`
- **Replace:** `embed-documents: replaced workspace docs — <I> inserted, <D> deleted, <S> skipped; quota <chunks-used>/<chunks-limit>`
- **Audit (--plan):** `embed-documents: <N> documents indexed, <M> candidates not-yet-indexed; plan at /tmp/plan.json`
- **Safeguard tripped (destructive delta ≥ 5 without --i-know-what-im-doing):** two lines — `embed-documents: failed — would delete <N> docs without --i-know-what-im-doing` + `hint: review the deleted-path list in the server response, confirm with the operator, then re-run with --i-know-what-im-doing --yes`
- **Quota exhausted / auth failure / other:** two lines per the failure contract.

Never paste the full submit payload or deleted-path list in chat — the operator reads the JSON (`--save <path>`) when they need detail.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
