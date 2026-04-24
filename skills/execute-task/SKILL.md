---
name: execute-task
description: "Step 3 of the workflow (brainstorming → generate-prd → generate-task → execute-task → code-review → fix-findings → update-docs → feature-acceptance → commit). Use when the user wants to implement a task — even if they just say 'do this', 'build the feature', or point at a task number. Reads the task step from docs/browzer/feat-<date>-<slug>/workflow.json via jq, dispatches specialist agents per task.explorer.skillsFound domains. For TDD-applicable tasks, dispatches test-specialist (test-driven-development) first to author red tests, then domain-specialist agents to implement + make them pass. For non-TDD tasks, dispatches domain-specialist agents which invoke write-tests at end of scope to author green tests. Aggregates agent outputs into task.execution payload. For free-form tasks without a plan, calls generate-task first. Triggers: 'execute TASK_03', 'run the first task', 'implement task 02', 'do this task', 'build the feature from the plan', 'ship TASK_N', 'implement this'."
argument-hint: "[TASK_N | task-number | feat dir: <path> | free-form task description]"
allowed-tools: Bash(browzer *), Bash(jq *), Bash(mv *), Bash(date *), Bash, Read, Edit, Write, Glob, Grep, Agent
---

# execute-task — run one task end-to-end

Step 3 of the workflow. Picks one task from `workflow.json` and implements it end-to-end by dispatching specialist agents per the `task.explorer.skillsFound[]` domains that `generate-task` discovered, respecting the `task.reviewer.tddDecision` the Reviewer pass made.

You are the **orchestrator**. You read, plan, dispatch, review, verify. You don't write application code. Components, routes, hooks, migrations, workers, pages, tests — all by subagents. Your only writes (if any) are trivial integration glue (<15 lines: barrel export, one-line import, config key).

`workflow.json` is the canonical state. You read task steps via `jq` and write `.task.execution` fields via `jq | mv` — never via `Read`/`Write`/`Edit`.

## Phase 0 — Resolve the input

Skill is invoked with one of:

