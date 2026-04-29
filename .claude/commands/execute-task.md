---
name: execute-task
description: "Implement one task end-to-end by dispatching domain specialists per its `task.explorer.skillsFound[]`. Each specialist loads project skills first, writes code scoped to `task.scope`, reports gates + invariants, and aggregates into `task.execution`. For free-form requests without a plan, calls `generate-task` first. Tests are NOT authored at this phase — they're written after `code-review` + `receiving-code-review` by the `write-tests` skill. Triggers: execute TASK_03, run the first task, implement task 02, do this task, ship TASK_N, build the feature from the plan, 'implement this'."
argument-hint: "[TASK_N | task-number | feat dir: <path> | free-form task description]"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(jq *), Bash(mv *), Bash(date *), Bash, Read, Edit, Write, Glob, Grep, Agent
---

# execute-task — run one task end-to-end

Step 3 of the workflow. Picks one task from `workflow.json` and implements it end-to-end by dispatching specialist agents per the `task.explorer.skillsFound[]` domains that `generate-task` discovered.

Tests are **not** authored at this phase. The pipeline writes tests AFTER `code-review` + `receiving-code-review` close findings — `write-tests` runs against the final post-fix state and runs Stryker/mutmut/go-mutesting in the same pass. Domain specialists dispatched here ship working code + scoped lint/typecheck gates and stop short of test authoring.

You are the **orchestrator**. You read, plan, dispatch, review, verify. You don't write application code. Components, routes, hooks, migrations, workers, pages — all by subagents. Your only writes (if any) are trivial integration glue (<15 lines: barrel export, one-line import, config key).

`workflow.json` is the canonical state. You read task steps via `jq` and write `.task.execution` fields via `browzer workflow *` CLI subcommands — never via `Read`/`Write`/`Edit`.

## Phase 0 — Resolve the input

Skill is invoked with one of:

1. `TASK_N — feat dir: <path>` — preferred. Bind `FEAT_DIR` directly.
2. `TASK_N` or plain number, no path — look up `FEAT_DIR` from chat context (`generate-task`'s confirmation line) or `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -3` and ask.
3. Free-form description — call `generate-task` first (which in turn calls `generate-prd` if no PRD exists), then re-enter this skill with `TASK_01`.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`. Derive `STEP_ID` (e.g. `STEP_04_TASK_01`) by matching `taskId`:

```bash
STEP_ID=$(jq -r --arg tid "TASK_01" '.steps[] | select(.taskId==$tid) | .stepId' "$WORKFLOW")
```

Then read the task context and lifecycle flags:

```bash
# Pre-formatted task context block ready to embed in subagent dispatch prompts
TASK_CONTEXT=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --render execute-task)

# Lifecycle flags still needed for orchestrator control flow (RUNNING flip, trivial path detection):
TASK_STATUS=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field status)
SUGGESTED_MODEL=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field task.suggestedModel)
TRIVIAL=$(browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW" --field task.trivial)
```

Flip the step to `RUNNING` and record start time:

```bash
browzer workflow set-status --await "$STEP_ID" RUNNING --workflow "$WORKFLOW"
browzer workflow set-current-step --await "$STEP_ID" --workflow "$WORKFLOW"
```

State to user which mode:

> **Executing TASK_N — [title].** Skills: <list of skillsFound domains>. Suggested model: <haiku/sonnet/opus>.

## Phase 1 — Discover repo shape (once, if not already known)

Read whichever manifest exists:

- `package.json` — read `scripts` for real test/lint/typecheck/build commands; `packageManager` to pick CLI.
- `pyproject.toml`, `tox.ini`, `Makefile` — Python.
- `go.mod` — Go (`go test ./...`, `go vet ./...`, `go build ./...`).
- `Cargo.toml` — Rust (`cargo test`, `cargo clippy`, `cargo build`).
- `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` — repo-level docs naming commands and invariants.

The task step typically already carries the right gate commands via `task.explorer` and `task.invariants` — prefer those. If not, discover here and pass into every subagent prompt.

### Sibling-task file staleness (anchor by content, not line number)

When you execute `TASK_N+K` (K ≥ 1) and any prior sibling task in the same session edited a file you're about to touch, line ranges are stale — every insertion shifted subsequent refs. The subagent prompt MUST include `anchor by content match, not line number`. Give the subagent the exact phrase to match against (a unique sentence or heading) and tell it to search via Read + scan, not to trust numeric lines.

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

Example per-domain dispatch:

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

After all domain-specialists return, aggregate `.task.execution` per schema §4 (see Phase 3).

### Trivial inline path

`task.trivial` is set by the Reviewer pass in `generate-task` (`task.reviewer`-time decision; see Rule 8 / "Trivial flag" in `generate-task/SKILL.md`). `execute-task` MUST trust that flag — re-validating the trivial conditions in this skill duplicates a decision that has already been made and recorded in the audit trail.

When `task.trivial == true`: orchestrator may edit the file directly (≤15 lines of integration glue per file) without dispatching. Record as a single agent entry with `role: "inline-glue"`.

Re-validation only fires for **legacy task records** where `task.trivial` is missing (older feat dirs predating the Reviewer's trivial decision). In that case, fall back to the old inline gate: ≤3 files AND no cross-invariant AND deterministic outcome (rename, constant split, one-line config). Today's records always carry the field; the fallback is defense-in-depth, not the default path.

## Phase 3 — Aggregate execution payload and mark COMPLETED

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

Write it via CLI and flip status to COMPLETED:

```bash
# Write execution payload via patch (complex nested update with derived skillsInvoked)
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" --argjson execution "$EXECUTION_JSON" --arg now "$NOW" \
  '(.steps[] | select(.stepId==$id)) |= (
     .task.execution = $execution
     | .skillsInvoked = ([.task.execution.agents[]?.skill] | map(select(.)))
   )'
