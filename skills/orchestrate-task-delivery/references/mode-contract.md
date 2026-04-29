# Mode Contract — orchestrate-task-delivery

Mode-specific chain contract (autonomous vs review) and the inter-step narration rules. Load when resolving mode behaviour or auditing chat output between phases.

## Mode-specific chain contract

### autonomous (`config.mode == "autonomous"`)

- No pauses between skills.
- No `.md` rendered.
- Skills chain directly — NO operator confirmation between phases (no "prossiga" / "continue" gate).
- Code-review's dispatch+tier prompts are skipped because the orchestrator pre-registers them in Phase 4 args.
- Feature-acceptance's mode prompt still fires (it's a financial-cost-vs-trust decision the operator owns at acceptance time, distinct from the flow-level mode).
- The autonomous contract MUST NOT be downgraded by inferring intent from continuation words; if a skill needs an explicit answer, it MUST ask via `AskUserQuestion`, not from chat heuristics.

### review (`config.mode == "review"`)

- Each review-candidate skill (§7.3 of the spec: brainstorming, generate-prd, generate-task, update-docs, commit; hybrid: code-review, feature-acceptance) flips its step to `AWAITING_REVIEW`, renders its `.jq` template, enters its internal gate loop.
- The skill returns COMPLETED only after operator approval. The orchestrator does NOT drive the review loop itself — each skill owns its gate.
- Operator adjustments translate to jq ops on the step's payload. Appended to `reviewHistory[]`.

### Mid-flow mode switch

If invoked with `"mode: switch-to-autonomous"` or `"mode: switch-to-review"`, additionally set `.config.switchedFrom` + `.config.switchedAt`. Future phases respect the new mode; historical `reviewHistory[]` entries stay untouched.

## Inter-step narration contract

User-visible chat between phases is bounded. The audit trail lives in `workflow.json`; the chat line is the cursor.

### Allowed (terse, factual, action-oriented; one line each unless explicitly noted)

- Cursor lines that advance the pipeline: `Dispatching N reviewers in parallel (parallel-with-consolidator, tier=recommended).`
- Status snapshots: `execute-task: updated workflow.json STEP_05_TASK_02; status COMPLETED; files 0/1.`
- Concrete decision/diagnostic lines the operator needs to see: `YAML cleaned (6 deletions, exactly the comment block + flag).`
- Required prompts (review-mode renders, always-ask prompts, `operatorActionsRequested` resolutions).
- The skill's one-line success/failure cursor (per its own output contract).

### Forbidden between steps unless something genuinely needs to be specified, asked, or told to the user

- "Grounding completo. Confirmações:" multi-bullet recaps that restate findings already written to `workflow.json`.
- Pre-step "I will now do X because Y because Z" framing paragraphs.
- Post-step "summary of what was just done" paragraphs.
- Re-printing fields (file counts, finding counts, AC IDs) the operator can read from the workflow record.
- Tasks tables, HANDOFF quotes, subagent transcripts, "Next steps" blocks.

Rule of thumb: if the same content is in `workflow.json`, don't re-narrate it. Speak only when the operator needs to act, decide, or notice something new.

## Step 4.0.5 — Inter-step narration audit

After every skill returns and before chaining to the next phase, run this silent self-check. It fires in BOTH modes.

```
[ ] Is the next message about to re-print fields already in workflow.json? → Suppress.
[ ] Is the next message about to emit a multi-bullet "summary"? → Suppress.
[ ] Is the next message about to re-state the plan for the next phase? → Suppress.
[ ] Is there something the operator genuinely needs to act on, decide, or be told? → Include only that.
[ ] Is the next phase chain action (Skill call) ready to fire? → Fire it in the same response turn.
```

A response turn that passes none of these (i.e. it has nothing actionable for the operator AND it does NOT launch the next `Skill(...)`) is a regression. Emit nothing and fire the next Skill call.

## Chain contract summary

**Auto-continue in autonomous mode.** When `config.mode == "autonomous"`, the orchestrator MUST chain directly from one phase to the next without asking the operator to confirm. Operator interaction is reserved for:

  (a) Skill-internal review-mode renders (`AWAITING_REVIEW` → operator approves/adjusts).
  (b) Skill-internal always-ask prompts (e.g. code-review's dispatch+tier prompts when not pre-registered, feature-acceptance's mode prompt).
  (c) `operatorActionsRequested` entries that resolve a `PAUSED_PENDING_OPERATOR` step.
  (d) The clarification budget (one question per flow).

A turn that finishes a phase WITHOUT any of (a)-(d) firing AND without launching the next phase's `Skill(...)` in the same turn is a regression. Valid terminal turns:

1. Final success: `orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>`.
2. Explicit stop: `orchestrate-task-delivery: stopped at <stepId> — <reason>` + `hint: <next step>`.
3. One-question clarification budget allowed per flow.
