---
name: semantic-search
description: Search the markdown documentation corpus of a Browzer workspace by meaning — this includes the project's own README/handbook/runbook/spec/ADR files AND any third-party library or framework documentation that has been ingested into the workspace (e.g. Next.js, React, better-auth, Drizzle ORM, Fastify, BullMQ, Neo4j, Tailwind). Use for ANY "how do I use X", "how do I configure X", "what do the docs say about X", "which environment variables does X require", "does this function take parameters" style question when the answer lives in written prose/markdown rather than source code. Also use for documentation Q&A and "where is this concept explained" questions, or before Reading multiple long markdown files looking for one passage. Wraps `browzer search`. **Markdown/docs only — for locating actual implementations in source files use `explore-workspace-graphs` instead.** Triggers - browzer, browzer search, semantic search, doc search, documentation search, markdown rag, knowledge base search, doc Q&A, README search, handbook search, runbook search, ADR search, spec search, library docs, framework docs, third-party docs, how-to, how do I use, how do I configure, how do I authenticate, how do I implement, design patterns, architecture decisions, conventions, project guidelines, what patterns does this repo follow, "where is this documented", "find the doc that explains", "what do the docs say", "per the docs", rag over docs, retrieval over markdown.
allowed-tools: Bash(browzer *), Read
---

# semantic-search — semantic search over indexed markdown docs

Sister skill to `explore-workspace-graphs`. Where `explore-workspace-graphs` searches the **code graph**, this skill searches the **markdown corpus** of the active workspace — READMEs, handbooks, runbooks, specs, ADRs. Documents can live at the workspace level (`workspaceId` set) or at the org level (`workspaceId = null`). For org-level docs, use `/api/documents?scope=org` or `browzer org docs list`. Use this skill for documentation Q&A and to find the right doc page before you Read it in full.

**Markdown/docs only — for code use `explore-workspace-graphs` instead.**

## Quick start

```bash
browzer status --json
browzer search "how do we configure the BullMQ worker" --json --save /tmp/docs.json
```

Then `Read /tmp/docs.json` and follow the top hits to the actual doc files.

**Why `--save` not stdout:** keeps the agent's context clean and lets `Read` pull only the relevant slice. Important when a knowledge base returns dozens of matches.

## Examples

```bash
browzer search "deployment runbook" --limit 10 --save /tmp/d.json
browzer search "what does the device flow do" --json --save /tmp/d.json
browzer search "rate-limit configuration" --limit 5 --json
browzer search "Neo4j memory tuning" --save /tmp/d.json
```

## Flag reference

| Flag            | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `--limit <n>`   | Max results (bounded `[1, 200]`).                                          |
| `--json`        | Emit JSON on stdout.                                                       |
| `--save <file>` | Write clean JSON to `<file>` (implies `--json`). Preferred in agent loops. |

## Common failures

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 3`** → no workspace in current directory; run `embed-workspace-graphs` (`browzer init`).
- **No matches on an obvious doc query** → docs may not have been indexed yet; run `embed-documents` (`browzer workspace docs`) to pick and embed them.
- **Top hits look like noise** → the question is probably about code, not docs — switch to `explore-workspace-graphs`.

## Tips

- If both code and docs are plausible, run `semantic-search` first (cheaper, narrower) and fall back to `explore-workspace-graphs`.
- Exit codes mirror `explore-workspace-graphs` — see `use-rag-cli` for the table.

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `auth-status` — pre-flight context probe.
- `embed-documents` — pick and embed markdown/PDF/text docs into the workspace (prerequisite for this skill).
- `embed-workspace-graphs` — index code structure (separate from docs).
- `explore-workspace-graphs` — same idea but for **code**.
- `workspace-management` — pick / delete the workspace being searched.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