browzer workflow complete-step --await "$STEP_ID" --workflow "$WORKFLOW"
```

**Regression-diff contract gate.** Immediately after the COMPLETED write, validate the contract spelled out in `references/subagent-preamble.md` §Step 2.5 — any step that captured `gates.baseline` MUST have populated `gates.regression`. The shared helper does the check in one line:

```bash
source references/jq-helpers.sh
validate_regression "$STEP_ID" || {
  # Re-flip to STOPPED — silently passing a step with a baseline but no
  # regression diff is exactly how the 2026-04-27 retro mis-attributed
  # 429 pre-existing lint warnings + 12 unrelated test failures.
  browzer workflow set-status --await "$STEP_ID" STOPPED --workflow "$WORKFLOW"
  browzer workflow patch --workflow "$WORKFLOW" --jq \
    --arg id "$STEP_ID" \
    '(.steps[] | select(.stepId==$id)).stopReason = "regression-diff-contract-failed"'
  exit 1
}
```

If any regression surfaced in Phase 2 and was not recovered, set `status: "STOPPED"` instead of `"COMPLETED"` and emit the stop line in Phase 4.

## Phase 4 — Completion (one line)

On success:

```
execute-task: updated workflow.json $STEP_ID; status COMPLETED; files <created>/<modified>
```

Where `<created>/<modified>` counts come from `.task.execution.files`.

On failure:

```
execute-task: stopped at $STEP_ID — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output:** subagents table, files list, skills loaded, invariants enforced, baseline-vs-post-change table, "Next steps" block. All of that data lives in `.task.execution` inside `workflow.json`. The orchestrator reads it via `jq`.

## Phase 5 — Hand-off (when orchestrated)

You do NOT invoke `code-review`, `update-docs`, `feature-acceptance`, or `commit`. The orchestrator (`orchestrate-task-delivery`) schedules those phases after `execute-task` returns.

## Orchestrator anti-patterns (self-check before every message)

- [ ] About to edit an application file? → **Stop, dispatch a subagent** (unless trivial inline path applies).
- [ ] Announced N parallel agents? → Count `Agent()` calls in this message. Must equal N.
- [ ] Parallel agents touching overlapping files? → Add `isolation: "worktree"` to each.
- [ ] Gate failed? → **Dispatch fix agent**, don't fix inline.
- [ ] About to guess library/config shape? → Run `browzer search` first, then Context7 if needed.
- [ ] Verified every applicable repo invariant in subagent's diff against quoted rules?
- [ ] Editing CLAUDE.md / README.md / AGENTS.md? → **Stop. That's `update-docs`'s job.**
- [ ] About to `Read` or `Write` `workflow.json` directly? → **Stop.** Use `browzer workflow *` only.

## Invocation modes

- **Via `orchestrate-task-delivery`:** called once `generate-task` emits the manifest. The orchestrator iterates per-task: execute-task → (eventually) code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit at pipeline level.
- **Standalone:** `/execute-task TASK_N` or "implement TASK_03" — prefer the chain-contract shape `TASK_N — feat dir: <path>` so Phase 0 mode 1 applies directly. If no task step exists for the given id, call `generate-task` first; if PRD also missing, start from `generate-prd`.

## Non-negotiables

- **Output language: English.** `.task.execution` fields and the one-line completion line are English regardless of operator's language.
- No application code by orchestrator (except ≤15-line integration glue).
- No silent skips of baseline capture or post-change verification.
- No inline fixes of failed gates.
- No parallel edits of same file without worktree isolation.
- No repo invariant left unchecked when its area was touched.
- No doc updates from this skill — `update-docs` owns that phase.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

## Related skills

- `generate-prd` — source of the PRD payload.
- `generate-task` — source of the task steps (explorer + reviewer) this executes.
- `write-tests` — runs after `code-review` + `receiving-code-review` close findings; authors green tests AND runs mutation testing against the final post-fix file set.
- `code-review` — runs AFTER execute-task completes per task; the orchestrator schedules it.
- `update-docs` — patches docs based on `.task.execution.files.modified + .created`.
- `commit` — final phase; runs after `feature-acceptance` approves.
- `references/subagent-preamble.md` — paste into every dispatched agent's prompt.
- `references/workflow-schema.md` — authoritative schema.
