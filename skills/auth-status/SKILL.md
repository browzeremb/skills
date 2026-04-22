---
name: auth-status
description: Probe the current Browzer login + workspace context as a single JSON document — the cheapest pre-flight call in the entire CLI. Use as the first step in any Browzer agent loop to confirm (a) the user is authenticated, (b) which workspace the current directory is bound to, (c) which gateway/organization the CLI is talking to, before running any explore/search/sync command. Wraps `browzer status` (probe only — for install/login itself use `use-rag-cli`). Also auto-runs via the plugin's SessionStart hook so workspace context is in scope at boot. Triggers - browzer, browzer status, browzer pre-flight, "am I logged in to browzer", "which browzer workspace", browzer auth check, browzer context, BROWZER_SERVER check, browzer organization, browzer health check, "what server is browzer pointing at", browzer diagnose.
allowed-tools: Bash(browzer *), Read
---

# auth-status — login + workspace context probe

The cheapest call in the entire `browzer` CLI. Always run it before doing anything else with Browzer in a session: it tells you whether the user is authenticated, which server the CLI is pointing at, and which workspace the current directory is bound to.

This skill is **probe-only**. For installing the CLI or running `browzer login` itself, use `use-rag-cli`.

## Quick start

```bash
browzer status --json                          # stdout JSON
browzer status --json --save /tmp/status.json  # clean JSON to a file (preferred in agent loops)
```

Then `Read /tmp/status.json` and branch:

- Authenticated + workspace bound → safe to call `explore-workspace-graphs` / `semantic-search` / `embed-workspace-graphs` / `embed-documents`.
- Authenticated + **no** workspace → run `embed-workspace-graphs` (`browzer init`) or `workspace-management` (`browzer workspace list` + `relink`).
- Not authenticated (exit code `2`) → run `use-rag-cli` (`browzer login`).

**Why probe before every chain:** Browzer state can drift mid-session (token expiry, server URL change, workspace deleted in another tab). A 50ms probe upfront prevents a 60s ingestion job from failing on auth.

## Common failures

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`). This skill diagnoses the problem; `use-rag-cli` fixes it.
- **Workspace shown but `explore-workspace-graphs` returns nothing** → `browzer workspace index` hasn't run yet; see `embed-workspace-graphs`.
- **Wrong server in output** → `BROWZER_SERVER` env var is set somewhere unexpected; unset and re-login.

## Tips

- This plugin's `SessionStart` hook already runs `browzer status --json` automatically — the result is in your context at boot. Re-run it explicitly only when state may have changed.
- Always use `--json` or `--save`; never parse the human-formatted variant.
- The command never mutates anything; safe to spam.

## Related skills

- `use-rag-cli` — install + authenticate the CLI (this skill is the **probe**, that one is the **fix**).
- `embed-workspace-graphs` — create workspace + index code structure.
- `embed-documents` — interactive doc picker (only path that embeds docs).
- `explore-workspace-graphs` — hybrid RAG over code (run after this probe passes).
- `semantic-search` — semantic search over markdown docs.
- `workspace-management` — list / get / delete workspaces.

## Output contract

Per the plugin's `README.md` §"Skill output contract" (at `../../README.md` relative to this file) — the skill emits ONE line summarising the probe:

- **Authenticated + workspace bound:** `auth-status: <email> on <workspace> (<chunks-used>/<chunks-limit> chunks, <server-label>)`
- **Authenticated, no workspace bound:** `auth-status: <email> authenticated; ⚠ no workspace bound to this directory — run embed-workspace-graphs`
- **Not authenticated (exit 2):** two lines per the failure contract:

  ```
  auth-status: failed — not authenticated (exit code 2)
  hint: run use-rag-cli (browzer login)
  ```

Never dump `/tmp/status.json` body in chat — cite the path if the operator needs detail.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
