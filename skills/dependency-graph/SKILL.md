---
name: dependency-graph
description: "Show a file's forward imports and reverse importers (blast radius) via `browzer deps`. Use proactively before ANY refactor of a shared utility, service, or type — even when the user didn't ask about dependencies. For code search use `explore-workspace-graphs`; for docs use `semantic-search`. Triggers: browzer deps, dependency graph, import graph, reverse imports, blast radius, refactoring impact, what depends on, importedBy, what imports this, coupling analysis, 'who uses this', 'what will break if I change'."
argument-hint: "<file-path>"
allowed-tools: Bash(browzer *), Read
---

# dependency-graph — file dependency analysis via the code graph

Wraps `browzer deps` to give you forward dependencies (what a file imports) and reverse dependencies (what imports a file) in a single command. Use this before refactoring to know exactly how many callers you will break, to trace import chains across packages, or to spot tightly coupled modules that should be decoupled.

**For broad code search use `explore-workspace-graphs` instead. For markdown/docs use `semantic-search`.**

## Routing — act immediately, do not just recommend

- **Code search question** ("where is X defined", "find the function that…") → run `browzer explore` immediately via `explore-workspace-graphs`.
- **Docs / architecture question** → run `browzer search` immediately via `semantic-search`.
- **Indexing / workspace setup** → use `embed-workspace-graphs`.
- **Dependency / import / blast radius question** → stay here and run `browzer deps`.

## Quick start

```bash
# Verify auth + workspace
browzer status --json

# Get full dependency info for a file (forward + reverse)
browzer deps "src/routes/users.ts" --json --save /tmp/deps.json
Read /tmp/deps.json
```

Then act on the `imports` and `importedBy` arrays returned.

**Why `--save` not stdout:** keeps the agent's context clean and lets `Read` pull only the slice it needs.

## Examples

| Goal                                    | Command                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Forward + reverse deps for a file       | `browzer deps "src/routes/users.ts" --json --save /tmp/deps.json`                |
| Reverse deps only (blast radius)        | `browzer deps "src/services/search.ts" --reverse --json --save /tmp/deps.json`   |
| Limit depth for large dep trees         | `browzer deps "src/server.ts" --limit 20 --json`                                 |
| Trace chain from shared utility outward | `browzer deps "src/lib/logger.ts" --reverse --json --save /tmp/deps.json`        |

## Flag reference

| Flag              | Purpose                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `--reverse`       | Show only reverse dependencies (importedBy) — who imports this file.                                      |
| `--limit <n>`     | Max entries to return per direction (default `50`, bounded `[1, 200]`).                                   |
| `--json`          | Emit a single JSON document on stdout instead of human text.                                              |
| `--save <file>`   | Write clean JSON to `<file>` (implies `--json`). **Always prefer this in agent loops** — no banners, no ANSI. |

## Non-interactive contract (JSON shape)

Full mode (forward + reverse):

```json
{
  "file": "src/routes/users.ts",
  "imports": [
    "src/services/user-service.ts",
    "src/services/search.ts",
    "src/lib/logger.ts"
  ],
  "importedBy": [
    "src/server.ts"
  ]
}
```

Reverse-only mode (`--reverse`):

```json
{
  "file": "src/services/search.ts",
  "importedBy": [
    "src/routes/users.ts",
    "src/workers/search-pipeline.ts"
  ]
}
```

## Common failures

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 3`** → no workspace in current directory; run `embed-workspace-graphs` (`browzer init` + `browzer workspace index`).
- **`404` / file not found in graph** → the file path is not in the index; check spelling or run `browzer workspace index` to refresh, then retry.
- **Empty `importedBy`** → the file is not imported by anything in the indexed graph (root entrypoints often have this). Expected — not an error.

## Tips

- Use `--reverse` for a quick blast radius check before any refactor — no need for `Grep 'import.*from'` sweeps.
- Combine with `explore-workspace-graphs`: run `browzer explore` first to find the relevant file path, then `browzer deps` on that path for the full dependency picture.
- `importedBy` length is a rough coupling metric — a file imported by 20+ others warrants extra care when changing its public API.

## Render the graph (optional)

When the operator would benefit from a visual blast radius — e.g. before a refactor of a
shared utility with 10+ importers — pipe the saved JSON through the Mermaid renderer. The
`.mmd` source pastes directly into any Markdown viewer (GitHub, VS Code preview, Claude
Code chat) that recognises Mermaid fences:

```bash
browzer deps "src/lib/logger.ts" --reverse --json --save /tmp/deps.json
node "$BROWZER_SKILLS_REF/dependency-graph/scripts/render-deps.mjs" \
  --input /tmp/deps.json --output /tmp/deps.mmd
```

The skill produces a `graph LR` flowchart with the analysed file highlighted in the centre
and forward / reverse imports flowing outward. Skip this step on small graphs (≤5 imports
+ ≤5 importers) — the JSON itself is already digestible.
## Output contract

Emit ONE line summarising the probe:

- **Forward + reverse:** `dependency-graph: <path> — <N> imports, <M> importedBy; saved to /tmp/deps.json`
- **Reverse only (--reverse):** `dependency-graph: <path> — <M> importedBy; saved to /tmp/deps.json`
- **Empty importedBy (file is a root entrypoint):** same success shape with `0 importedBy` — not a failure.
- **Not in graph (file not indexed or 404):** two lines per the failure contract — `dependency-graph: failed — <path> not found in workspace graph` + `hint: run embed-workspace-graphs (browzer workspace index) and retry`.
- **Other failures (auth, no workspace):** two lines per the contract.

Never paste the JSON body inline — cite the /tmp path.
