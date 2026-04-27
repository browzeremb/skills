---
name: semantic-search
description: "Search the markdown documentation corpus of a Browzer workspace by meaning. Use first for any 'how does X work', 'how do I configure Y', 'what env vars does Z need', 'where is this documented', 'what do the docs say about X', or 'what conventions does this repo follow' question — before opening multiple markdown files looking for one passage. Covers any markdown the workspace has indexed: project documentation (whatever genre it ships in — overviews, design notes, decision records, operational runbooks, internal handbooks) plus any third-party library docs the operator has ingested. Use proactively whenever the answer is likely in written prose rather than source code. Wraps `browzer search`. Markdown/docs only — for source code use `explore-workspace-graphs`. Triggers: browzer search, doc search, semantic search, library docs, 'how do I use', 'how do I configure', 'per the docs', 'what patterns does this repo follow', 'find the doc that explains', 'what do the docs say'."
argument-hint: "<search query>"
allowed-tools: Bash(browzer *), Read
---

# semantic-search — semantic search over indexed markdown docs

Sister skill to `explore-workspace-graphs`. Where `explore-workspace-graphs` searches the **code graph**, this skill searches the **markdown corpus** of the active workspace — READMEs, handbooks, runbooks, specs, ADRs. Documents can live at the workspace level (`workspaceId` set) or at the org level (`workspaceId = null`). For org-level docs, use `/api/documents?scope=org` or `browzer org docs list`. Use this skill for documentation Q&A and to find the right doc page before you Read it in full.

**Markdown/docs only — for code use `explore-workspace-graphs` instead.**

## Quick start

```bash
browzer status --json
browzer search "how do I configure <topic>" --json --save /tmp/docs.json
```

Then `Read /tmp/docs.json` and follow the top hits to the actual doc files.

**Why `--save` not stdout:** keeps the agent's context clean and lets `Read` pull only the relevant slice. Important when a knowledge base returns dozens of matches.

## Examples

```bash
browzer search "deployment runbook" --limit 10 --save /tmp/d.json
browzer search "what does the <feature> flow do" --json --save /tmp/d.json
browzer search "<library> rate-limit configuration" --limit 5 --json
browzer search "<storage-system> tuning" --save /tmp/d.json
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

## Output contract

Emit ONE line per query:

- **Hits:** `semantic-search: <N> hits for "<query>" saved to /tmp/docs.json (top score <X.XX>)`
- **No hits (but workspace has indexed docs):** `semantic-search: 0 hits for "<query>"`
- **No docs indexed in workspace:** two lines — `semantic-search: failed — workspace has no indexed markdown docs` + `hint: run embed-documents (browzer workspace docs) to index markdown before searching`
- **Other failures:** two lines per the failure contract.

Ranked results live in /tmp/docs.json; never paste hit bodies inline.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