1. `TASK_N — feat dir: <path>` — preferred. Bind `FEAT_DIR` directly.
2. `TASK_N` or plain number, no path — look up `FEAT_DIR` from chat context (`generate-task`'s confirmation line) or `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -3` and ask.
3. Free-form description — call `generate-task` first (which in turn calls `generate-prd` if no PRD exists), then re-enter this skill with `TASK_01`.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`. Derive `STEP_ID` (e.g. `STEP_04_TASK_01`) by matching `taskId`:

```bash
STEP_ID=$(jq -r --arg tid "TASK_01" '.steps[] | select(.taskId==$tid) | .stepId' "$WORKFLOW")
```

Then read the task step and its key contract fields:

```bash
TASK_STEP=$(jq --arg id "$STEP_ID" '.steps[] | select(.stepId==$id)' "$WORKFLOW")
TDD_APPLICABLE=$(echo "$TASK_STEP" | jq -r '.task.reviewer.tddDecision.applicable // false')
TEST_SPECS=$(echo "$TASK_STEP" | jq -c '.task.reviewer.testSpecs // []')
SKILLS_TO_INVOKE=$(echo "$TASK_STEP" | jq -c '.task.explorer.skillsFound // []')
TASK_SCOPE=$(echo "$TASK_STEP" | jq -c '.task.scope // []')
INVARIANTS=$(echo "$TASK_STEP" | jq -c '.task.invariants // []')
SUGGESTED_MODEL=$(echo "$TASK_STEP" | jq -r '.task.suggestedModel // "sonnet"')
TRIVIAL=$(echo "$TASK_STEP" | jq -r '.task.trivial // false')
```

Flip the step to `RUNNING` and record start time:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq --arg id "$STEP_ID" --arg now "$NOW" \
   '(.steps[] | select(.stepId==$id)) |= (.status = "RUNNING" | .startedAt = $now)
    | .currentStepId = $id
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

State to user which mode:

> **Executing TASK_N — [title].** TDD applicable: <yes/no>. Skills: <list of skillsFound domains>. Suggested model: <haiku/sonnet/opus>.

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

Select based on `task.reviewer.tddDecision.applicable`:

### TDD applicable

1. **Dispatch the test-specialist** agent (role: `test-specialist`, skill: `test-driven-development`, model: `$SUGGESTED_MODEL`):

   ```
   Agent(
     model: "$SUGGESTED_MODEL",
     prompt: "[subagent-preamble.md §Step 1-5 pasted verbatim]

     Role: test-specialist (Red-phase executor).
     Skill to invoke: test-driven-development.
     Task step: $STEP_ID (feat dir: $FEAT_DIR).
     Scope: $TASK_SCOPE.

     Read your step via:
       jq --arg id \"$STEP_ID\" '.steps[] | select(.stepId==\$id) | .task.reviewer.testSpecs[] | select(.type==\"red\")' \"$WORKFLOW\"

     Author each listed red test. Verify they FAIL for the right reason.
     Update the task step's agents[] (role: test-specialist) via jq + mv with
     status, startedAt, completedAt, notes.
     DO NOT write implementation code. DO NOT author green tests.

     Return one line: test-driven-development: red tests authored in <files>; all failing as expected.
     ",
     isolation: "none"
   )
   ```

   Wait for completion. Confirm the step's `agents[]` shows the test-specialist with `status: completed`.

2. **Dispatch domain-specialist agents** per distinct `task.explorer.skillsFound[].domain`:

   For each distinct domain, assemble a prompt that:
   - Binds `STEP_ID` and `WORKFLOW`.
   - Provides the task's scope files for that domain.
   - Pastes subagent-preamble §Step 1-5 verbatim.
   - Instructs: make the red tests pass (read them first), write green tests for any `testSpecs[] | select(.type=="green")`, update `.task.execution.agents[]` with its status.

   If domains are independent (disjoint file sets), dispatch in parallel — one response turn, multiple `Agent(..., isolation: "worktree")` calls. The `isolation: "worktree"` is mandatory when two parallel agents touch overlapping files OR shared config (barrel export, vitest config, `turbo.json`).

   If dependent (domain A's output is needed as context by domain B), serialize: A first, confirm, then B with A's agents[] entry available to read.

   Example per-domain dispatch:

   ```
   Agent(
     model: "$SUGGESTED_MODEL",
     prompt: "[subagent-preamble.md §Step 1-5 pasted verbatim]

     Role: <domain>-specialist.
     Skill to invoke: <the skill path from skillsFound entry, e.g. .claude/skills/redis-specialist>.
     Task step: $STEP_ID (feat dir: $FEAT_DIR).
     Scope: $DOMAIN_FILES.
     Invariants to honor: $INVARIANTS (quoted verbatim; each is a MUST).

     Phase plan:
       1. Read the failing red tests authored by test-specialist.
       2. Implement scope to make them pass. Touch ONLY the scope files.
       3. Author green tests for any .task.reviewer.testSpecs[] | select(.type==\"green\")
          whose coverageTarget maps to this domain.
       4. Run the repo's gates (lint/typecheck/test) scoped to the owning package.
       5. Update .task.execution.agents[] via jq + mv with your role, model, status,
          startedAt, completedAt, and notes per schema §4 'execution'.

     Quality gate commands: $GATE_CMDS (from Phase 1 discovery).
     Auto-format: $HAS_AUTOFORMAT (yes → skip formatter as gate; no → include).
     ",
     isolation: "worktree"  // or "none" for serial single-domain work
   )
   ```

3. After all domain-specialists return, aggregate `.task.execution` per schema §4 (see Phase 3).

### TDD not applicable

1. Skip test-specialist.
2. Dispatch domain-specialist agents as above. Their prompt adds:
   - "After your implementation lands, invoke `Skill(write-tests)` to author green tests covering the scope. Pass the list of modified files."
3. Aggregate execution payload as above.

### Trivial inline path

When `task.trivial == true` AND scope is ≤3 files AND no cross-invariant AND outcome is deterministic (rename, constant split, one-line config): orchestrator may edit the file directly (≤15 lines of integration glue per file) without dispatching. Record as a single agent entry with `role: "inline-glue"`.

## Phase 3 — Aggregate execution payload and mark COMPLETED

Assemble `.task.execution` per schema §4:

```jsonc
{
  "agents": [
    { "role": "test-specialist", "skill": "test-driven-development", "model": "...",
      "status": "completed", "startedAt": "...", "completedAt": "...",
      "notes": "N red tests authored in <files>; all failing as expected" },
    { "role": "fastify-backend-specialist", "skill": ".claude/skills/fastify-best-practices",
      "model": "...", "status": "completed", ... }
  ],
  "files": {
    "created": [...],
    "modified": [...],
    "deleted": [...]
  },
  "gates": {
    "baseline": { "lint": "...", "typecheck": "...", "tests": "..." },
    "postChange": { "lint": "...", "typecheck": "...", "tests": "..." },
    "regression": [{ "file": "...", "test": "...", "result": "pass" }]
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

Write it via jq + mv and flip status to COMPLETED:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq --arg id "$STEP_ID" \
   --argjson execution "$EXECUTION_JSON" \
   --arg now "$NOW" \
   '(.steps[] | select(.stepId==$id)) |= (
      .task.execution = $execution
      | .status = "COMPLETED"
      | .completedAt = $now
      | .skillsInvoked = ([.task.execution.agents[]?.skill] | map(select(.)))
    )
    | .updatedAt = $now
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
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
- [ ] About to `Read` or `Write` `workflow.json` directly? → **Stop.** Use `jq | mv` only.

## Invocation modes

- **Via `orchestrate-task-delivery`:** called once `generate-task` emits the manifest. The orchestrator iterates per-task: execute-task → (eventually) code-review/fix-findings/update-docs/feature-acceptance/commit at pipeline level.
- **Standalone:** `/execute-task TASK_N` or "implement TASK_03" — prefer the chain-contract shape `TASK_N — feat dir: <path>` so Phase 0 mode 1 applies directly. If no task step exists for the given id, call `generate-task` first; if PRD also missing, start from `generate-prd`.

## Non-negotiables

- **Output language: English.** `.task.execution` fields and the one-line completion line are English regardless of operator's language.
- No application code by orchestrator (except ≤15-line integration glue).
- No silent skips of baseline capture or post-change verification.
- No inline fixes of failed gates.
- No parallel edits of same file without worktree isolation.
- No repo invariant left unchecked when its area was touched.
- No doc updates from this skill — `update-docs` owns that phase.
- `workflow.json` is mutated ONLY via `jq | mv`. Never with `Read`/`Write`/`Edit`.

## Related skills

- `generate-prd` — source of the PRD payload.
- `generate-task` — source of the task steps (explorer + reviewer) this executes.
- `test-driven-development` — red-phase executor invoked by test-specialist dispatch.
- `write-tests` — green-phase test authoring, invoked inside domain-specialist dispatches for non-TDD tasks.
- `code-review` — runs AFTER execute-task completes per task; the orchestrator schedules it.
- `update-docs` — patches docs based on `.task.execution.files.modified + .created`.
- `commit` — final phase; runs after `feature-acceptance` approves.
- `../../references/subagent-preamble.md` — paste into every dispatched agent's prompt.
- `../../references/workflow-schema.md` — authoritative schema.
