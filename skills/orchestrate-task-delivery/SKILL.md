---
name: orchestrate-task-delivery
description: "Master orchestrator for any feature, bugfix, or refactor that touches more than a few files in a Browzer-indexed repo. Drives the full pipeline: brainstorming-when-needed → PRD → task plan → execute → code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit. Grounds decisions in `browzer explore`/`search`/`deps`; delegates all implementation to specialist subagents. Mid-workflow entry also welcome ('execute TASK_03', 'update the docs', 'commit what I staged'). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, 'let's start'."
mutates:
  - path: config
    requires: [setAt]
---

# orchestrate-task-delivery — driver for the workflow pipeline

You orchestrate. You do not implement. Your job is **route → ground context → invoke the next skill → validate shape → move to the next phase**. Every phase writes a step to `docs/browzer/<feat>/workflow.json`; you read via `browzer workflow get-step` / `query`, never via `Read`.

`workflow.json` is the single source of truth. Skills chain without pause in `autonomous` mode and gate between skills in `review` mode.

Output contract: emit ONE confirmation line on success. ONE confirmation line at end-of-chain.

## References router

| Reference | Load when |
|-----------|-----------|
| `references/pipeline-phases.md` | **Load FIRST** before any `browzer workflow *` invocation — copy-paste cheat-sheet for every workflow verb (init, set-config, append-step, complete-step, set-status, get-step, patch, …) plus the daemon warm-up snippet. Also covers each pipeline phase, Step 5 output validation, Step 6 stop conditions, Step 7 completion/elapsed-time backfill, and the closure narrative. |
| `references/mode-contract.md` | Resolving mode behaviour (autonomous vs review loop contract), auditing chat output between phases, or enforcing the inter-step narration rules. Also covers Step 0.1 mode-acknowledge line. |
| `references/workflow-schema.md` | Any jq filter against `workflow.json` — authoritative schema mirror (regenerated from the CUE SSOT). Read FIRST before any jq op. Also covers `.config.testExecutionDepth` consumed by code-review's regression-tester and feature-acceptance's execution-required AC gate. |
| `references/subagent-preamble.md` | Paste into every dispatched agent's prompt. |
| `references/dispatch-warmup.md` | Pre-pipeline operational warmup: daemon pre-warm + health-check, dependency install, per-feature cache pre-warm. Best-effort, bounded. |
| `references/config-resolution.md` | Step 3 `mode` + `testExecutionDepth` resolution. Decision logic, `AskUserQuestion` template, persistence verbs, downstream consumers. Load before Phase 4 (CODE_REVIEW) and Phase 8 (FEATURE_ACCEPTANCE). |
| `references/agent-dispatch-contract.md` | Verbatim Agent prompt template + return contract + Agent-internal guardrails for autonomous-mode phase dispatch. Load before the FIRST `Agent(...)` dispatch in the loop; reuse for every subsequent iteration. |
| `references/brainstorming-detection.md` | Step 0 heuristic + decision flowchart. Load before Step 0 fires. |

## Step 0 — Brainstorming necessity probe

Decide BEFORE anything else whether the operator's input is saturated enough to produce a useful PRD. Saturated → straight to Step 1. Unsaturated → brainstorming required (Step 2).

The full heuristic + flowchart lives in **`references/brainstorming-detection.md`**. Summary: count missing dimensions (persona, success signal, concrete scope, file/endpoint/module reference) plus presence of vague triggers ("what if", "could we", "we need to add", "I'm thinking"). Two missing dimensions OR one vague trigger → `BRAINSTORMING_NEEDED=yes`.

Carry the decision forward as a shell binding. Do NOT persist anything yet — `workflow.json` does not exist at this point.

## Step 1 — Initialize feat dir + workflow.json

For the complete copy-paste cheat-sheet of every `browzer workflow` verb, **load `references/pipeline-phases.md` FIRST**.

`FEAT_DIR` is **always a path relative to the target repo's working directory** — never absolute. The `browzer` CLI walks up from CWD to find the repo root and resolves `docs/browzer/<feat>/workflow.json` against it. Hard-coding an absolute path (`/Users/...`, `/home/...`) leaks the operator's machine layout into the workflow audit trail and breaks portability when other teammates open the same feat dir.

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

