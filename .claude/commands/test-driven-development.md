---
name: test-driven-development
description: "Red-phase executor invoked by execute-task's test-specialist dispatch. Reads .task.reviewer.testSpecs[] | select(.type==\"red\") from workflow.json and authors every listed red test, then runs the scoped test command and confirms they FAIL for the right reason. Does NOT decide TDD applicability (that's generate-task.reviewer's job). Does NOT write implementation code. Does NOT author green tests (that's write-tests). Updates the task step's agents[] entry for the test-specialist role. Triggers: dispatched by execute-task when task.reviewer.tddDecision.applicable == true. Operator-facing invocation: 'write the red tests for TASK_N', 'author the failing tests', 'start the TDD cycle for this task', 'red phase now'."
argument-hint: "[task: TASK_NN | step: STEP_NN_TASK_MM | feat dir: <path>]"
allowed-tools: Bash(browzer *), Bash(node *), Bash(git *), Bash(date *), Bash(ls *), Bash(test *), Bash(pnpm *), Bash(pytest *), Bash(go *), Bash(jq *), Bash(mv *), Read, Write, Edit, AskUserQuestion
---

# test-driven-development — Red-phase executor

Pure executor invoked by `execute-task`'s test-specialist dispatch. No decision logic. Reads the red-test specs authored by `generate-task.reviewer`, writes each test, and verifies they fail.

This skill is based on the principles of `superpowers:test-driven-development` — it does **not** invoke that skill; it re-implements the discipline inside the Browzer plugin so this plugin ships self-contained.

Output contract: `../../README.md` §"Skill output contract".

---

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
```

Your contract is: author every red spec, run the scoped tests, confirm they fail for the right reason. You do NOT write implementation code. You do NOT author green tests (that's `write-tests`).

---

## Phase 0 — Resolve input

Accepted argument shapes:

```
Skill(skill: "test-driven-development", args: "step: STEP_04_TASK_01; feat dir: docs/browzer/feat-<slug>/")
Skill(skill: "test-driven-development", args: "task: TASK_03; feat dir: docs/browzer/feat-<slug>/")
```

Bind `FEAT_DIR` and `WORKFLOW="$FEAT_DIR/workflow.json"`. Derive `STEP_ID` from args (by `stepId` or by `taskId` lookup):

```bash
STEP_ID=$(jq -r --arg tid "TASK_01" '.steps[] | select(.taskId==$tid) | .stepId' "$WORKFLOW")
```

If no such step exists or the step's `.task.reviewer.tddDecision.applicable != true`, emit:

```
test-driven-development: stopped at <step or resolution> — TDD not applicable per task.reviewer; no red tests authored
hint: run write-tests instead (green path)
```

and return.

## Phase 1 — Read test specs

```bash
RED_SPECS=$(jq --arg id "$STEP_ID" \
  '.steps[] | select(.stepId==$id) | .task.reviewer.testSpecs[] | select(.type=="red")' \
  "$WORKFLOW")
```

If `RED_SPECS` is empty, emit:

```
test-driven-development: stopped at $STEP_ID — task.reviewer.testSpecs has no type=red entries
hint: check generate-task Reviewer output; maybe TDD was declared applicable but no red specs were emitted
```

and return.

Also read the task's scope + invariants for context:

```bash
SCOPE=$(jq --arg id "$STEP_ID" '.steps[] | select(.stepId==$id) | .task.scope' "$WORKFLOW")
INVARIANTS=$(jq --arg id "$STEP_ID" '.steps[] | select(.stepId==$id) | .task.invariants' "$WORKFLOW")
```

## Phase 2 — Write red tests

For each spec entry:

1. If the target `file` already exists: add test cases matching the `description` and `coverageTarget` using the existing runner's conventions (vitest `describe/it`, pytest `def test_*`, go `TestXxx`, etc.). Do NOT modify unrelated cases.
2. If the target `file` does not exist: create it with the minimal scaffolding the runner requires (imports, boilerplate) plus the test cases.

Conventions to follow (detected from `package.json` / `pyproject.toml` / `go.mod`):

- **JS/TS**: vitest (preferred) or jest. Use `describe` + `it` + `expect`. Follow existing test files' import style.
- **Python**: pytest. Use `def test_*` + `assert`. Follow existing fixtures.
- **Go**: `TestXxx(t *testing.T)` with `t.Fatalf` / subtests.
- **Rust**: `#[test]` + `assert!` / `assert_eq!`.

