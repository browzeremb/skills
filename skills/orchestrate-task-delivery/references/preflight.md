# Preflight — workspace index staleness probe

Loaded only when the orchestrator wants the full failure-handling
detail. The body of `SKILL.md` already carries the one-liner contract;
this doc covers exit codes, lag thresholds, and trace formatting.

## Command

```bash
browzer workspace status --json --save /tmp/orch-status-<featureId>.json
```

Run this **before** the first `detect-phase` call of every invocation.

## Threshold

If `commitsBehind` (or the equivalent staleness field) is `> 5`, kick a
sync in the background:

```bash
browzer sync --skip-docs   # run_in_background: true
```

The sync is best-effort — do NOT block the loop waiting for it. A stale
index degrades grounding fidelity but does not block correctness.

## Trace bullet

Record the lag in `DELEGATION_TRACE.md` via:

```
--note "preflight: index lagged N commits; sync triggered"
```

## Failure handling

`browzer workspace status` may itself fail:

| Exit | Meaning             | Orchestrator action                              |
| ---- | ------------------- | ------------------------------------------------ |
| 2    | not authenticated   | proceed without sync; record failure in trace    |
| 4    | no workspace bound  | proceed without sync; record failure in trace    |

Downstream skills will surface index-stale assumptions in their own
receipts.
