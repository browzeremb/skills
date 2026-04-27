---
name: ingestion-jobs
description: Inspect, poll, and troubleshoot async ingestion + parse jobs for a Browzer workspace. Wraps `browzer job get <batchId>` (terminal polling after `sync --no-wait`) and interprets parse-gate responses (`{status: "unchanged"}` fingerprint hit, HTTP 429 `parse_cooldown` with `Retry-After`, "N ingestion jobs still in flight" preflight abort). Use when a batch was enqueued and the agent needs to wait for it, when a re-parse was blocked by jobs-in-flight, when hitting cooldown, or when deciding whether `--force` is appropriate. Triggers - browzer, browzer job get, batchId, jobs in flight, parse cooldown, Retry-After, X-Force-Parse, unchanged fingerprint, async ingestion polling, sync --no-wait follow-up.
argument-hint: "[<batchId>]"
allowed-tools: Bash(browzer *), Read
---

# ingestion-jobs — poll + interpret async ingestion batches

`browzer workspace sync --no-wait` and `browzer workspace docs --add ... --no-wait` enqueue server-side batches and return immediately with a `batchId`. This skill wraps `browzer job get <batchId>` so an agent can poll to completion, and translates the three parse-gate responses (fingerprint `unchanged`, HTTP 429 `parse_cooldown`, jobs-in-flight preflight) into a clear decision about whether `--force` is safe.

**Scope**: async ingestion + parse batches only. For **creating** ingestion jobs (doc adds, code re-index), use `embed-documents` or `embed-workspace-graphs`.

## Quick start

```bash
# After `browzer workspace sync --no-wait` printed a batchId:
browzer job get <batchId> --json --save /tmp/job.json
```

Then `Read /tmp/job.json` and branch on `.status`.

## When to use

- **After `sync --no-wait`** — a batch was enqueued and the agent has to block until it resolves before running `explore` / `search`.
- **Before a re-parse** — check whether jobs are still pending (`GET /api/workspaces/:id/jobs`) so you know whether the jobs-in-flight preflight will abort.
- **When interpreting a parse-gate response** — `unchanged` fingerprint, HTTP 429 `parse_cooldown`, or the "N ingestion jobs still in flight" CLI abort. This skill owns the vocabulary.

## Polling pattern

Loop with backoff until the batch reaches a terminal state:

```bash
BATCH_ID="<batchId from sync --no-wait>"
while true; do
  browzer job get "$BATCH_ID" --json --save /tmp/j.json
  status=$(jq -r .status /tmp/j.json)
  case "$status" in
    completed|failed|partial) break ;;
  esac
  sleep 2
done
jq . /tmp/j.json
```

If the server emits a `Retry-After` header on any transient 429 during polling, honor it — bump the `sleep` to match. Cap total wait in your wrapper so you don't hang a turn indefinitely.

## Parse gate vocabulary

Three distinct signals, three different recovery paths:

| Scenario          | Server signal                                    | CLI output                                                                         | `--force` safe?                                  |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Fingerprint hit   | `{status: "unchanged"}`                          | `No changes detected — skipped re-parse`                                           | N/A (server already short-circuited; no-op)      |
| Cooldown          | HTTP 429 `parse_cooldown`, `Retry-After: <sec>`  | `Parse cooldown active (wait <sec>s, or re-run with --force)`                      | Yes — rate-limit only, no correctness risk       |
| Jobs-in-flight    | CLI preflight (exit 1)                           | `N ingestion job(s) still in flight ... Re-run with --force to bypass.`            | **Caution** — can race pending extraction writes |

**Rule of thumb**: `--force` bypasses both cooldown and jobs-in-flight preflight but it does **not** bypass the fingerprint (that's server-side and idempotent). Use `--force` freely for cooldown; pause and ask the human before using `--force` on jobs-in-flight unless you can confirm the pending jobs target different files.

## JSON shapes

`browzer job get <batchId> --json` returns a `BatchStatusResponse` (see the public CLI source for the exact type):

```json
{
  "batchId": "batch-<uuid>",
  "status": "pending | in_progress | completed | partial | failed",
  "progress": {
    "total": 42,
    "completed": 40,
    "failed": 1,
    "pending": 1
  },
  "errors": [
    {"jobId": "job-<uuid>", "path": "docs/foo.md", "message": "embedding timeout"}
  ],
  "createdAt": "2026-04-14T10:23:01Z"
}
```

Terminal states: `completed`, `failed`, `partial`. Everything else keeps polling.

## Common errors

- **`exit 2`** → not authenticated; run `use-rag-cli` (`browzer login`).
- **`exit 4`** → `batchId` not found (typo, or already garbage-collected). Re-issue the originating `sync --no-wait` / `docs --add --no-wait` to get a fresh id.
- **`exit 1` with "Non-interactive shells require --yes"** → you're piping output; harmless for `job get` (read-only) but check the originating mutation command.

## Tips

- `GET /api/workspaces/:id/jobs` (no CLI alias yet) returns the full list of pending jobs for the workspace — useful to decide between waiting and `--force`-ing.
- The jobs-in-flight preflight counts active server-side jobs; completed jobs drain automatically, so a second attempt seconds later often succeeds without `--force`.
- Pair this skill with `embed-workspace-graphs` (re-parse workflow) and `embed-documents` (doc ingestion) — both emit `batchId` values this skill can poll.

## Related skills

- `use-rag-cli` — install + authenticate the browzer CLI (anchor skill).
- `embed-workspace-graphs` — `browzer workspace index` / `sync` — the main source of parse-gate responses.
- `embed-documents` — `browzer workspace docs --add ... --no-wait` emits batches this skill polls.
- `auth-status` — pre-flight context probe.

## Output contract

Emit ONE line per terminal poll result:

- **Completed:** `ingestion-jobs: batch <batchId> completed (<C>/<T> jobs succeeded, <F> failed, <P> pending)`
- **Partial / failed (terminal):** `ingestion-jobs: batch <batchId> <status> (<C> completed, <F> failed); details at /tmp/job.json`
- **Still polling (intermediate tick):** the skill keeps looping without emitting a final line — only emits when the batch reaches a terminal state.
- **Batch not found (exit 4):** two lines — `ingestion-jobs: failed — batch <batchId> not found (exit 4)` + `hint: re-run the originating sync --no-wait / docs --add --no-wait to get a fresh id`
- **Auth failure or other:** two lines per the failure contract.

Parse-gate signals (fingerprint `unchanged`, HTTP 429 `parse_cooldown`, jobs-in-flight abort) are surfaced through the originating skill's confirmation line, not this skill's — this skill only fires when polling a live `batchId`.

Never paste `progress.errors` or the full batch payload in chat — cite the saved JSON path.

## Documentation

- Browzer — https://browzeremb.com
- CLI source (public mirror) — https://github.com/browzeremb/browzer-cli
- Releases — https://github.com/browzeremb/browzer-cli/releases
