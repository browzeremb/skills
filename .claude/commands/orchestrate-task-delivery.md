---
name: orchestrate-task-delivery
description: "Master orchestrator for any feature, bugfix, or refactor that touches more than a few files in a Browzer-indexed repo. Drives the full pipeline: brainstorming (when vague) → PRD → task plan → execute → code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit. Grounds decisions in `browzer explore`/`search`/`deps`; delegates all implementation to specialist subagents. Mid-workflow entry also welcome ('execute TASK_03', 'update the docs', 'commit what I staged'). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, 'let's start'."
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(jq *), Bash(mv *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Read, Write, Edit, AskUserQuestion, Agent
---

# orchestrate-task-delivery — driver for the workflow pipeline

You orchestrate. You do not implement. Your job is **route → ground context → invoke the next skill → validate shape → move to the next phase**. Every phase writes a step to `docs/browzer/<feat>/workflow.json`; you read via `jq`, never `Read`.

`workflow.json` is the single source of truth. Skills chain without pause in `autonomous` mode and gate between phases in `review` mode.

Output contract: emit ONE confirmation line on success. One confirmation line at end-of-chain.

---

## References router

| Reference | Load when |
|-----------|-----------|
| `references/pipeline-phases.md` | Executing or validating any specific pipeline phase (Phase 0–9), Step 4 output validation, Step 6 stop conditions, Step 7 completion/elapsed-time backfill, or the Phase 9 closure narrative (in-scope vs out-of-scope states). |
| `references/parallel-dispatch.md` | `tasksManifest.parallelizable[][]` fires, or `receiving-code-review` dispatches across disjoint-file groups. Contains the worktree rendezvous 4-step protocol and parallel heuristic table. |
| `references/mode-contract.md` | Resolving mode behaviour (autonomous vs review chain contract), auditing chat output between phases, or enforcing the inter-step narration rules including Step 4.0.5. Also covers Step 0.1 mode-acknowledge line. |
| `references/workflow-schema.md` | Any jq filter against `workflow.json` — authoritative schema. Read FIRST before any jq op. Also covers `.config.testExecutionDepth` (set by Step 2.7) consumed by code-review's regression-tester and feature-acceptance's execution-required AC gate. |
| `references/subagent-preamble.md` | Paste into every dispatched agent's prompt. |
| `references/worktree-rendezvous.md` | Full worktree rendezvous snippets, owner-string conventions, and failure-mode table (alternative to `references/parallel-dispatch.md`). |

**Skill-internal pointers (no separate reference file):**

- Step 0.1 mode-acknowledge → SKILL.md §"Step 0.1 — Mode acknowledge (autonomous only)"
- Step 2.6 execution-strategy → SKILL.md §"Step 2.6 — Execution-strategy resolution"
- Step 2.7 test-execution-depth → SKILL.md §"Step 2.7 — Test-execution depth resolution"

---

## Step 0 — Mode resolution (autonomous vs review)

Resolve `config.mode` before anything else. Order:

1. **Explicit in invocation args** — `Skill(orchestrate-task-delivery, "mode: autonomous; <rest>")` or `mode: review`. Take it verbatim.
2. **Inherited from workflow.json** — if `$FEAT_DIR/workflow.json` exists and `.config.mode` is set, keep it.
3. **Terminal prompt** — `AskUserQuestion`:

   ```
   Before proceeding:
     (a) autonomous — skills chain with no pauses, no .md generated
     (b) review — gate between skills; you approve/adjust each output
   ```

`config.mode` is a **hard contract**, not a heuristic. Continuation phrases ("prossiga", "continue", "next", "go ahead", "ok") MUST NOT be interpreted as a mode signal. The mode is set EXACTLY ONCE at orchestrator entry (or inherited) and then frozen for the rest of the pipeline.

Write the resolved value immediately:

```bash
browzer workflow set-config --await mode "$MODE" --workflow "$WORKFLOW"
browzer workflow set-config --await setAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --workflow "$WORKFLOW"
```

### Step 0.1 — Mode acknowledge (autonomous only)

When `MODE == autonomous`, emit ONE acknowledge line BEFORE chaining to Step 1. This avoids
the post-run audit-trail confusion where empty `reviewHistory[]` arrays look like a bug
("did the operator never review anything?") when in fact the operator opted out of mid-flow
review at orchestrator entry. The acknowledge is informational, not a prompt — do NOT block
on it.

```
orchestrate-task-delivery: mode=autonomous; reviewHistory[] will remain empty by design — switch via explicit operator interrupt
```

When `MODE == review`, no acknowledge is needed — the operator will see the per-step gates
and the `reviewHistory[]` entries will populate naturally.

---

## Step 1 — Initialize feat dir + workflow.json

```bash
FEAT_DIR="docs/browzer/feat-$(date -u +%Y%m%d)-<slug>"
mkdir -p "$FEAT_DIR"
WORKFLOW="$FEAT_DIR/workflow.json"
```

If `$WORKFLOW` does not exist, seed the v1 top-level skeleton per `references/workflow-schema.md` §2. Required top-level fields: `schemaVersion: 1`, `featureId`, `featureName`, `featDir`, `originalRequest`, `operator`, `config`, `startedAt`, `updatedAt`, `totalElapsedMin: 0`, `currentStepId: null`, `nextStepId: null`, `totalSteps: 0`, `completedSteps: 0`, `notes: []`, `globalWarnings: []`, `steps: []`.

On entry, clean up any partial writes: `find "$FEAT_DIR" -name 'workflow.json.tmp' -delete`. If `$WORKFLOW` itself is malformed (`jq empty "$WORKFLOW"` returns non-zero), STOP with hint `jq empty workflow.json to validate`.

---

## Step 2 — Browzer context (cap 3-4 content queries)

```bash
browzer status --json
browzer explore "<one noun from operator request>" --json --save /tmp/orch-explore.json
browzer search "<topic>" --json --save /tmp/orch-search.json
```

Cap at 3-4 total content queries. If the index is stale, surface one line and proceed: `⚠ Browzer index is N commits behind HEAD. Recommended: browzer sync. Continuing — outputs may reflect stale reality.`

### Step 2.5 — Pre-warm per-feature cache

After the Browzer queries, pre-warm the per-feature cache by reading the task manifest (if it exists from a prior run) and priming key jq paths. This avoids cold-cache latency on the first Phase 3 dispatch:

```bash
if jq -e '.steps[] | select(.name=="TASKS_MANIFEST")' "$WORKFLOW" > /dev/null 2>&1; then
  # warm: task order + parallelizable groups + domain partition
  jq -r '.steps[] | select(.name=="TASKS_MANIFEST") | .tasksManifest.tasksOrder[]' "$WORKFLOW" > /tmp/orch-task-order.txt
  jq -c '.steps[] | select(.name=="TASKS_MANIFEST") | .tasksManifest.parallelizable' "$WORKFLOW" > /tmp/orch-parallel.json
fi
```

### Step 2.6 — Execution-strategy resolution (mandatory before Phase 3 + Phase 5)

The execution strategy is resolved exactly once per workflow and persisted at `config.executionStrategy`. **NEVER append a workflow step named EXECUTION_STRATEGY** — `workflow-schema.md §3` rejects that name. The strategy is config, not a step.

Resolve in this order:

1. **Inherited** — if `jq -r '.config.executionStrategy' "$WORKFLOW"` is non-null, keep it.
2. **Probe the agent-teams flag**:

   ```bash
   TEAMS_FLAG=$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' ~/.claude/settings.json 2>/dev/null)
   ```

3. **Prompt the operator before Phase 3 dispatch** — fires regardless of `config.mode` (the strategy is an operational/cost decision, not a flow decision):

   ```
   AskUserQuestion (header: "Execution"):
     How should TASK steps execute?
       (a) serial               — one task at a time, no isolation
       (b) parallel-worktrees   — disjoint-file groups in git worktrees, N agents in one turn
       (c) agent-teams          — Claude Code Agent Teams (round-table dialogue)  [only when TEAMS_FLAG=="1"]
   ```

   When `TEAMS_FLAG != "1"`, omit option (c). The choice in `code-review` Phase 3 (parallel-with-consolidator vs agent-teams) is a SEPARATE prompt with its own surface — both fire when teams is enabled.

4. **Persist** the chosen value:

   ```bash
   browzer workflow set-config --await executionStrategy "$STRATEGY" --workflow "$WORKFLOW"
   ```

5. **Route Phase 3** dispatch on the value:
   - `serial` → invoke `execute-task` once per TASK step in tasksOrder.
   - `parallel-worktrees` → follow `references/parallel-dispatch.md` (N `Agent(...)` calls in one turn).
   - `agent-teams` → invoke `execute-with-teams` (single Skill call; the skill spawns the team).

If the flag is unset and the operator answer is freeform (e.g. "do whatever's fastest"), normalize to `serial` and record under `.config.executionStrategyNote`.

### Step 2.7 — Test-execution depth resolution (mandatory before Phase 4 + Phase 8)

The test-execution depth is the second config field that downstream skills (`code-review`'s
regression-tester, `feature-acceptance`'s execution-required AC gate) read to decide whether
to actually run integration / e2e suites or treat them as out-of-scope for the orchestrator
turn. Resolving it once here keeps each downstream skill from re-prompting and avoids the
"skills declared COMPLETED but CI surfaces 6 follow-up bugs" failure mode.

**Heuristic — only fire when the repo HAS integration / e2e suites.** Skip the prompt
entirely on repos with unit-tests only — there's nothing the depth field would change.

```bash
# Detect integration / e2e test files in the repo (cap depth + count for speed)
HAS_INTEGRATION=$(find . -type f \( -name '*.integration.test.*' -o -name '*.integration.spec.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)
HAS_E2E=$(find . -type f \( -name '*.e2e.test.*' -o -name '*.e2e.spec.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)

if [ -z "$HAS_INTEGRATION" ] && [ -z "$HAS_E2E" ]; then
  # Repo has only unit tests; default and skip prompt
  browzer workflow set-config --await testExecutionDepth "static-only" --workflow "$WORKFLOW"
  browzer workflow set-config --await testExecutionDepthAuto "true" --workflow "$WORKFLOW"
else
  # Resolve via inheritance → prompt
  CURRENT=$(jq -r '.config.testExecutionDepth // empty' "$WORKFLOW")
  if [ -z "$CURRENT" ]; then
    AskUserQuestion (header: "Test-exec depth"):
      How deep should code-review and feature-acceptance run tests?
        (a) static-only       — lint + typecheck + unit only (fastest; CI catches the rest)
        (b) scoped-execute    — also run integration/e2e suites for newly added test files
        (c) full-rehearse     — run the entire test pipeline (lint + typecheck + unit + integration + e2e)
    browzer workflow set-config --await testExecutionDepth "$DEPTH" --workflow "$WORKFLOW"
    browzer workflow set-config --await testExecutionDepthAuto "false" --workflow "$WORKFLOW"
  fi
fi
```

The chosen value is read by:
- `code-review/references/regression-tester.md §Phase 5.1` to decide whether to augment the
  gate command with `pnpm test:integration` / `pnpm test:e2e`.
- `feature-acceptance/references/live-verify.md §Phase 2.6.2` to decide whether
  execution-required ACs can be locally verified or must defer with `kind: blocks-commit`.

The autonomous-mode auto-default is `static-only` (matches the historical baseline). The
prompt only fires in interactive sessions where the repo actually has integration / e2e
suites that would be skipped under static-only.

---

## Step 3 — Pipeline

Phases run in this order. Each writes a step to `workflow.json`. See `references/pipeline-phases.md` for detailed phase logic.

| # | Step name | Skill | Parallel? |
| - | --------- | ----- | --------- |
| 0 | BRAINSTORMING (optional) | `brainstorming` | no |
| 1 | PRD | `generate-prd` | no |
| 2 | TASKS_MANIFEST + N × TASK | `generate-task` | no |
| — | (execution strategy lives in `config.executionStrategy`; never a step) | resolved per Step 2.6 | n/a |
| 3 | TASK execution | `execute-task` (serial / parallel-worktrees) or `execute-with-teams` (agent-teams) | depends on `config.executionStrategy` |
| 4 | CODE_REVIEW | `code-review` | no |
| 5 | RECEIVING_CODE_REVIEW | `receiving-code-review` | sequential per finding-group |
| 6 | WRITE_TESTS | `write-tests` (serial) or SKIPPED (agent-teams) | no |
| 7 | UPDATE_DOCS | `update-docs` | no |
| 8 | FEATURE_ACCEPTANCE | `feature-acceptance` | no |
| 9 | COMMIT | `commit` | no |

**Chain contract.** After each skill's tool_result, immediately invoke the next phase's `Skill(...)` in the same response turn, unless a stop condition fires. Quote-then-`Skill(...)` in one response is the pattern; quote-alone is the anti-pattern.

Load `references/mode-contract.md` for the full autonomous vs review chain contract, inter-step narration rules, and Step 4.0.5 narration audit.

---

## Banned dispatch-prompt patterns

These patterns in any response between phases are contract violations:

- Asking the operator "should I proceed?" / "ready for the next phase?" in autonomous mode.
- Emitting a multi-bullet "summary of what was just done" before launching the next Skill call.
- Printing a tasks table, HANDOFF quote, subagent transcript, or "Next steps" block.
- Re-printing file counts, finding counts, or AC IDs the operator can read from workflow.json.
- Announcing "N parallel agents" without emitting N literal `Agent(...)` calls in the same message.

---

## Tool usage discipline

- **`workflow.json` mutation**: ALWAYS `browzer workflow *` CLI subcommands (or `browzer workflow patch --jq` for arbitrary mutations). NEVER `Read` / `Write` / `Edit` on `workflow.json`.
- **Parallel dispatch**: literal — N `Task(...)` or `Agent(...)` calls in a single response turn. See `references/parallel-dispatch.md`.
- **Subagent preamble**: paste `references/subagent-preamble.md` §Step 1-5 verbatim into every dispatched agent's prompt.
- **Browzer first**: before touching any library/framework/config you didn't author, run `browzer search` → then Context7 if browzer has no coverage.
- **jq helpers**: `source "references/jq-helpers.sh"` for complex cross-step reads.

---

## Non-negotiables

- **Output language: English.** All workflow.json fields in English. Conversational wrapper follows operator's language.
- No application code. You are the orchestrator.
- No silent skips of phases. If a phase is genuinely n/a, record it with `status: SKIPPED` and `applicability.applicable: false`.
- No inline gate-failure fixes. Dispatch a fix agent via `receiving-code-review`.
- No parallel edits of the same file without worktree isolation.
- `commit` is the last phase. Don't chain to `sync-workspace`.

---

## Invocation modes

- **Direct feature request** — "add X", "implement Y", "build Z". Route through Step 0 mode prompt → Phase 0/1/2/… in order.
- **Mid-flow entry** — "execute TASK_03", "update the docs", "commit what I staged". Resolve `FEAT_DIR` from context, jump to the named phase. Inherit `config.mode` from workflow.json.
- **Quality-only rerun** — "re-run code-review after iteration". Invoke the named phase standalone; each skill re-enters and writes a new step.
