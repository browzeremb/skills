# Agent dispatch contract — autonomous mode

When `config.mode == "autonomous"`, the orchestrator's loop body in `SKILL.md §Step 5` delegates each phase to a `general-purpose` subagent via `Agent(...)`, with **one exception**: Phase 3 (`execute-task`) is dispatched as `Skill(execute-task, ...)` in main context regardless of mode, because it is itself a sub-orchestrator that fans out to N domain specialists. See `SKILL.md §5.2` for the rationale.

This contract specifies the prompt template, return shape, and Agent-internal guardrails so each dispatched Agent stays focused, the orchestrator's main thread stays lean, and Langfuse traces correlate.

## When to load this reference

- The orchestrator is in `autonomous` mode and is about to dispatch a phase.
- A new phase skill is added to the pipeline and you need to validate its Agent-dispatch shape.
- Debugging a regression where the Agent's return polluted the orchestrator's main context.

## Verbatim prompt template

Substitute `<...>` placeholders before dispatching. Paste the template below into the `Agent(prompt: ...)` argument; do NOT paraphrase — the literal phrasing of the return contract is what keeps the cursor terse.

```
You are dispatched to execute pipeline phase <PHASE_NUMBER> (<PHASE_NAME>) for
the feature workflow at:

  WORKFLOW=<absolute path to workflow.json>
  config.mode=autonomous

Step 1. Load the skill via Skill(<phase-skill-name>) — use the EXACT string
        from the next-pending entry's `.skill` field (verbatim — see
        references/subagent-preamble.md §"Skill invocation").

Step 2. Follow it to completion. Your config.mode is autonomous — do NOT
        pause for operator confirmation between sub-steps. The skill writes
        its own step to workflow.json via the canonical `browzer workflow *`
        verbs; do not Read/Write/Edit workflow.json directly.

Step 3. If the skill needs a clarification that genuinely cannot be
        auto-resolved (e.g. feature-acceptance's autonomous/manual/hybrid
        prompt), use AskUserQuestion — the harness routes it to the
        operator's main session. Do NOT halt silently.

Return contract — exactly one line plus the per-phase payload-extras (see
table below):

  <phase-skill-name>: stepId=<written stepId>; status=<COMPLETED|FAILED|PAUSED_PENDING_OPERATOR>; <payload-extras>

Where <payload-extras> is the MINIMUM the next phase needs to recover
context via `browzer workflow get-step` — see `SKILL.md §5.4` for the
per-phase table. NO re-citation of workflow.json contents (the orchestrator
reads them via jq for the next iteration). Optional: 1-sentence diagnostic
IF status != COMPLETED.
```

## Why the tight return contract

The orchestrator's main-thread context is preserved by the Agent boundary. Re-citing workflow.json fields in the return body negates the isolation. Treat the return as a cursor, not a report.

A 1-line cursor + optional 1-sentence diagnostic ≈ ~150 chars; a re-citation of the full step payload can be 2-5 KB and accumulates across 9 phases until compaction kicks in. The expected per-orchestration token budget under this contract:

| Phase | Skill body loaded? (orch context) | Orch context delta |
| ----- | --------------------------------- | ------------------ |
| Skill chain (legacy) | yes — full SKILL.md per phase | +20-40k cumulative |
| Agent dispatch (this contract) | no — only ~150 chars cursor | +1-2k cumulative |

## Env stamps (mandatory)

Per `SKILL.md §5.3`, the orchestrator MUST set `BROWZER_WORKFLOW_STEP_ID` + `BROWZER_DISPATCH_AGENT_ID` BEFORE the `Agent(...)` call AND `unset` them AFTER it returns. Both stamps land in the Agent's environment (the harness exports them) and are read by `.claude/hooks/langfuse_hook.py` (WF-HOOK-1) to correlate traces. Leaving them set after the dispatch leaks them into the next iteration's Agent and inflates per-step Langfuse score aggregates.

## Agent-internal guardrails

The Agent receives the prompt above and operates inside its own context. Inside that context:

- Do NOT spawn parallel sub-Agents UNLESS the loaded phase skill (e.g. `code-review` with parallel reviewers, `receiving-code-review` with per-finding fix groups) explicitly does so per its own SKILL.md.
- Do NOT call `Skill(orchestrate-task-delivery)` recursively. The orchestrator's loop is single-level; the dispatched Agent runs ONE phase, returns, and the orchestrator's outer loop iterates.
- Do NOT modify `config.mode` or `config.testExecutionDepth` from inside the Agent. Both are frozen at orchestrator entry. (`config.executionStrategy` is owned by `execute-task`, which DOES set it during its own Phase 1 — but only `execute-task` itself; no other phase touches that key.)

## Review-mode contrast

When `config.mode == "review"`, this contract does NOT apply — the orchestrator dispatches via `Skill(<phase>)` directly so review-candidate skills can render `.md` and gate on operator approval in the main session. See `references/mode-contract.md §"Mode-specific loop contract"` for the dispatch primitive selection table.
