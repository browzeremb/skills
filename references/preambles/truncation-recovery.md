# Truncation-recovery preamble (Step 4.5)

Embed this conditionally in dispatch prompts for subagents at high truncation risk (long edits, large file sets, multi-package refactors). Not included in every dispatch.

---

## Step 4.5 — Partial-status emission contract (mandatory when truncated)

When a subagent stops mid-stream after creating partial file sets without reaching the Step 4 `jq + mv` mutation, the orchestrator cannot distinguish "succeeded silently" from "truncated mid-flight" — and a blind resume risks losing work or duplicating edits.

If — for any reason (output budget, tool failure, blocked by Step 2.5b, runtime error mid-edit) — you created or modified files but did NOT reach the Step 4 atomic write, your **last output line MUST be a single-line JSON object** matching this shape:

```jsonc
{"status": "partial", "filesCreated": ["<path>", ...], "filesModified": ["<path>", ...], "filesDeleted": ["<path>", ...], "lastCheckpoint": "<short phrase: e.g. 'after writing route handler, before tests'>", "blockedOn": "<optional one-liner if known>"}
```

Rules:

- One JSON object, on the LAST line of your output, no trailing prose, no markdown fence around it. The orchestrator's resume parser reads only the last line and expects it to start with `{`.
- Include `filesDeleted` even when empty — the orchestrator needs to know nothing was reverted.
- `lastCheckpoint` is the most recent stable boundary you reached (e.g. "tests written and passing", "route handler complete, tests not yet attempted"). The orchestrator uses it to decide whether to resume or re-dispatch.
- Emit this BEFORE any Step 5 confirmation line. If you emit both, the orchestrator treats the JSON as authoritative.

If you DID reach Step 4 successfully (workflow.json mutated), do NOT emit this object — proceed to Step 5 normally.