`browzer workflow init` derives `featDir` from the `--workflow` parent directory; do NOT pass a `--feat-dir` flag (it does not exist). Pass `--force` to overwrite an existing seed (default behaviour: exit non-zero with `already_exists`). Required top-level fields are populated automatically by the CLI per the CUE SSOT — discover the live shape via `browzer workflow describe-step-type --json` when in doubt.

On entry, clean up any partial writes: `find "$FEAT_DIR" -name 'workflow.json.tmp' -delete`. If `$WORKFLOW` itself is malformed (`browzer workflow validate --workflow "$WORKFLOW"` returns non-zero), STOP with hint `browzer workflow validate to inspect`.

## Step 2 — Brainstorming dispatch (conditional)

Fires only when `BRAINSTORMING_NEEDED=yes` from Step 0. Otherwise this step is a no-op and the loop continues to Step 3.

Brainstorming is dispatched the SAME way as every other phase (Agent in autonomous, Skill in review) — see Step 5 for dispatch primitives. The skill writes a `BRAINSTORMING` step to `workflow.json` and returns a one-line cursor. The next phase (PRD) consumes the brainstorm payload via `browzer workflow get-step <step-id> --field brainstorm --save <path> --quiet`.

**HARD-GATE behaviour**: the `brainstorming` skill requires user approval of the design before proceeding. In `review` mode this gate stays active — the operator approves the design rendered as `.md`. In `autonomous` mode the gate degrades: the design is rendered to chat (one informational message) and the loop proceeds. The mode itself is not yet resolved at this point — Step 3 happens AFTER brainstorming. So in practice: brainstorming runs once, with the gate active, regardless of any future mode the operator picks. The mode toggle only affects the pipeline phases that follow.

## Step 3 — Resolve operator config (mode + testExecutionDepth)

Two `config.*` values are resolved at this step and persisted via `browzer workflow set-config`:

- **`config.mode`** — `autonomous | review`. Controls dispatch primitive for every subsequent phase (Agent vs Skill) and whether review-candidate skills render `.md` + gate. Hard contract — set exactly once and frozen.
- **`config.testExecutionDepth`** — `static-only | scoped-execute | full-rehearse`. Consumed by `code-review`'s regression-tester (Phase 4) and `feature-acceptance`'s live-verify (Phase 8) to decide whether integration/e2e suites run locally or are deferred to CI.

Resolution order for each (applied independently):

1. **Explicit in invocation args** — take verbatim.
2. **Inherited from `workflow.json`** — if `.config.<key>` is set (mid-flow entry), keep it.
3. **Terminal prompt** — single `AskUserQuestion` call when one or both are unresolved. Probe for integration/e2e test presence BEFORE the prompt; omit `testExecutionDepth` entirely when the repo has unit tests only. With both unresolved, fire ONE `AskUserQuestion` with up to two parallel questions (headers: `Mode`, `Test-exec depth`).

The `executionStrategy` config (`serial | parallel | parallel-worktrees | agent-teams`) is NOT resolved here — it is owned by `execute-task` and resolved at Phase 3 dispatch (see `references/config-resolution.md` for the rationale and the capability probe `execute-task` runs).

`config.mode` is a **hard contract**, not a heuristic. Continuation phrases ("prossiga", "continue", "next", "go ahead", "ok") MUST NOT be interpreted as a mode signal.

Write each resolved value:

```bash
browzer workflow set-config --await mode "$MODE" --workflow "$WORKFLOW"
browzer workflow set-config --await testExecutionDepth "$DEPTH" --workflow "$WORKFLOW"
browzer workflow set-config --await setAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --workflow "$WORKFLOW"
```

### Step 3.1 — Mode acknowledge (autonomous only)

When `MODE == autonomous`, emit ONE acknowledge line BEFORE chaining to Step 4. This avoids the post-run audit-trail confusion where empty `reviewHistory[]` arrays look like a bug ("did the operator never review anything?") when in fact the operator opted out of mid-flow review.

