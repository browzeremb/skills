# Cross-phase `browzer mentions` receipt reuse

Loaded only when the orchestrator is about to dispatch a skill that
issues `browzer mentions` (`code-review`, `finalize-feature` Phase A,
`feature-acceptance`). Every other phase skips this doc.

## Why this doc exists

Many phases call `browzer mentions <path>` against the same source-file
set produced by `execute-task`. The result is deterministic per
workspace HEAD, so re-running it across phases is pure waste.

The CLI verb signature is `browzer mentions <path>` — the command
rejects anything that does not resolve to a file path under the git
root. Every invocation MUST use a real `<path>` argument; a bare
symbol name exits non-zero with `mentions requires a <path> argument`.

## Receipt-reuse pattern

The dedicated Node-side cache helper (`${CLAUDE_PLUGIN_ROOT}/hooks/_browzer-cache.mjs`)
was removed in `feat-20260514-hooks-shell-port` when the hook surface
was ported to Go. Callers now reuse the on-disk receipt directly via
the CLI's `--save` flag:

```bash
browzer mentions <path> --json --save /tmp/mentions-<sanitized-path>.json
```

A downstream phase that needs the same lookup re-reads the receipt
from `/tmp/mentions-<sanitized-path>.json` (idempotent under the same
HEAD). The `<sanitized-path>` token is the file path with `/` → `-`
and any non-alnum byte stripped, so two phases querying the same path
land on the same receipt and pay the network cost exactly once.

## Scope and lifetime

- Scope: `/tmp` (process-wide). Each `--save` receipt is rewritten on
  every invocation, so reuse only holds within a single staging
  session.
- Lifetime: until `/tmp` is cleared (OS reboot or operator action).
  There is no TTL knob.
