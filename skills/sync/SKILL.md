---
name: sync
description: One-shot reconciler that re-indexes code structure AND re-syncs already-indexed documents in a single call via `browzer workspace sync` (alias `browzer sync`). Runs the non-interactive CI/agent path - re-parses the repo tree, re-uploads docs whose local content changed, deletes docs removed from disk, skips unchanged ones, and deliberately IGNORES never-indexed local files (use `embed-documents` for new adds). Ideal for post-merge CI hooks, scheduled freshness jobs, or a single "get this workspace back in sync with the working tree" command after a pull/rebase. Supports `--dry-run`, `--skip-code`, `--skip-docs`, `--force`, and `--json`/`--save` for scripted pipelines. Use this skill whenever the user says "sync the workspace", "re-sync browzer", "refresh the index", "bring browzer up to date", "keep the workspace fresh in CI", "re-parse + re-upload changed docs", or mentions `browzer sync` / `browzer workspace sync` — even if they don't name all the flags. For onboarding a brand-new repo use `embed-workspace-graphs` first (to run `browzer init`); for adding fresh documents use `embed-documents`; this skill is for everything downstream of those. Triggers - browzer sync, browzer workspace sync, re-sync workspace, refresh index, reconcile docs, re-upload changed docs, delete stale docs, CI sync hook, post-merge sync, --skip-code, --skip-docs, --dry-run sync, sync-workspace.
argument-hint: "[--dry-run] [--skip-code] [--skip-docs] [--force]"
allowed-tools: Bash(browzer *), Read
---

# sync-workspace — reconcile code graph + indexed docs in one shot

`browzer workspace sync` (alias `browzer sync`) is the non-interactive reconciler: it re-parses the code tree into the workspace graph and then reconciles the docs already indexed on the server against the current working tree. One command, two steps, always in this order — code first, then docs.

**It does not add new documents.** A local file that was never indexed stays never indexed. To add new docs use `embed-documents` (`browzer workspace docs --add ...`). This skill is for the steady-state maintenance path that runs after onboarding is done.

## Quick start

```bash
# 0. Sanity check
browzer status --json

# 1. The typical call — re-parse code + reconcile docs, block until done
browzer workspace sync

# 2. Scripted / CI call — JSON output, no spinners
browzer workspace sync --json --save /tmp/sync.json

# 3. Preview without mutating
browzer workspace sync --dry-run
```

## Mode matrix

| Intent                                        | Command                                     |
| --------------------------------------------- | ------------------------------------------- |
| Re-sync both code and docs                    | `browzer workspace sync`                    |
| Re-sync docs only (skip code re-parse)        | `browzer workspace sync --skip-code`        |
| Re-sync code only (same as `workspace index`) | `browzer workspace sync --skip-docs`        |
| Preview the full plan, touch nothing          | `browzer workspace sync --dry-run`          |
| Bypass jobs-in-flight preflight + parse gate  | `browzer workspace sync --force`            |
| Machine-readable output                       | `browzer workspace sync --json`             |
| Machine-readable output to a file             | `browzer workspace sync --save /tmp/s.json` |

`--skip-code` and `--skip-docs` together are rejected ("leaves nothing to do") — pick one at most.

## What each step does

1. **Code step** — walks the git tree (`isSensitive` + gitignore filters applied), posts the folder/file/symbol snapshot to `POST /api/workspaces/parse`. Subject to the three parse gates (see below). On success, stamps `.browzer/config.json:lastSyncCommit` so `browzer status` can report drift later.
2. **Doc step** — fetches the server's indexed-doc list AND walks the local doc tree AND reads live billing usage concurrently, then computes a delta per doc:
   - indexed + local changed ⇒ **re-upload**
   - indexed + local missing ⇒ **delete**
   - indexed + local unchanged ⇒ **keep** (no-op)
   - local-only (never indexed) ⇒ **ignored** — NOT added. This is the deliberate difference from `workspace docs`.

The order is non-negotiable: Package nodes created by the code step must exist before the doc step's entity-extraction linker runs, otherwise `RELEVANT_TO` edges never form for freshly re-uploaded docs.

## Parse gates (when `--force` is safe)

Same three gates as `embed-workspace-graphs` — the code step shares them.

- **Fingerprint `unchanged`** — byte-identical parse tree, server short-circuits with `{status: "unchanged"}` and the CLI prints `No changes detected — skipped re-parse`. `--force` is a no-op here.
- **Cooldown (HTTP 429 `parse_cooldown`)** — less than 30 s since the last parse. Respect `Retry-After` or re-run with `--force`. Safe — rate limit only.
- **Jobs-in-flight preflight** — pending BullMQ ingestion jobs on the workspace abort with exit 1 and the message `N ingestion job(s) still in flight ... Re-run with --force to bypass.` `--force` here is only safe if you're confident the pending jobs target a disjoint set of files. When in doubt, poll via `ingestion-jobs` (`browzer job get <batchId>`) until they drain, then re-run without `--force`.

