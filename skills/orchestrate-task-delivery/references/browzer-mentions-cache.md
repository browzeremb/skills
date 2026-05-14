# Cross-phase `browzer mentions` cache

Loaded only when the orchestrator is about to dispatch a skill that
issues `browzer mentions` (`code-review`, `finalize-feature` Phase A,
`feature-acceptance`). Every other phase skips this doc.

## Why this cache exists

Many phases call `browzer mentions <path>` against the same source-file
set produced by `execute-task`. The result is deterministic per
workspace HEAD, so re-running it across phases is pure waste.

The CLI verb signature is `browzer mentions <path>` — the command
rejects anything that does not resolve to a file path under the git
root. The cache helper itself is content-agnostic (the key is SHA-256
of the query string), but every documented invocation MUST use a real
`<path>` argument.

## Cache pattern

Before dispatching any skill that issues `browzer mentions`, route the
call through `${CLAUDE_PLUGIN_ROOT}/hooks/_browzer-cache.mjs`:

```js
import { getCached, setCached } from '${CLAUDE_PLUGIN_ROOT}/hooks/_browzer-cache.mjs';

// path example: '$CLAUDE_PROJECT_DIR/<some-source-file>' — must resolve under git root.
const query = `mentions ${path}`;
const cached = getCached(query);
if (cached.hit) return cached.value;
const value = await runBrowzerMentions(path); // shells out: browzer mentions <path> --json --save /tmp/mentions-<sanitized>.json
setCached(query, value);
return value;
```

## Scope and lifetime

- Scope: staging directory (`BROWZER_STAGING_DIR` env var, defaulting to
  the active feat's `staging/.cache/`).
- Lifetime: staging lifetime; no TTL knob.