```
orchestrate-task-delivery: mode=autonomous; reviewHistory[] will remain empty by design — switch via explicit operator interrupt
```

When `MODE == review`, no acknowledge is needed — the operator will see the per-step gates and the `reviewHistory[]` entries will populate naturally.

### Step 3.2 — Daemon pre-warm + dependency install (best-effort, non-blocking)

Pre-warm the Browzer daemon BEFORE the first `browzer workflow *` mutation so the JSON-RPC fast path is hit instead of fallback-sync. If the target repo has a manifest+lockfile pair AND `node_modules/` is absent or the lockfile cache is stale, pay the install cost once at orchestrator entry — kills the class of `deferred-typecheck` / "workspace dep unresolved" findings that otherwise pollute every downstream code-review.

Full snippets (status probe, conditional restart, per-package-manager detection) live in **`references/dispatch-warmup.md`**. Best-effort, bounded — proceed even if warmup fails (with a one-line warning). For repos with no Node/Python/Go manifest detected, the install step is a no-op.

## Step 4 — Browzer context queries (angle-driven, receipts-first)

These receipts ground both the orchestrator's routing decisions AND every dispatched phase agent. Save under a per-feature directory so the dispatch prompt can list them by name:

```bash
FEAT_ID="$(basename "$FEAT_DIR")"
RECEIPTS_DIR="/tmp/orch-receipts/${FEAT_ID}"
mkdir -p "$RECEIPTS_DIR"

browzer status --json --save "${RECEIPTS_DIR}/status.json" --quiet
browzer explore "<one noun from operator request>" --json --save "${RECEIPTS_DIR}/explore-<topic-slug>.json"
browzer search  "<topic>"                            --json --save "${RECEIPTS_DIR}/search-<topic-slug>.json"
```

Run `browzer explore` / `search` / `deps` until each open question from the operator's request has at least one structured receipt under `${RECEIPTS_DIR}`. Each query MUST address a different angle (new noun / file class / symbol / dep direction) — duplicate angle = stop. `--save --quiet` mandatory. Receipts are passed by-reference (PATH only) into every dispatched phase agent prompt — never re-cite receipt content into the chat. If the index is stale, surface one line and proceed: `⚠ Browzer index is N commits behind HEAD. Recommended: browzer sync. Continuing — outputs may reflect stale reality.`

The path layout is the contract phase agents read against (see `references/agent-dispatch-contract.md §"Resolving RECEIPTS_DIR for the prompt"`). Every Agent dispatch in §5.3 binds `RECEIPTS_DIR` + `RECEIPT_FILES` in its prompt so the phase agent reads the cached receipts instead of paying the same explore/search cost again. Mid-flow entry that bypasses Step 4 leaves `RECEIPTS_DIR` resolving to `(none)` — phase agents handle that case by running their own queries.

## Step 5 — Pipeline loop

The pipeline is an **explicit loop in this skill body** — read next-pending phase from `workflow.json`, dispatch its skill, loop until done. The loop body IS the controller.

### Phases (in order; brainstorming already happened in Step 2)

| # | Step name | Skill | Dispatch primitive |
| - | --------- | ----- | ------------------ |
| 1 | PRD | `generate-prd` | Agent (autonomous) / Skill (review) |
| 2 | TASKS_MANIFEST + N × TASK | `generate-task` | Agent / Skill |
| 3 | TASK execution | `execute-task` | **Skill in main context — see §5.2 below** |
| 4 | CODE_REVIEW | `code-review` | Agent / Skill |
| 5 | RECEIVING_CODE_REVIEW | `receiving-code-review` | Agent / Skill |
| 6 | WRITE_TESTS | `write-tests` | Agent / Skill |
| 7 | UPDATE_DOCS | `update-docs` | Agent / Skill |
| 8 | FEATURE_ACCEPTANCE | `feature-acceptance` | Agent / Skill |
| 9 | COMMIT | `commit` | Agent / Skill |

### 5.1 — Dispatch primitive matrix

