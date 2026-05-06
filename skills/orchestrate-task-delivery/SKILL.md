---
name: orchestrate-task-delivery
description: "Master orchestrator for any feature, bugfix, or refactor that touches more than a few files in a Browzer-indexed repo. Drives the full pipeline: brainstorming (when vague) → PRD → task plan → execute → code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit. Grounds decisions in `browzer explore`/`search`/`deps`; delegates all implementation to specialist subagents. Mid-workflow entry also welcome ('execute TASK_03', 'update the docs', 'commit what I staged'). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, 'let's start'."
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(jq *), Bash(mv *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Read, Write, Edit, AskUserQuestion, Agent
mutates:
  - path: config
    requires: [setAt]
---

# orchestrate-task-delivery — driver for the workflow pipeline

You orchestrate. You do not implement. Your job is **route → ground context → invoke the next skill → validate shape → move to the next phase**. Every phase writes a step to `docs/browzer/<feat>/workflow.json`; you read via `jq`, never `Read`.

`workflow.json` is the single source of truth. Skills chain without pause in `autonomous` mode and gate between phases in `review` mode.

Output contract: emit ONE confirmation line on success. One confirmation line at end-of-chain.

## References router

| Reference | Load when |
|-----------|-----------|
| `references/pipeline-phases.md` | **Load FIRST** before any `browzer workflow *` invocation — contains the literal copy-paste cheat-sheet for every workflow verb (init, set-config, append-step, complete-step, set-status, get-step, patch, …) plus the daemon warm-up snippet. Also covers each pipeline phase (Phase 0–9), Step 4 output validation, Step 6 stop conditions, Step 7 completion/elapsed-time backfill, and the Phase 9 closure narrative. |
| `references/parallel-dispatch.md` | `tasksManifest.parallelizable[][]` fires, or `receiving-code-review` dispatches across disjoint-file groups. Contains the worktree rendezvous 4-step protocol and parallel heuristic table. |
| `references/mode-contract.md` | Resolving mode behaviour (autonomous vs review loop contract), auditing chat output between phases, or enforcing the inter-step narration rules. Also covers Step 0.1 mode-acknowledge line. |
| `references/workflow-schema.md` | Any jq filter against `workflow.json` — authoritative schema. Read FIRST before any jq op. Also covers `.config.testExecutionDepth` (set by Step 2.7) consumed by code-review's regression-tester and feature-acceptance's execution-required AC gate. |
| `references/subagent-preamble.md` | Paste into every dispatched agent's prompt. |
| `references/dispatch-warmup.md` | Pre-pipeline operational warmup: Step 0.2 daemon pre-warm + health-check, Step 0.5 dependency install, Step 2.5 per-feature cache pre-warm. Best-effort, bounded. Load before each Step block fires. |
| `references/config-resolution.md` | Step 2.6 execution-strategy + Step 2.7 test-execution depth resolution. Decision logic, `AskUserQuestion` templates, persistence verbs, downstream consumers. Load before Phase 3 dispatch (executionStrategy) and before Phase 4 / Phase 8 (testExecutionDepth). |
| `references/agent-dispatch-contract.md` | Verbatim Agent prompt template + return contract + Agent-internal guardrails for autonomous-mode phase dispatch in §Step 3. Load before the FIRST `Agent(...)` dispatch in the loop; reuse for every subsequent iteration. |

**Skill-internal pointers (no separate reference file):**

- Step 0.1 mode-acknowledge → SKILL.md §"Step 0.1 — Mode acknowledge (autonomous only)"

## Step 0 — Mode resolution (autonomous vs review)

> **Batch with Step 2.6 + Step 2.7 prompts.** Three operator-config values are resolved at orchestrator entry: `mode` (here), `executionStrategy` (Step 2.6), `testExecutionDepth` (Step 2.7). When two or more are unresolved (no explicit invocation arg, no inherited value in `workflow.json`), fire **a single `AskUserQuestion` call with up to three parallel questions** instead of three serialized prompts. Probe `TEAMS_FLAG` (Step 2.6 §2) and integration/e2e presence (Step 2.7 heuristic) BEFORE the `AskUserQuestion` so the question payload is conditionally shaped — omit `executionStrategy` option (c) when `TEAMS_FLAG != "1"`, omit `testExecutionDepth` entirely on unit-tests-only repos. Persistence still happens at the matching step (`set-config mode` here, `set-config executionStrategy` at Step 2.6, `set-config testExecutionDepth` at Step 2.7) — those steps SKIP their own `AskUserQuestion` when the answer was already captured by the batched prompt.

Resolve `config.mode` before anything else. Order:

1. **Explicit in invocation args** — `Skill(orchestrate-task-delivery, "mode: autonomous; <rest>")` or `mode: review`. Take it verbatim.
2. **Inherited from workflow.json** — if `$FEAT_DIR/workflow.json` exists and `.config.mode` is set, keep it.
3. **Terminal prompt** — bundle into the batched `AskUserQuestion` (see callout above) when other config values are also unresolved; otherwise fire alone:

   ```
   Question header: "Mode"
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

### Step 0.2 — Daemon pre-warm + health-check (best-effort, non-blocking)

Pre-warm the Browzer daemon BEFORE the first `browzer workflow *` call so the JSON-RPC fast path is hit instead of fallback-sync (which pollutes stderr with `mode=fallback-sync reason=daemon_unreachable`). Best-effort, bounded by `sleep 0.5`. Full snippet (status probe → conditional restart on stale handshake → fail-open warning) and the rationale for not exporting `BROWZER_LLM=1` here live in **`references/dispatch-warmup.md §Step 0.2`** — load that ref before this step.

## Step 0.5 — Dependency install first-action (one-time)

If the target repo has a manifest+lockfile pair AND `node_modules/` is absent or the lockfile cache is stale, pay the install cost once at orchestrator entry. A 35s pnpm install up-front kills the class of `deferred-typecheck` / "workspace dep unresolved" findings that otherwise pollute every downstream code-review.

Detection block (Node/pnpm, npm, yarn, bun; Python/poetry, uv; Go) + failure-mode stop hint in **`references/dispatch-warmup.md §Step 0.5`** (which itself points at `references/pipeline-phases.md §Phase 0.5` for per-package-manager detection details). For repos with no Node/Python/Go manifest detected, this step is a no-op.

## Step 1 — Initialize feat dir + workflow.json

Use the canonical literal invocation (full flag surface). For the complete copy-paste cheat-sheet of every `browzer workflow` verb, **load `references/pipeline-phases.md` FIRST**.

```bash
FEAT_DIR="docs/browzer/feat-$(date -u +%Y%m%d)-<slug>"
mkdir -p "$FEAT_DIR"
WORKFLOW="$FEAT_DIR/workflow.json"

browzer workflow init --await --workflow "$WORKFLOW" \
  --feature-id   "feat-$(date -u +%Y%m%d)-<slug>" \
  --feature-name "<human-readable feature label>" \
  --operator-locale "<en-US|pt-BR>" \
  --original-request "<operator's verbatim ask>"
```

`browzer workflow init` derives `featDir` from the `--workflow` parent directory; do NOT pass a `--feat-dir` flag (it does not exist). Pass `--force` to overwrite an existing seed (default behaviour: exit non-zero with `already_exists`). Required top-level fields are populated automatically per the v2 schema (`packages/cli/schemas/workflow-v1.cue`): `schemaVersion: 2`, `pluginVersion`, `currentStepId: ""`, `nextStepId: ""`, RFC3339 `startedAt`/`updatedAt`, empty arrays for `notes`/`globalWarnings`/`steps`. The CUE validator rejects `null` for `currentStepId`/`nextStepId` — they MUST be empty strings.

On entry, clean up any partial writes: `find "$FEAT_DIR" -name 'workflow.json.tmp' -delete`. If `$WORKFLOW` itself is malformed (`jq empty "$WORKFLOW"` returns non-zero), STOP with hint `jq empty workflow.json to validate`.

## Step 2 — Browzer context (cap 3-4 content queries)

```bash
browzer status --json
browzer explore "<one noun from operator request>" --json --save /tmp/orch-explore.json
browzer search "<topic>" --json --save /tmp/orch-search.json
```

Cap at 3-4 total content queries. If the index is stale, surface one line and proceed: `⚠ Browzer index is N commits behind HEAD. Recommended: browzer sync. Continuing — outputs may reflect stale reality.`

### Step 2.5 — Pre-warm per-feature cache

After the Browzer queries, prime the per-feature jq cache (task order + parallelizable groups) so the first Phase 3 dispatch isn't cold. Snippet in **`references/dispatch-warmup.md §Step 2.5`**. Best-effort — skip silently if no prior task manifest exists.

### Step 2.6 — Execution-strategy resolution (mandatory before Phase 3 + Phase 5)

Resolve `config.executionStrategy` — one of `serial | parallel-worktrees | agent-teams` — exactly once per workflow and persist via `browzer workflow set-config --await executionStrategy`. The resolution probes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` and routes Phase 3 dispatch on the chosen value:

- `serial` → `execute-task` once per TASK step.
- `parallel-worktrees` → `references/parallel-dispatch.md` (N `Agent(...)` in one turn).
- `agent-teams` → `execute-with-teams` (single Skill call; team spawned internally).

**NEVER append a workflow step named EXECUTION_STRATEGY** — config, not a step. Full resolution order, prompt template, and TEAMS_FLAG probe in **`references/config-resolution.md §Step 2.6`**.

When the answer was already captured by the Step 0 batched `AskUserQuestion` (mode + executionStrategy + testExecutionDepth in one round-trip), this step SKIPS the prompt and only persists the captured value.

### Step 2.7 — Test-execution depth resolution (mandatory before Phase 4 + Phase 8)

Resolve `config.testExecutionDepth` — one of `static-only | scoped-execute | full-rehearse` — exactly once. Read by `code-review`'s regression-tester (Phase 5.1) and `feature-acceptance`'s live-verify (Phase 2.6.2) to decide whether integration/e2e suites run locally or are deferred to CI. Repos with only unit tests skip the prompt and default to `static-only`. Full heuristic + bash detection block in **`references/config-resolution.md §Step 2.7`**.

When batched with Step 0, SKIPS the prompt and persists the captured value.

## Step 3 — Pipeline loop

The pipeline is an **explicit loop in this skill body** — read next-pending phase from `workflow.json`, dispatch its skill, loop until done. The loop body IS the controller. There is no `Stop`-hook forcing function — earlier revisions of this skill chained via "fire `Skill(<next>)` in the same response turn" + a `Stop` hook (`orchestrator-autochain.py`) that blocked premature stops. The chain was empirically frail (long skill bodies pushed the model to emit a phase-end cursor and stop, expecting operator continuation), and the hook was a workaround. The loop makes the chain self-evident, so no forcing function is needed.

### Dispatch primitive depends on `config.mode`

| `config.mode` | Dispatch primitive       | Why |
| ------------- | ------------------------ | --- |
| `autonomous`  | `Agent(...)` per phase   | Each phase runs in an **isolated subagent context**. The orchestrator's main thread sees only a 1-line cursor per phase (cumulative ~30k tokens) instead of the full Skill body + tool_result from each phase (which historically pushed the orchestrator to ~180k+ tokens by Phase 9 and triggered context compaction). Operator is not watching, so the interactive UX cost is zero. |
| `review`      | `Skill(<phase>)` per phase | Review-candidate skills (brainstorming, generate-prd, generate-task, update-docs, commit; hybrid: code-review, feature-acceptance) render `.md` and gate on operator approval in the **main session**. Agent dispatch breaks that surface (the operator can't approve `.md` rendered inside an isolated subagent). Token economy is sacrificed to keep the interactive UX. |

`config.mode` is resolved exactly once at Step 0 and frozen for the rest of the pipeline. The dispatch primitive is decided per iteration based on that resolution. A mid-flow mode switch (`config.switchedFrom`) toggles the primitive on the next iteration.

### Phases

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

### Loop body — each iteration

1. **Read next-pending phase** from `workflow.json`. The next phase is the first canonical pipeline ID (per the table above) for which no terminal-status step exists yet — i.e. no entry in `.steps[]` whose `name` matches and whose `status` is one of `{COMPLETED, SKIPPED, STOPPED, FAILED}`. Use `browzer workflow query next-pending --workflow "$WORKFLOW"` (or a `jq` filter against `.steps[]` for a richer view).
2. **Exit if done**: when the previous step is `COMMIT` with `status: COMPLETED` (or there is genuinely no remaining phase), emit the terminal cursor and stop:

   ```
   orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>
   ```
3. **Dispatch the next phase** in the SAME response turn that read next-pending. Branch on `config.mode`:

   - **`autonomous`** — dispatch via `Agent(...)`:

     ```
     export BROWZER_WORKFLOW_STEP_ID="<currentStepId>"
     export BROWZER_DISPATCH_AGENT_ID="<unique-agent-id>"

     Agent(
       subagent_type: "general-purpose",
       prompt: <see "Agent dispatch contract — autonomous mode" below>
     )

     unset BROWZER_WORKFLOW_STEP_ID
     unset BROWZER_DISPATCH_AGENT_ID
     ```

   - **`review`** — dispatch via `Skill(...)`:

     ```
     Skill(<phase-skill-name>)
     ```

4. **After the dispatch returns** its tool_result, iterate: read next-pending again from `workflow.json`, dispatch the next phase. Loop in the same response turn until exit conditions fire.

### Agent dispatch contract — autonomous mode

When `config.mode == "autonomous"`, every phase is dispatched via `Agent(general-purpose, …)`. The verbatim prompt template (with `<PHASE_NUMBER>`, `<PHASE_NAME>`, `<phase-skill-name>`, absolute `WORKFLOW` path placeholders), the tight return contract (`<phase-skill-name>: stepId=<id>; status=<...>` — one line, no re-citation), and the Agent-internal guardrails (no recursive `Skill(orchestrate-task-delivery)`, no mode mutation, no parallel sub-Agents unless the loaded skill explicitly does so) live in **`references/agent-dispatch-contract.md`**.

Load that ref before the FIRST Agent dispatch in the loop; cache and reuse for every subsequent iteration in the same run — the template is identical across phases, only the placeholders differ.

### Stop conditions (loop exits before all phases complete)

- Phase returns `status: PAUSED_PENDING_OPERATOR` → emit pause cursor + summary of `operatorActionsRequested`, exit. Operator's next message resumes the loop (the loop re-reads next-pending and resumes from the paused step).
- Phase returns `status: FAILED` → emit failure cursor + hint, exit.
- `config.mode == "review"` AND a review-candidate phase enters `AWAITING_REVIEW` → the skill (invoked via `Skill(...)`) owns its review gate in the main session; the loop waits for the skill to flip to COMPLETED (or STOPPED) before iterating.

Load `references/mode-contract.md` for the full autonomous vs review loop contract and the inter-step narration rules.

### Step 3.1 — Dispatch env-var contract

Before every `Agent(...)` dispatch in this orchestrator (top-level phase dispatch in `config.mode == autonomous` per §Step 3 above; sub-Agent dispatches inside specific phases — Phase 3 TASK execution, Phase 4 code-review's regressioner, Phase 5 receiving-code-review's per-finding fix agents, Phase 6 write-tests, Phase 7 update-docs, Phase 8 feature-acceptance), export TWO env vars so `.claude/hooks/langfuse_hook.py` (WF-HOOK-1) can stamp Langfuse traces with the correlation IDs:

```bash
export BROWZER_WORKFLOW_STEP_ID="<currentStepId>"
export BROWZER_DISPATCH_AGENT_ID="<unique-agent-id>"
# … run the Agent dispatch …
# F-04 (2026-05-04): explicit unset is REQUIRED. Skipping it leaks
# STEP_ID/AGENT_ID into the next dispatch in the same shell, which
# inflates per-step Langfuse score aggregates.
unset BROWZER_WORKFLOW_STEP_ID
unset BROWZER_DISPATCH_AGENT_ID
```

Both vars MUST be set BEFORE the Agent call AND unset AFTER it returns. The unset block is not optional — leaving the vars set causes Langfuse traces for the NEXT dispatch (which may be a different step entirely) to inherit the previous correlation IDs, producing spurious `step:` / `agent:` tags and inflating per-step scores.

## Operator discipline (load `references/operator-discipline.md` for full detail)

Five orthogonal rules — each one a contract violation when broken:

- **Multi-tool-call batching** — issue independent tool calls in the **same response block**; never serialize what can be parallel. Heuristic table in `references/pipeline-phases.md` §4.
- **Subagent output handling: refs only** — never re-cite a subagent body in the main thread; pass a stepId reference and let downstream skills read via `browzer workflow get-step --field --save`. Re-citation > 200 chars is a violation.
- **Inter-tool narration ban (ZERO narration)** — no chat text between two `tool_use` blocks of the same response. Self-enforced as part of the loop body in §Step 3.
- **Schema lookup cache** — `browzer workflow describe-step-type <NAME> --json --save /tmp/<name>-schema.json` once per step-type per session; never re-grep `references/workflow-schema.md` for the same shape. 10+ schema greps in one session is a smell.
- **Path discipline (CWD persists)** — every Bash call inherits the prior call's CWD. Use absolute paths in `WORKFLOW=...` bindings and every `--workflow` flag, OR scope `cd` changes to a subshell `( cd <subdir> && <cmd> )`. A leaked `cd` surfaces as a `lock timeout: another browzer workflow command is mutating ...` on a path you don't recognise — see `references/pipeline-phases.md §"Path discipline"`.

Banned dispatch-prompt patterns + tool-usage discipline (`workflow.json` mutation, parallel dispatch, subagent preamble, browzer-first, jq-helpers) all live in the same reference doc.

## Non-negotiables

- **Output language: English.** All workflow.json fields in English. Conversational wrapper follows operator's language.
- No application code. You are the orchestrator.
- No silent skips of phases. If a phase is genuinely n/a, record it with `status: SKIPPED` and `applicability.applicable: false`.
- No inline gate-failure fixes. Dispatch a fix agent via `receiving-code-review`.
- No parallel edits of the same file without worktree isolation.
- `commit` is the last phase. Don't chain to `sync-workspace`.

## Invocation modes

- **Direct feature request** — "add X", "implement Y", "build Z". Route through Step 0 mode prompt → Phase 0/1/2/… in order.
- **Mid-flow entry** — "execute TASK_03", "update the docs", "commit what I staged". Resolve `FEAT_DIR` from context, jump to the named phase. Inherit `config.mode` from workflow.json.
- **Quality-only rerun** — "re-run code-review after iteration". Invoke the named phase standalone; each skill re-enters and writes a new step.
