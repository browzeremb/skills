# Operator discipline

Detail-level reference for `orchestrate-task-delivery` operator
contract. Factored out of `SKILL.md` to keep the body under the
per-skill line cap.

## Banned dispatch-prompt patterns

These patterns in any response between phases are contract violations:

- Asking the operator "should I proceed?" / "ready for the next
  phase?" in autonomous mode.
- Emitting a multi-bullet "summary of what was just done" before
  launching the next Skill call.
- Printing a tasks table, HANDOFF quote, subagent transcript, or
  "Next steps" block.
- Re-printing file counts, finding counts, or AC IDs the operator can
  read from workflow.json.
- Announcing "N parallel agents" without emitting N literal
  `Agent(...)` calls in the same message.
- Dispatching an Agent without first setting BROWZER_WORKFLOW_STEP_ID
  + BROWZER_DISPATCH_AGENT_ID — Langfuse traces lose step+agent
  correlation.

## Tool usage discipline

- **`workflow.json` mutation**: ALWAYS `browzer workflow *` CLI
  subcommands (or `browzer workflow patch --jq` for arbitrary
  mutations). NEVER `Read` / `Write` / `Edit` on `workflow.json`.
- **Parallel dispatch**: literal — N `Task(...)` or `Agent(...)`
  calls in a single response turn. See
  `references/parallel-dispatch.md`.
- **Subagent preamble**: paste `references/subagent-preamble.md`
  §Step 1-5 verbatim into every dispatched agent's prompt.
- **Browzer first**: before touching any library/framework/config you
  didn't author, run `browzer search` → then Context7 if browzer has
  no coverage.
- **jq helpers**: `source "scripts/jq-helpers.sh"` for complex
  cross-step reads.

## Operator discipline (RETRO-grade)

Empirical findings about orchestrator behaviour that hurts wall-clock
or token budget across the pipeline.

### Multi-tool-call batching

Issue independent tool calls in the **same response block** (one
multi-tool-call response, not N sequential responses). Estimated
30-40% wall-clock reduction in long pipelines. Heuristic table in
`references/pipeline-phases.md` §4 — apply to Bash + Edit + Read in
parallel whenever there is no read-after-write dependency between
them. The 4 mandatory code-review reviewers are the canonical
example: 1 response, 4 `Agent(...)` calls.

### Subagent output handling: refs only

Never re-cite a subagent's full output in the orchestrator's main
thread. Pass refs only — the subagent already wrote its findings into
`workflow.json` (or its assigned step), and downstream skills read
them via `browzer workflow get-step --field --save`. Re-citing 4
reviewer bodies inline can cost ~30k tokens for zero new information.
Rule: any text quoting a subagent body > 200 chars is a contract
violation; use a stepId reference instead.

### Inter-tool narration ban (ZERO narration)

Between any two `tool_use` blocks in the orchestrator's own
response, **no text is allowed**. Single-sentence prefaces before the
first tool call and brief summaries after the last tool call are
permitted. No text between tool calls. Violations close the harness
turn prematurely and force operator "continue" prompts. Enforced
softly by a PostToolUse hook documented in
`references/mode-contract.md` §Step 4.0.5.

### Schema lookup cache

`browzer workflow describe-step-type <NAME> --json --save /tmp/<name>-schema.json`
caches the schema once per step-type per session. Subsequent reads
are local file reads (zero daemon round-trip, zero schema-grep
round-trips against `references/workflow-schema.md`). 10+ schema
greps in one session is a smell — fix with a single cache schema
lookup at the top of each phase.

### Stage large dispatch inputs via `mktemp`, not inline

Whenever a dispatched Agent / Skill needs >2 KB of input — preamble +
PRD payload + per-task scope + invariants — stage the bundle in a
temp file and pass the path, NOT the content:

```bash
PREAMBLE_FILE=$(mktemp -t orch-preamble.XXXXXX)
PRD_FILE=$(mktemp -t orch-prd.XXXXXX)

# Write the large payloads ONCE.
cat references/subagent-preamble.md > "$PREAMBLE_FILE"
browzer workflow get-step "$PRD_STEP_ID" --field .prd \
  --save "$PRD_FILE" --quiet --workflow "$WORKFLOW"

# Dispatch references the paths; the agent reads them via Bash(cat *).
Agent(
  prompt: "First: cat $PREAMBLE_FILE — operator contract.
           Second: cat $PRD_FILE — PRD payload.
           Then: <task-specific instructions>",
  …
)
```

Why: every byte of inline `prompt` content lands in the orchestrator's
context window AND is shipped over the wire to the dispatched agent.
Inline a 6 KB preamble across 13 dispatches and you've burned ~78 KB
on identical bytes — once for the orchestrator's context, once per
dispatch on the wire. The temp-file pattern keeps the orchestrator
context lean and lets each dispatched agent `cat` its inputs locally.

Apply to: subagent preambles, full PRD payloads, per-task explorer
output, reviewer dispatch prompts, code-review baseline reports.

Anti-pattern: copying a 5 KB JSON blob inline into the `prompt:` of
an `Agent(...)` call. Stage it.

### Path discipline (CWD persists between Bash calls)

Every Bash tool call inherits the CWD that the previous call ended at.
A `cd <subdir>` in one call leaks into the next — a downstream `--workflow
"<relative-path>"` then resolves against that leaked CWD instead of the
repo root, producing confusing errors like `lock timeout: another browzer
workflow command is mutating <wrong-path>` (the daemon never validated
that the path exists before claiming the file lock).

Two safe patterns — pick by call type:

- **Absolute paths everywhere** — one-shot calls, every `WORKFLOW=...`
  binding, every `--workflow` flag. Resolve via `git rev-parse
  --show-toplevel` (or any other absolute resolver) once and reuse.
- **Subshell scope for `cd`** — multi-step calls that genuinely need a
  different CWD (`( cd <subdir> && <cmd> )` — the parens isolate the CWD
  change to the subshell so the next Bash call starts from the parent
  CWD).

Anti-patterns: `cd <subdir> && <cmd>` (no parens) followed by another
Bash call that uses a relative path; quoting `~` inside double quotes
(`"~/foo"` does NOT expand — use `"$HOME/foo"`). Full detail in
`references/pipeline-phases.md §"Path discipline — bash CWD persists
between tool calls"`.
