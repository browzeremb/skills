---
name: explore-workspace-graphs
description: "Search a codebase by intent via `browzer explore` — use FIRST before Grep/Read on any large or unfamiliar repo. Returns ranked entries with paths, symbol names, exports, imports, importedBy, lines, and scores (Neo4j embeddings + symbol graph). Code only; for markdown/docs use `semantic-search`. Triggers: browzer explore, code search, semantic code search, 'where is X implemented', 'find the function that does Y', 'what calls Z', 'who uses this symbol', 'what does this file export', symbol search, refactor lookup, find prior art, monorepo navigation."
argument-hint: "<search query>"
allowed-tools: Bash(browzer *), Read
---

# explore-workspace-graphs — hybrid vector + Graph RAG over code

Run `browzer explore` against the workspace registered in the current directory and get back ranked file entries with paths, symbol names, exports, imports, importedBy, line counts, and relevance scores — backed by Neo4j embeddings + a symbol graph. Use this **before** falling back to Grep/Read on a large or unfamiliar repository: it is dramatically more token-efficient than wide Grep sweeps and finds semantically related code that keyword search misses.

**Code only — for markdown/docs use `semantic-search` instead.**

## Routing — act immediately, do not just recommend

When this skill determines the question is **not** a code search, execute the correct path right away rather than just describing what to do:

- **Docs / markdown question** → run `browzer search` immediately. Do not stay in this skill.
  ```bash
  browzer search "<query>" --save /tmp/docs.json
  Read /tmp/docs.json
  ```
- **Repo not indexed yet** → run `browzer init` immediately. Do not stay in this skill.
  ```bash
  browzer init --dry-run   # preview first
  browzer init             # then index
  browzer workspace index  # or refresh an existing index
  ```

The goal is action, not narration. If you find yourself writing "you should use embed-workspace-graphs instead", stop and run the command.

## Quick start

```bash
# Make sure we're authenticated and inside a Browzer workspace
browzer status --json

# Discover the response shape (zero-shot — no query required)
browzer explore --schema

# Run a search and write clean JSON to a file (preferred in agent loops)
browzer explore "where is the auth middleware" --json --save /tmp/explore.json
```

Then `Read /tmp/explore.json` and act on the ranked results.

**Why `--save` not stdout:** keeps the agent's context clean and lets `Read` pull only the slice it needs. Stdout JSON works too but pollutes the conversation log on large result sets.

## Reading the response

Each entry in `entries[]` contains:

| Field        | Description                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `path`       | Workspace-relative file path (e.g. `src/routes/users.ts`).                                              |
| `type`       | `"file"` or `"folder"`.                                                                                  |
| `score`      | IDF relevance score — higher means more relevant. Results are already ordered by score descending.       |
| `lines`      | Total line count of the file — helps estimate complexity without opening it.                             |
| `exports`    | Symbol names exported by this file. Know what a file exposes without reading it.                         |
| `imports`    | Files this file depends on (forward dependencies).                                                       |
| `importedBy` | Files that import this file — reverse dependencies / blast radius.                                       |

> **Tip:** Before refactoring, check `importedBy` to estimate blast radius — no need for `Grep 'import.*from'` sweeps.

## Examples

```bash
browzer explore "rate limiter implementation" --limit 20 --save /tmp/r.json
browzer explore "how is the OAuth login wired" --json --save /tmp/r.json
browzer explore "database connection bootstrap" --limit 10 --json
browzer explore "where do we validate user ownership" --save /tmp/r.json
browzer explore "tests that exercise the background job consumer" --json --save /tmp/r.json
```

## Flag reference

| Flag            | Purpose                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `--limit <n>`   | Max results to return (default `50`, bounded `[1, 200]`).                                                     |
| `--json`        | Emit a single JSON document on stdout instead of human text.                                                  |
| `--save <file>` | Write clean JSON to `<file>` (implies `--json`). **Always prefer this in agent loops** — no banners, no ANSI. |
| `--schema`      | Print the JSON schema of the response and exit. Use to discover shape without running a query.                |

## Common failures

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 3`** → no workspace in current directory; run `embed-workspace-graphs` (`browzer init` + `browzer workspace index`).
- **Empty results on a freshly-indexed repo** → `browzer workspace index` hasn't been run yet, or is still populating; re-run it and check `auth-status`.
- **Results all from one wrong subdirectory** → workspace was indexed at the wrong root; verify with `workspace-management` (`browzer workspace get <id>`).

## Tips

- The `--schema` output is the fastest way to remind yourself which fields are available; cache it once per session.
- Combine with `auth-status` at session start so you know which workspace is active before composing queries.

## Non-interactive contract (JSON shape)

```json
{
  "entries": [
    {
      "path": "src/routes/users.ts",
      "type": "file",
      "score": 7.753,
      "lines": 650,
      "exports": ["userRoutes", "UserRoutesOptions"],
      "imports": ["src/services/user-service.ts", "src/db/users.ts"],
      "importedBy": ["src/server.ts"]
    }
  ]
}
```

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `auth-status` — pre-flight context probe.
- `embed-workspace-graphs` — index code structure before searching it.
- `embed-documents` — the ONLY path that embeds markdown/PDF/text docs.
- `semantic-search` — same idea but for **markdown docs**.
- `workspace-management` — pick / delete the workspace being searched.
- `dependency-graph` — deep-dive into a single file's imports, exports, and reverse dependencies.

## Output contract

Emit ONE line per query:

- **Hits:** `explore-workspace-graphs: <N> entries for "<query>" saved to /tmp/explore.json (top score <X.XX>)`
- **No hits (but workspace is indexed):** `explore-workspace-graphs: 0 entries for "<query>"`
- **Workspace empty / not indexed:** two lines — `explore-workspace-graphs: failed — workspace has no indexed code` + `hint: run embed-workspace-graphs (browzer init + browzer workspace index)`
- **Other failures (auth, no workspace in cwd, wrong root):** two lines per the failure contract.

Ranked results live in /tmp/explore.json; the chat line is the cursor, never a body-dump of paths or entries.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