**Anchor by content match**, not line number, when the task step's sibling tasks already ran in this session and may have shifted line refs in the target file.

Do NOT write implementation code. Do NOT write green tests. Do NOT modify code under `task.scope` that isn't a test file.

## Phase 3 — Verify red

Run the scoped test command for the owning package. Discover it from `package.json` / `pyproject.toml` / `go.mod`. Typical shapes:

```bash
# Monorepo (pnpm turbo):
pnpm --filter=<pkg> test -- <test-file>

# Python:
pytest path/to/test_file.py -v

# Go:
cd <module-dir> && go test ./<pkg>/... -run <TestName> -v
```

For each newly authored test, confirm the result is one of:

- **Failing for the right reason** — e.g. function not defined, assertion mismatch, module missing. This is the expected red state.
- **Failing for a wrong reason** — e.g. syntax error, fixture missing, unrelated import error. STOP: fix the authoring bug and re-run before handing off.
- **Passing** — the test was poorly written (tautology, always-true) or targets existing behavior. STOP: strengthen the assertion until it fails.

Never claim "red verified" unless every newly authored test has failed against the current codebase for the expected reason.

## Phase 4 — Update workflow.json

Append / update the test-specialist agent entry on the task step's `.task.execution.agents[]`. If `.task.execution` does not yet exist, create it with an empty scaffold plus this agent.

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AGENT=$(jq -n \
  --arg now "$NOW" \
  --argjson filesAuthored '<array of test file paths>' \
  --argjson redCount '<number of red tests authored>' \
  '{
     role: "test-specialist",
     skill: "test-driven-development",
     model: env.AGENT_MODEL // "sonnet",
     status: "completed",
     startedAt: $now,
     completedAt: $now,
     notes: ("\($redCount) red tests authored in " + ($filesAuthored | join(", ")) + "; all failing as expected")
   }')

jq --arg id "$STEP_ID" \
   --argjson agent "$AGENT" \
   --arg now "$NOW" \
   '(.steps[] | select(.stepId==$id)) |= (
      .task.execution = ((.task.execution // {}) + {
        agents: (((.task.execution.agents // []) | map(select(.role != "test-specialist"))) + [$agent])
      })
    )
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

The domain-specialist agents that `execute-task` dispatches next will aggregate their own entries into `.task.execution.agents[]` alongside yours.

## Phase 5 — Completion (one line)

On success:

```
test-driven-development: red tests authored in <file1>, <file2>; all failing as expected
```

On failure:

```
test-driven-development: stopped at $STEP_ID — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output**: test bodies, assertion text, run logs. The JSON on disk is the artefact; the chat line is the cursor.

## Non-negotiables

- **Output language: English.** JSON payload + chat line in English regardless of operator's language.
- No implementation code. No green tests.
- No "red verified" claim without running the scoped test command and seeing the failure.
- `workflow.json` is mutated ONLY via `jq | mv`.

## Related skills

- `execute-task` — dispatches this skill via its test-specialist agent for TDD-applicable tasks.
- `write-tests` — green-phase counterpart; invoked after implementation lands OR (for non-TDD tasks) at end of domain-specialist scope.
- `generate-task` — Reviewer pass authors the `testSpecs` this skill executes against.
- `../../references/workflow-schema.md` — authoritative schema for `task.reviewer.testSpecs` and `task.execution.agents`.
- `superpowers:test-driven-development` — lineage reference; not invoked at runtime.
