# Dispatch Pattern — execute-task

Detailed content for Phase 2 dispatch (per-domain template, parallel/serial decision, isolation rules, trivial inline path) and Phase 3 aggregate execution payload shape. Load when dispatching domain-specialist agents or assembling `.task.execution`.

## Phase 2 — Dispatch pattern

**No test authoring at this phase.** Tests are written AFTER `code-review` + `receiving-code-review` close findings; `write-tests` runs against the final post-fix state and runs Stryker/mutmut/go-mutesting in the same pass. Domain specialists ship working code + scoped lint/typecheck gates and stop short of writing or running mutation testing.

**Dispatch domain-specialist agents** per distinct `task.explorer.skillsFound[].domain`:

For each distinct domain, assemble a prompt that:

- Binds `STEP_ID` and `WORKFLOW`.
- Provides the task's scope files for that domain.
- Pastes subagent-preamble §Step 0-5 verbatim (Step 0 is the BLOCKING domain-skill load — without it the specialist works from training-data memory, not project conventions).
- Lists the `skillsFound[]` entries for the domain explicitly so the subagent's Step 0 has concrete `Skill(<path>)` calls to make. Order by relevance (`high` first).
- Instructs: implement scope, run the repo's gates (lint + typecheck only — `test` belongs to the post-fix `write-tests` phase), update `.task.execution.agents[]` with its status.

If domains are independent (disjoint file sets), dispatch in parallel — one response turn, multiple `Agent(..., isolation: "worktree")` calls. The `isolation: "worktree"` is mandatory when two parallel agents touch overlapping files OR shared config (barrel export, vitest config, `turbo.json`).

If dependent (domain A's output is needed as context by domain B), serialize: A first, confirm, then B with A's agents[] entry available to read.

### Per-domain dispatch template

```
Agent(
  model: "$SUGGESTED_MODEL",
  prompt: "[subagent-preamble.md §Step 0-5 pasted verbatim]

  Role: <domain>-specialist.
  Skills to invoke (BLOCKING — call each via Skill(...) in this order BEFORE any code work, per preamble Step 0):
    <skillsFound[].skill list for this domain, ordered by relevance: high → medium → low>
  Task step: $STEP_ID (feat dir: $FEAT_DIR).

  $TASK_CONTEXT

  Phase plan:
    0. Domain-skill load (preamble Step 0): for each skill listed above, call Skill(<path>)
       and follow its guidance. This is BLOCKING; subsequent steps without it produce
       drift from project conventions.
    1. Implement scope. Touch ONLY the scope files.
    2. Run the repo's lint + typecheck gates scoped to the owning package. Do NOT
       author tests, run the test suite, or run mutation testing — `write-tests`
       owns those concerns and runs after `receiving-code-review` closes findings.
    3. Update .task.execution.agents[] via jq + mv with your role, model, status,
       startedAt, completedAt, and notes per schema §4 'execution'.
       Include `skillsLoaded: [\"<path>\", ...]` listing every skill actually invoked
       via Skill() — the orchestrator audits this against the dispatched skillsFound[]
       and surfaces a contract violation when the set is empty despite a non-empty
       dispatch list.

  Quality gate commands: $GATE_CMDS (from Phase 1 discovery; lint + typecheck only).
  Auto-format: $HAS_AUTOFORMAT (yes → skip formatter as gate; no → include).
  ",
  isolation: "worktree"  // or "none" for serial single-domain work
)
```

After all domain-specialists return, aggregate `.task.execution` per schema §4 (see Phase 3 below).

## Trivial inline path

`task.trivial` is set by the Reviewer pass in `generate-task` (`task.reviewer`-time decision; see Rule 8 / "Trivial flag" in `generate-task/SKILL.md`). `execute-task` MUST trust that flag — re-validating the trivial conditions in this skill duplicates a decision that has already been made and recorded in the audit trail.

When `task.trivial == true`: orchestrator may edit the file directly (≤15 lines of integration glue per file) without dispatching. Record as a single agent entry with `role: "inline-glue"`.

Re-validation only fires for **legacy task records** where `task.trivial` is missing. In that case, fall back to the old inline gate: ≤3 files AND no cross-invariant AND deterministic outcome (rename, constant split, one-line config). Today's records always carry the field; the fallback is defense-in-depth, not the default path.

## Phase 3 — Aggregate execution payload shape

Assemble `.task.execution` per schema §4:

```jsonc
{
  "agents": [
    { "role": "fastify-backend-specialist", "skill": ".claude/skills/fastify-best-practices",
      "model": "...", "status": "completed", "startedAt": "...", "completedAt": "...",
      "notes": "implemented routes + scoped lint/typecheck green" },
    { "role": "frontend-specialist", "skill": ".claude/skills/nextjs-app-router",
      "model": "...", "status": "completed", ... }
  ],
  "files": {
    "created": [...],
    "modified": [...],
    "deleted": [...]
  },
  "gates": {
    "baseline": { "lint": "...", "typecheck": "..." },
    "postChange": { "lint": "...", "typecheck": "..." },
    "regression": []
  },
  "invariantsChecked": [
    { "rule": "...", "source": "CLAUDE.md §X", "status": "passed|failed|needs-review",
      "note": "..." }
  ],
  "scopeAdjustments": [...],
  "fileEditsSummary": {},
  "testsRan": {
    "preChange": { "testCount": "N passed", "duration": "...", "details": "..." },
    "postChange": { "testCount": "M passed", "duration": "...", "details": "..." }
  },
  "nextSteps": "..."
}
```

Write via CLI and flip status to COMPLETED:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" --argjson execution "$EXECUTION_JSON" --arg now "$NOW" \
  '(.steps[] | select(.stepId==$id)) |= (
     .task.execution = $execution
     | .skillsInvoked = ([.task.execution.agents[]?.skill] | map(select(.)))
   )'
browzer workflow complete-step --await "$STEP_ID" --workflow "$WORKFLOW"
```

### Regression-diff contract gate

Immediately after the COMPLETED write, validate the contract spelled out in `references/subagent-preamble.md` §Step 2.5 — any step that captured `gates.baseline` MUST have populated `gates.regression`:

```bash
source references/jq-helpers.sh
validate_regression "$STEP_ID" || {
  browzer workflow set-status --await "$STEP_ID" STOPPED --workflow "$WORKFLOW"
  browzer workflow patch --workflow "$WORKFLOW" --jq \
    --arg id "$STEP_ID" \
    '(.steps[] | select(.stepId==$id)).stopReason = "regression-diff-contract-failed"'
  exit 1
}
```

If any regression surfaced in Phase 2 and was not recovered, set `status: "STOPPED"` instead of `"COMPLETED"`.
