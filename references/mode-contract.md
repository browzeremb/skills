# Mode contract — autonomous vs review

> Cross-skill reference for `orchestrate-task-delivery` mode behaviour,
> inter-step narration rules, and the Step 4.0.5 narration audit.
> Linked from skill bodies via `references/mode-contract.md`.

The orchestrator runs in one of two modes, picked once at entry and
never re-asked:

- **autonomous** — chain phases without pausing for operator input.
  Default. Maximises throughput. Use for trusted features and dogfood
  loops.
- **review** — pause between phases for operator approval. Each
  reviewable Skill renders an ephemeral `.md` via the per-step-type
  template at `packages/skills/references/renderers/*.jq` and waits
  for an approve/adjust signal. Use for high-risk features and
  production-critical changes.

## §Step 0.1 — mode acknowledge line

The orchestrator MUST emit ONE line on entry stating which mode is
active. Format:

```
mode: <autonomous|review> (source: <args|operator-prompt|default>)
```

After this line, **no further chat output** is allowed until the
first sub-skill returns. This is the mode-acknowledge line; the
narration audit at §Step 4.0.5 checks for its presence.

## §Step 4.0.5 — inter-tool narration audit

The harness closes a turn whenever the orchestrator emits chat text
without an accompanying `tool_use` block. A single "progress"
sentence between two Bash calls is enough to halt the chain and
force the operator to type "continue" — observed empirically across
multiple dogfood runs.

The contract: **between any two `tool_use` blocks in the orchestrator's
own response, no chat text is allowed**. Single-sentence "what I am
about to do" prefaces are allowed BEFORE the first tool call only.
Single-sentence summaries are allowed AFTER the last tool call only.
Anything else closes the harness turn prematurely.

### Enforcement (PostToolUse hook)

A PostToolUse hook in `packages/skills/hooks/guards/` checks the
orchestrator-agent message body that immediately follows a tool result.
If `len(text) > 50 chars` AND the next block is also text (not a
tool_use), the hook emits a warning:

```
WARNING: inter-tool narration detected (NN chars between tool calls).
This closes the harness turn — operator may need to prompt "continue".
See references/mode-contract.md §Step 4.0.5.
```

The hook is a **warning, not a block** — orchestrator iterations
shouldn't be lost to misclassified text.

### Permitted text positions

| Position | Length | Purpose |
|---|---|---|
| Before first tool call of the response | ≤ 1 short sentence | "I am going to X." |
| Between tool calls in the same response | 0 chars | (forbidden) |
| After last tool call of the response | ≤ 2 short sentences | Result + next step |

## §Multi-tool batching (mode-orthogonal)

In both modes, the orchestrator MUST batch independent tool calls in
the same response block. Estimated 30-40% wall-clock improvement
from doing this consistently.

See `references/pipeline-phases.md` §4 for the full heuristic table.

## §Mode-by-mode behaviour

| Behaviour | autonomous | review |
|---|---|---|
| Phase chaining | continuous | pause between phases |
| Renderer emission | suppressed | every reviewable Skill emits `.md` |
| Operator prompts | only on hard-block (e.g., guard failure) | every phase boundary |
| Inter-tool narration audit (§4.0.5) | strict | strict |
| `Skill()` chain budget | unlimited | gated by approval |
| Fail-fast on Skill validation error | yes | yes |

## §Mode resolution order

1. Explicit in invocation args — `Skill(orchestrate-task-delivery, "mode: autonomous; <rest>")` or `mode: review`. Take verbatim.
2. Operator prompt at orchestrator entry (review-mode default if
   ambiguous).
3. Stored in `workflow.json` `config.mode` from a previous run.
4. Default: `autonomous` for dogfood / `review` for production.
