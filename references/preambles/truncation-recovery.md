# Truncation-recovery preamble (markdown-chains era)

Embed this conditionally in dispatch prompts for subagents at high
truncation risk: long edits, large file sets, multi-package refactors. NOT
included in every dispatch — only when the dispatcher's heuristic flags
truncation risk.

## Why this exists

When a subagent stops mid-stream after creating partial file sets without
emitting the structured `## Subagent report`, the dispatcher cannot
distinguish "succeeded silently" from "truncated mid-flight". A blind
resume risks losing work or duplicating edits. The fallback below gives
the dispatcher a parseable signal even when the full report is missing.

## Partial-status emission contract (mandatory when truncated)

If — for any reason (output budget, tool failure, runtime error mid-edit)
— you created or modified files but did NOT emit a full `## Subagent
report`, your **last output line MUST be** a single-line JSON object
matching this shape:

```jsonc
{"status": "partial", "filesCreated": ["<path>", ...], "filesModified": ["<path>", ...], "filesDeleted": ["<path>", ...], "lastCheckpoint": "<short phrase>", "blockedOn": "<optional one-liner if known>"}
```

**Rules:**

- One JSON object, on the LAST line of your output, no trailing prose, no markdown fence. The dispatcher's resume parser reads only the last line and expects it to start with `{`.
- Include `filesDeleted` even when empty — the dispatcher needs to know nothing was reverted.
- `lastCheckpoint` is the most recent stable boundary you reached (e.g. "tests written and passing", "route handler complete, tests not yet attempted"). The dispatcher uses it to decide whether to resume or re-dispatch.
- Emit this BEFORE any Step 5 confirmation line. If you emit both, the dispatcher treats the JSON as authoritative.

If you DID emit a complete `## Subagent report` (Step 4 completed
successfully), do NOT emit this object — proceed to Step 5 normally.

## Dispatcher resume semantics

The dispatcher reads `status: partial` and decides:

- If `lastCheckpoint` indicates a stable boundary AND files were created → resume from the next logical step in a re-dispatch with the original scope.
- If `lastCheckpoint` indicates mid-edit instability → mark `TASK_NN.failed.md` with `Reason: truncated-mid-flight` and surface to the operator.
- If `blockedOn` cites a specific constraint → escalate to opus + research per the 7-step ladder (when in the `receiving-code-review` flow).