| `config.mode` | Default primitive | Why |
| ------------- | ----------------- | --- |
| `autonomous`  | `Agent(general-purpose, ...)` per phase | Each phase runs in an **isolated subagent context**. The orchestrator's main thread sees only a one-line cursor per phase (cumulative ~30k tokens) instead of the full skill body + tool_results. Operator is not watching, so the interactive UX cost is zero. |
| `review`      | `Skill(<phase-skill>)` per phase | Review-candidate skills render `.md` and gate on operator approval in the **main session**. Agent dispatch breaks that surface (the operator can't approve `.md` rendered inside an isolated subagent). |

### 5.2 — Phase 3 is the exception: `execute-task` runs in main context

**Both modes** invoke `execute-task` via `Skill(execute-task, ...)` — never via `Agent(...)`. Reason: `execute-task` is itself a sub-orchestrator that fans out to N domain specialists in parallel. To dispatch sub-Agents reliably it needs `Agent` tool in its own execution context. Sub-Agents nested inside an `Agent` dispatch are unreliable across harness configurations (tool not always exposed, return shape unstable). Running `execute-task` as a `Skill` in main keeps the fan-out reliable.

The cost is one phase's worth of context loading in the main thread; the trade is real fan-out capability and per-task domain-specialist dispatch. Specialists themselves return one-line cursors back to `execute-task`, so the main thread never sees specialist transcripts.

### 5.3 — Loop body (each iteration)

1. **Read next-pending phase** from `workflow.json`. The next phase is the first canonical pipeline name (per the table above) for which no terminal-status step exists yet — i.e. no entry in `.steps[]` whose `name` matches and whose `status` is one of `{COMPLETED, SKIPPED, STOPPED, FAILED}`. Use:

   ```bash
   browzer workflow query steps-by-name --workflow "$WORKFLOW" --json \
     | jq -r --argjson order '["PRD","TASKS_MANIFEST","TASK","CODE_REVIEW","RECEIVING_CODE_REVIEW","WRITE_TESTS","UPDATE_DOCS","FEATURE_ACCEPTANCE","COMMIT"]' '
       . as $byName |
       $order[] | select(
         ($byName[.] // []) | map(.status) | any(. == "COMPLETED" or . == "SKIPPED" or . == "STOPPED" or . == "FAILED") | not
       )' | head -1
   ```

2. **Exit if done**: when the previous step is `COMMIT` with `status: COMPLETED` (or there is genuinely no remaining phase), emit the closure cursor and stop:

   ```
   orchestrate-task-delivery: pipeline complete; <N> steps written to workflow.json; SHA <sha> ready for operator-driven push
   ```

3. **Dispatch the next phase** in the SAME response turn that read next-pending. Branch:

   - **Phase 3 (`execute-task`)** — always `Skill(execute-task, args: "feat dir: $FEAT_DIR; taskIds: <array>")`. The `taskIds` array comes from the previous Phase 2's return cursor (see §5.4 payload-extras).
   - **All other phases in `autonomous`** — `Agent(general-purpose, prompt: <see references/agent-dispatch-contract.md>)`. Set `BROWZER_WORKFLOW_STEP_ID` + `BROWZER_DISPATCH_AGENT_ID` env vars before the call; UNSET both immediately after the Agent returns (`references/agent-dispatch-contract.md §Step 3.1` covers the rationale — leaks inflate Langfuse score aggregates).
   - **All other phases in `review`** — `Skill(<phase-skill>, ...)`.

4. **Verify the dispatch landed before iterating**. The Agent's return string is a CLAIM, not evidence. After EVERY `Agent(...)` return — and BEFORE reading next-pending for the next iteration — read the workflow record back and confirm a step exists with the claimed status:

   ```bash
   LAST=$(browzer workflow get-config currentStepId --workflow "$WORKFLOW" --quiet)
   STATUS=$(browzer workflow get-step "$LAST" --field status --workflow "$WORKFLOW" --quiet)
   ```

   - **No step written** (the cursor said `status=COMPLETED` but `currentStepId` is unchanged from before the dispatch, OR `get-step` returns nothing): the subagent died mid-stream — common cause is output budget exhaustion while emitting a large step payload (the moonbase 2026-05-06 retro). Treat this dispatch as **FAILED regardless of the cursor**, increment the per-phase failure counter (see §5.6), and follow the fallback ladder.
   - **Step exists but status mismatches the cursor**: trust the JSON, not the cursor. Use the on-disk status to decide the next action.
   - **Step exists and matches**: proceed to next-pending in the same response turn.

5. **Iterate**: read next-pending again from `workflow.json`, dispatch the next phase. Loop in the same response turn until exit conditions fire.

### 5.4 — Agent return contract (payload-extras per phase)

Every dispatched Agent returns ONE line followed by a small JSON `{...}` with the minimum a downstream phase needs to recover context via `browzer workflow get-step`. **No verbose reports, transcripts, or task tables** — those bloat the main thread for no gain.

```
<phase-skill>: stepId=<STEP_ID>; status=<COMPLETED|FAILED|PAUSED>; <payload-extras>
```

| Phase skill | payload-extras |
|-------------|----------------|
| `brainstorming` | (none — `generate-prd` reads via `get-step --field brainstorm`) |
| `generate-prd` | (none — `generate-task` reads via `get-step --field prd`) |
| `generate-task` | `taskIds=[TASK_01,TASK_02,...]` — `execute-task` consumes the array directly |
| `execute-task` | `executedTaskIds=[...]; failedTaskIds=[...]` — code-review scopes findings to executed tasks |
| `code-review` | `findingIds=[...]` — receiving-code-review iterates this set |
| `receiving-code-review` | `closedFindings=N; openFindings=M` — orchestrator decides whether to loop again |
| `write-tests` | (none) |
| `update-docs` | (none) |
| `feature-acceptance` | `verdict=<APPROVED|BLOCKED>; deferredActions=N` — orchestrator decides whether to chain to commit |
| `commit` | `sha=<full-sha>` — used in the closure cursor |

Full Agent prompt template (with placeholders) and the Agent-internal guardrails (no recursive `Skill(orchestrate-task-delivery)`, no mode mutation, no parallel sub-Agents unless the loaded skill explicitly does so) live in **`references/agent-dispatch-contract.md`**. Load that ref before the FIRST Agent dispatch; cache and reuse for every subsequent iteration.

### 5.5 — Stop conditions (loop exits before all phases complete)

- Phase returns `status: PAUSED_PENDING_OPERATOR` → emit pause cursor + summary of `operatorActionsRequested`, exit. Operator's next message resumes the loop.
- Phase returns `status: FAILED` → emit failure cursor + hint, exit.
- `config.mode == "review"` AND a review-candidate phase enters `AWAITING_REVIEW` → the skill (invoked via `Skill(...)`) owns its review gate in the main session; the loop waits for the skill to flip to COMPLETED (or STOPPED) before iterating.

Load `references/mode-contract.md` for the full autonomous vs review loop contract and the inter-step narration rules.

### 5.6 — Dispatch failure ladder (autonomous mode)

When §5.3 step 4 detects a dispatch that returned a status cursor but did NOT write a step (or wrote one in a non-terminal status without progressing), follow this fixed ladder. Do NOT exceed it — the failure budget is bounded so a chronically broken phase surfaces fast.

| Attempt | Action | When to escalate |
|---------|--------|------------------|
| **1 (silent retry)** | Re-dispatch the SAME phase via `Agent(general-purpose, ...)` with the SAME prompt. Drift in the harness can produce a one-off truncation; one retry catches it. | If the second dispatch also returns COMPLETED-without-step, escalate to attempt 2. |
| **2 (cross-mode fallback)** | Invoke `Skill(<phase-skill>)` directly in main context for this ONE phase, regardless of mode. Same precedent as Phase 3 (`execute-task`) — see `references/mode-contract.md §"Cross-mode exception"`. The main thread's context budget is much larger than a subagent's output budget, so phases that emit large step payloads (PRD, TASKS_MANIFEST, large code-review findings) succeed where the subagent died. Emit a one-line warning before the Skill call: `orchestrate-task-delivery: phase <name> fell back to Skill-in-main after 2 Agent dispatches returned COMPLETED-without-step (likely subagent output-budget exhaustion).` Persist the same fact to `globalWarnings[]` so retro analysis catches the pattern (the Skill call will itself write the actual step — `truncation-audit` is NOT applicable here because that verb requires an existing stepId, and the failed dispatches didn't write one). | If the Skill call ALSO fails (returns FAILED or doesn't write), escalate to attempt 3. |
| **3 (operator escalation)** | Stop the loop. Emit `orchestrate-task-delivery: stopped at <phase> — dispatch ladder exhausted (Agent×2 + Skill-in-main); inspect WORKFLOW + the last subagent return.` plus a hint pointing at the `truncation-audit` records. | — |

The verification check in §5.3 step 4 is what makes attempts 1+2 detectable. Without it, the cursor is taken at face value and the orchestrator silently iterates past a dead phase, which is the regression the moonbase 2026-05-06 session caught manually. Do NOT remove the verification.

Counter discipline: keep the per-phase failure counter scoped to ONE phase invocation. A successful dispatch on a different phase resets nothing. A successful Skill-in-main fallback for phase X DOES reset the counter for phase X — the next iteration starts fresh.

## Operator discipline (load `references/operator-discipline.md` for full detail)

Five orthogonal rules — each one a contract violation when broken:

- **Multi-tool-call batching** — issue independent tool calls in the **same response block**; never serialize what can be parallel.
- **Subagent output handling: refs only** — never re-cite a subagent body in the main thread; pass a stepId reference and let downstream skills read via `browzer workflow get-step --field --save`. Re-citation > 200 chars is a violation.
- **Inter-tool narration ban (ZERO narration)** — no chat text between two `tool_use` blocks of the same response.
- **Schema lookup cache** — `browzer workflow describe-step-type <NAME> --json --save /tmp/<name>-schema.json` once per step-type per session.
- **Path discipline (CWD persists)** — every Bash call inherits the prior call's CWD. Use absolute paths in `WORKFLOW=...` bindings and every `--workflow` flag, OR scope `cd` changes to a subshell `( cd <subdir> && <cmd> )`.

## Non-negotiables

- **Output language: English.** All workflow.json fields in English. Conversational wrapper follows operator's language.
- No application code. You are the orchestrator.
- No silent skips of phases. If a phase is genuinely n/a, record it with `status: SKIPPED` and `applicability.applicable: false`.
- No inline gate-failure fixes. Dispatch a fix agent via `receiving-code-review`.
- No parallel edits of the same file without isolation (worktree or file-overlap pre-check; both handled inside `execute-task`).
- `commit` is the last phase. Don't chain to `sync-workspace`.
- **Skills must map 1:1 with the `browzer` CLI.** Never invent step types, payload fields, config keys, or workflow verbs that the CUE SSOT (`browzer workflow describe-step-type --json` / `browzer workflow schema --json-schema`) does not define.

## Invocation modes

- **Direct feature request** — "add X", "implement Y", "build Z". Route through Step 0 → Step 1 → (Step 2 if vague) → Step 3 → Step 4 → loop.
- **Mid-flow entry** — "execute TASK_03", "update the docs", "commit what I staged". Resolve `FEAT_DIR` from context, jump to the named phase. Inherit `config.mode` and `config.testExecutionDepth` from `workflow.json`. **After the named phase completes, the loop continues normally** — it reads next-pending and dispatches whatever phase comes after, all the way to COMMIT (in autonomous) or until the next review-gate (in review). Mid-flow entry only changes WHERE the loop starts, not WHEN it stops.
- **Single-phase rerun** — "re-run code-review after iteration", "just do update-docs". Operator wants ONE specific phase, no chaining. Detect via explicit narrowing language ("only", "just", "re-run X and stop"). Run the named phase, emit its cursor, exit without iterating. When ambiguous (operator just names a phase without "only"), default to mid-flow-entry semantics — chain forward — because that's what the master orchestrator is for.
