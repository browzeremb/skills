# Mode Contract — orchestrate-task-delivery

Mode-specific loop contract (autonomous vs review) and the inter-step narration rules. Load when resolving mode behaviour or auditing chat output between phases.

## Mode-specific loop contract

### Dispatch primitive selection

The orchestrator's loop body chooses the dispatch primitive per iteration based on `config.mode`, with one cross-mode exception:

| `config.mode` | Default primitive       | Rationale |
| ------------- | ------------------------ | --------- |
| `autonomous`  | `Agent(general-purpose, …)` | Each phase runs in an isolated subagent context. Orchestrator main thread sees only a 1-line cursor per phase. Token economy: ~30k cumulative vs ~180k+ historically with `Skill(...)` per phase. |
| `review`      | `Skill(<phase>)`           | Review-candidate skills render `.md` and gate on operator approval in the main session — that surface is broken if the skill runs inside a subagent. Token economy is sacrificed for interactive UX. |

**Cross-mode exception — Phase 3 (`execute-task`)**: ALWAYS dispatched as `Skill(execute-task, ...)` in main context, regardless of mode. Reason: `execute-task` is itself a sub-orchestrator that fans out to N domain specialists. Sub-Agents nested inside an `Agent` dispatch are unreliable across harness configurations (tool exposure inconsistent, return shape unstable). Running it as `Skill` in main keeps the fan-out reliable. Specialists themselves return one-line cursors back to `execute-task`, so the main thread does not see specialist transcripts even though `execute-task` itself runs in main.

Mode is resolved exactly once at orchestrator entry (Step 3). Mid-flow switch (`config.switchedFrom`) toggles the primitive on the next loop iteration.

### autonomous (`config.mode == "autonomous"`)

- **Dispatch primitive**: `Agent(general-purpose, …)` per phase EXCEPT Phase 3 (`execute-task`), which is `Skill(execute-task, ...)` in main context (see exception above). The Agent loads the phase skill internally via `Skill(<phase-skill-name>)`, executes it to completion, writes to `workflow.json`, returns a 1-line cursor. See `references/agent-dispatch-contract.md` for the verbatim prompt template.
- No pauses between skills.
- No `.md` rendered.
- The loop body in `SKILL.md §Step 5` iterates without operator confirmation between phases — no "prossiga" / "continue" gate.
- Code-review's dispatch+tier prompts are skipped because the orchestrator pre-registers them in Phase 4 args.
- Feature-acceptance's mode prompt still fires (it's a financial-cost-vs-trust decision the operator owns at acceptance time, distinct from the flow-level mode). When dispatched via Agent, the Agent uses `AskUserQuestion` — the harness routes the question to the operator's main session.
- The autonomous contract MUST NOT be downgraded by inferring intent from continuation words; if a skill needs an explicit answer, it MUST ask via `AskUserQuestion`, not from chat heuristics.

### review (`config.mode == "review"`)

- **Dispatch primitive**: `Skill(<phase>)` per phase, invoked directly from the orchestrator's main session.
- Each review-candidate skill (§7.3 of the spec: brainstorming, generate-prd, generate-task, update-docs, commit; hybrid: code-review, feature-acceptance) flips its step to `AWAITING_REVIEW`, renders its `.jq` template, enters its internal gate loop.
- The skill returns COMPLETED only after operator approval. The orchestrator's loop body waits for that flip before iterating to the next phase — it does NOT drive the review interaction itself; each skill owns its gate.
- Operator adjustments translate to jq ops on the step's payload. Appended to `reviewHistory[]`.

### Mid-flow mode switch

If invoked with `"mode: switch-to-autonomous"` or `"mode: switch-to-review"`, additionally set `.config.switchedFrom` + `.config.switchedAt`. Future phases respect the new mode; historical `reviewHistory[]` entries stay untouched.

## Inter-step narration contract

User-visible chat between phases is bounded. The audit trail lives in `workflow.json`; the chat line is the cursor.