`--force` maps to the HTTP header `X-Force-Parse: true` and also skips the client-side jobs-in-flight preflight. It is scoped to the code step — the doc step enqueues its own ingestion jobs and is not gated by pending parses.

## JSON payload shape

With `--json` or `--save <path>`:

```json
{
  "mode": "sync",
  "dryRun": false,
  "skipCode": false,
  "skipDocs": false,
  "codeFiles": 284,
  "docs": {
    "inserted": [],
    "reuploaded": [
      { "path": "docs/api.md", "documentId": "doc-uuid", "chunks": 8 }
    ],
    "deleted": [{ "path": "docs/old.md", "documentId": "doc-uuid" }],
    "skipped": [
      { "path": "docs/intro.md", "reason": "already indexed, hash unchanged" }
    ],
    "quotaAfter": {
      "plan": "free",
      "storage": { "used": 126000, "limit": 52428800 },
      "chunks": { "used": 15, "limit": 100 },
      "workspaces": { "used": 1, "limit": 1 }
    }
  }
}
```

- `inserted` is always `[]` for `sync` — new local files are ignored by design. If you see entries here, something is off; check the CLI version.
- `reuploaded` / `deleted` / `skipped` are always present as arrays (never `null`), so `jq '.docs.reuploaded | length'` is safe without `// []`.
- When `--skip-docs` is set, the `docs` key is omitted entirely.
- When `--dry-run` is set, `quotaAfter` reflects the pre-sync state (no mutation happened).

## When to use what

| Situation                                                   | Skill                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| First time seeing this repo — no `.browzer/config.json` yet | `embed-workspace-graphs` (`browzer init`)                  |
| Adding a brand-new document to the workspace                | `embed-documents`                                          |
| Removing a specific document from the workspace             | `embed-documents` (`--remove`)                             |
| Post-merge CI: keep everything in sync with `main`          | **this skill**                                             |
| After a rebase: my local tree moved, update Browzer         | **this skill**                                             |
| Docs got edited on disk — push the new content              | **this skill** (or `workspace sync --skip-code`)           |
| Only the code structure changed, don't touch docs           | `embed-workspace-graphs` (or `workspace sync --skip-docs`) |

`workspace sync --skip-docs` and `workspace index` are behavior-equivalent — prefer whichever reads clearer at the call site.

## Common failures

- **`exit 2`** — not authenticated. Run `use-rag-cli` (`browzer login`).
- **`exit 3`** — no `.browzer/config.json` in `cwd`. Run `embed-workspace-graphs` (`browzer init`) first, or `browzer workspace relink <id>`.
- **`exit 4`** — the workspace id in the config was deleted server-side. Re-init or relink.
- **`exit 1` "N ingestion job(s) still in flight"** — pending parses block the code step. Wait or re-run with `--force` (see gates above).
- **HTTP 429 `parse_cooldown`** — 30 s server-side cooldown. Honor `Retry-After` or re-run with `--force`.
- **`exit 1` "--skip-code and --skip-docs together leave nothing to do"** — pick at most one.
- **`exit 1` "N document delete(s) failed"** — at least one delete HTTP call failed after the upload phase succeeded. The CLI keeps the uploaded docs and the rebuilt cache; inspect the warnings and re-run `sync` to retry only the still-present stragglers.
- **Quota exceeded during re-upload** — the doc step runs the same preflight as `workspace docs`. Free quota via `embed-documents` (`--remove`) or upgrade the plan. Re-uploads don't count as new inserts for quota purposes unless the chunk count grew.

## Tips

- **Idempotent**. Running `sync` on a clean tree is a near-no-op: the fingerprint short-circuits the code step and every doc lands in `skipped`. Safe to wire into any post-merge hook.
- **Currently synchronous** — the command blocks until all upload batches reach a terminal state. If the CLI eventually exposes `--no-wait` on `sync` (docs reference it; as of CLI `cli-v0.*` it is not a wired flag), pair it with the `ingestion-jobs` skill to poll the returned `batchId`.
- **Dry-run before destructive local deletions**. If you just removed a chunk of docs locally and aren't sure which paths the server has, `--dry-run --json --save /tmp/plan.json` gives you the exact `deleted` list before you commit.
- **Sensitive files** (`.env`, `*.key`, credentials) and symlinks are dropped by the shared `isSensitive` filter before any read — both steps share the filter.
- **Git drift** — after a successful code step, `browzer status` compares the current HEAD against `lastSyncCommit` in the config. Run `sync` (or `workspace index`) to advance it.

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `auth-status` — pre-flight context probe before scripted `sync` calls.
- `embed-workspace-graphs` — initial `browzer init` + pure code re-parse.
- `embed-documents` — the ONLY path that adds or removes individual documents.
- `ingestion-jobs` — poll `browzer job get <batchId>` for async batches and interpret parse-gate responses.
- `workspace-management` — list / relink / unlink / delete workspaces when the config is stale.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