### Allowed (terse, factual, action-oriented; one line each unless explicitly noted)

- Cursor lines that advance the pipeline: `Dispatching N reviewers in parallel (parallel-with-consolidator, tier=recommended).`
- Status snapshots: `execute-task: stepId=STEP_05_TASK_02; status=COMPLETED; executedTaskIds=[TASK_02]; failedTaskIds=[]`
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

### Inter-step self-audit

After every skill returns and before iterating to the next phase, run this silent self-check. It fires in BOTH modes.

```
[ ] Is the next message about to re-print fields already in workflow.json? → Suppress.
[ ] Is the next message about to emit a multi-bullet "summary"? → Suppress.
[ ] Is the next message about to re-state the plan for the next phase? → Suppress.
[ ] Is there something the operator genuinely needs to act on, decide, or be told? → Include only that.
[ ] Is the next loop iteration ready to fire? → Read next-pending and dispatch in the same response turn.
```

A response turn that passes none of these (i.e. it has nothing actionable for the operator AND it does NOT advance the loop) is a regression. Emit nothing and dispatch the next phase.

## Loop contract summary

**Auto-continue in autonomous mode.** When `config.mode == "autonomous"`, the orchestrator's loop body iterates without asking the operator to confirm. Operator interaction is reserved for:

  (a) Skill-internal review-mode renders (`AWAITING_REVIEW` → operator approves/adjusts).
  (b) Skill-internal always-ask prompts (e.g. code-review's dispatch+tier prompts when not pre-registered, feature-acceptance's mode prompt).
  (c) `operatorActionsRequested` entries that resolve a `PAUSED_PENDING_OPERATOR` step.
  (d) The clarification budget (one question per flow).

A turn that finishes a phase WITHOUT any of (a)-(d) firing AND without iterating the loop (read next-pending + dispatch the next phase's `Skill(...)`) is a regression. Valid terminal turns:

1. Final success: `orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>`.
2. Explicit stop: `orchestrate-task-delivery: stopped at <stepId> — <reason>` + `hint: <next step>`.
3. One-question clarification budget allowed per flow.

## Wrong vs right turn shape

The most common loop regression is a turn that quotes a phase-end cursor and then stops, expecting the operator to type "continue" / "proximo". This is a contract violation, not an end-of-turn.

### autonomous mode (Agent dispatch)

**Wrong** (turn ends here, orchestrator waits for operator):

```
code-review: stepId=STEP_09_CODE_REVIEW; status=COMPLETED
```

**Right** (same turn — cursor + next loop iteration fire together):

```
code-review: stepId=STEP_09_CODE_REVIEW; status=COMPLETED

<Bash: jq filter on .steps[] for first phase without a terminal status → RECEIVING_CODE_REVIEW>
<Agent: subagent_type=general-purpose, prompt="Load Skill(receiving-code-review) …">
```

### review mode (Skill dispatch)

**Wrong** (turn ends here, orchestrator waits for operator):

```
code-review: stepId=STEP_09_CODE_REVIEW; status=COMPLETED; findingIds=[F-1,F-2,...,F-27]
```

**Right** (same turn — cursor + next loop iteration fire together):

```
code-review: stepId=STEP_09_CODE_REVIEW; status=COMPLETED; findingIds=[F-1,F-2,...,F-27]

<Skill tool call: receiving-code-review>
```

### No machine-checked enforcer

The loop body in `orchestrate-task-delivery/SKILL.md §Step 5` is the controller — it iterates "read next-pending → dispatch the next phase (Agent in autonomous, Skill in review) in the same response turn" until a stop condition fires. There is no machine-checked enforcer (the previous `Stop` hook `orchestrator-autochain.py` was deleted); the loop's visibility in the skill body replaces it. If the model finishes a phase and stops without iterating, that is a regression to be fixed by tightening the loop body, not by re-introducing a forcing hook.
