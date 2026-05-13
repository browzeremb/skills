---
name: orchestrate-task-delivery
description: "Master orchestrator for any non-trivial feature, bugfix, or refactor in a Browzer-indexed repo. Drives the markdown-chains pipeline filesystem-by-filesystem: brainstorming (when needed) → PRD → scope-feature → tasks → execute → code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → update-docs (final drift-catch) → finalize-feature → commit. Pure-deletion features may opt into `--mode inline-with-review` to skip PM/PO/scope-feature. State lives in docs/browzer/<feat>/staging/ — gitignored; only README.md gets committed. Resume any feat by re-invoking with the same id; the state machine reads file presence to pick the next phase. Mid-workflow entry also welcome (operator invokes /execute-task or /update-docs directly). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, let's start, continue feat, resume feat, what's next."
argument-hint: "<featureId-or-slug> [<strategy>]"
---

You orchestrate. You do not implement. Read filesystem state via
`scripts/detect-phase.mjs`, dispatch the named skill, append the
transition to `DELEGATION_TRACE.md`, repeat until DONE or HALT.

## Inputs

- `$ARGUMENTS` is `<featureId-or-slug> [<strategy>] [--mode <pipeline-mode>]`:
  - `<featureId>` matches `^feat-\d{8}-[a-z0-9-]+$` for an existing or new feat.
  - `<slug>` (without date prefix) is normalized to `feat-YYYYMMDD-<slug>` using today's date.
  - `<strategy>` (OPTIONAL) is `serial | parallel | parallel-worktrees | agent-teams`. Defaults to `serial`. Written to `staging/CONFIG.md` once at init; subsequent invocations honor the persisted value.
  - `--mode <pipeline-mode>` (OPTIONAL) is `full | inline-with-review`. Defaults to `full`. See "Pipeline-mode selection" below. Written to `staging/CONFIG.md.frontmatter.pipelineMode` at init; subsequent invocations honor the persisted value.

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/.gitignore` | written once at init; two lines `*` + `!.gitignore` so `staging/` is excluded from git but its own `.gitignore` is versioned |
| `docs/browzer/<feat>/staging/CONFIG.md` | written once at init; carries `executionStrategy`, `acceptanceMode`, `pipelineMode`, `createdAt` |
| `docs/browzer/<feat>/staging/DELEGATION_TRACE.md` | append-only log of state-machine transitions |

The orchestrator does NOT write phase artefacts — every artefact is
written by the skill the orchestrator dispatches.

## Operating mode

The orchestrator is **stateless beyond the feat folder**. Every
invocation:

1. Resolves `<featureId>`.
2. Runs `detect-phase.mjs <featureId> --json` to inspect filesystem state.
3. Dispatches the named skill with the args returned by `detect-phase`.
4. Appends a trace entry via `append-trace.mjs`.
5. Re-runs `detect-phase` to identify the next phase.
6. Loops until DONE or HALT.

## Step 0 — Initialize (only when feat folder absent)

When `detect-phase` returns `state: no-feat-folder, nextPhase: INIT`:

1. Validate / normalize `<featureId>`:
   - If matches `^feat-\d{8}-[a-z0-9-]+$`, use as-is.
   - If just a slug, prepend `feat-$(date +%Y%m%d)-`.
2. Create `docs/browzer/<featureId>/staging/`.
3. Write `staging/.gitignore` (immutable, contents below):

   ```
   *
   !.gitignore
   ```

   This excludes every workflow artefact from git while keeping the
   `.gitignore` itself versioned so the discipline survives clones.
4. Resolve `pipelineMode` per the "Pipeline-mode selection" section
   below.
5. Write `staging/CONFIG.md`:

   ```yaml
   ---
   featureId: <featureId>
   executionStrategy: <serial | parallel | parallel-worktrees | agent-teams>
   acceptanceMode: hybrid
   pipelineMode: <full | inline-with-review>
   createdAt: <RFC3339>
   ---
   ```

6. **Legacy-layout migration** — when initializing a feat folder whose
   prior incarnation pre-dates the staging-folder discipline (any
   `PRD.md`/`TASK_*.md` at `docs/browzer/<featureId>/` top level, no
   `staging/` subfolder), move every file except `README.md` into the
   newly created `staging/` subfolder before continuing. The migration
   is idempotent; re-running on an already-migrated folder is a no-op.
7. Apply the brainstorming gate heuristic per
   `${CLAUDE_SKILL_DIR}/references/intent-detection.md §brainstorming-gate`.
   Record the decision via `append-trace.mjs` with `--operator-override`
   (when explicit) or `--from init-no-feat --to brainstorming|generate-prd`.
8. Continue the loop with a fresh `detect-phase` call.

## Pipeline-mode selection

`pipelineMode` selects how much of the full 13-phase chain runs:

| Mode | Phases skipped | When to use |
|---|---|---|
| `full` (default) | none | Default for any feature with new behaviour, new functions, or non-trivial logic changes. |
| `inline-with-review` | brainstorming, generate-prd, scope-feature, generate-task | Pure-deletion features: no new functions, no behavioural changes, work is delete-files + delete-CLI-wirings + delete-tests + adjust-docs. ~50 % wall-clock saving with review safety retained. |

### `inline-with-review` heuristic (auto-select unless overridden)

When the operator does NOT pass `--mode`, the orchestrator probes the
brief for deletion-only signals:

- BRIEF.md (or the raw `$ARGUMENTS` prose) contains exclusively deletion
  vocabulary: "remove", "retire", "drop", "delete", "cleanup", "sunset",
  "deprecate".
- AND does NOT contain any of: "add", "implement", "introduce",
  "create", "build", "refactor to <X>", "migrate to <X>".
- AND the brief does NOT cite any new public symbol, route, env var, or
  schema field.

When all three hold, auto-select `inline-with-review` and surface the
decision to the operator via the next `detect-phase` trace bullet:

> `--note "pipeline-mode auto-selected: inline-with-review (pure deletion)"`

The operator may override post-hoc by editing
`staging/CONFIG.md.frontmatter.pipelineMode` and re-invoking the
orchestrator; the next iteration honours the persisted value.

### `inline-with-review` execution

The state machine routes:

```
INIT → execute-task (inline, single dispatch with brief + scope inlined)
     → code-review
     → receiving-code-review
     → write-tests (optional — runs only when host has a detectable test runner)
     → update-docs
     → feature-acceptance
     → update-docs (final drift-catch, usually skipped for pure deletion)
     → finalize-feature
     → commit
```

The single `execute-task` invocation receives a synthesised
`TASK_01.md` whose frontmatter inlines the operator's brief verbatim as
`acceptanceCriteria[].text`, the deletion scope as `scope.files[]`,
zero invariants (or sentinel rationale), and `trivial: false` (because
even pure deletions can trip blast-radius issues that demand a coder
subagent). The brief is the contract; no PRD or EXPLORATION.md exists
in this mode.

## Preflight — workspace index staleness (every invocation)

Before the first `detect-phase` call, run:

```bash
browzer workspace status --json --save /tmp/orch-status-<featureId>.json
```

If `commitsBehind` (or the equivalent staleness field) is `> 5`, run
`browzer sync --skip-docs` in the background (`run_in_background: true`)
so the index catches up while the orchestrator continues with the rest
of the pipeline. Record the lag in `DELEGATION_TRACE.md` as
`--note "preflight: index lagged N commits; sync triggered"`. The sync
is best-effort — do NOT block the loop waiting for it; a stale index
degrades grounding fidelity but does not block correctness.

If `browzer workspace status` itself fails (exit code 2 — not
authenticated, exit code 4 — no workspace bound), proceed without the
sync and record the failure in the trace. The downstream skills will
surface index-stale assumptions in their own receipts.

## Step 1 — State-machine loop

For each iteration:

Exit-code semantics for `detect-phase.mjs`:

| Exit | Meaning | Orchestrator action |
|---|---|---|
| 0 | normal transition; `.nextPhase` set | append trace + dispatch (Step 2) |
| 3 | HALT; `.notes` carries reason | append trace `--halt`, print, exit 0 |
| 4 | CYCLE detected | print error, exit 1 |
| 5 | DONE (terminal) | append trace `--done`, print summary, exit 0 |

Pseudocode for the loop body:

```bash
RESULT=$(node "${CLAUDE_SKILL_DIR}/scripts/detect-phase.mjs" "$FEAT_ID" --json)
EXIT=$?
NEXT_PHASE=$(echo "$RESULT" | jq -r '.nextPhase')
FROM=$(echo "$RESULT" | jq -r '.state')
ARGS_LIST=$(echo "$RESULT" | jq -r '.args | join(",")')
NOTES=$(echo "$RESULT" | jq -r '.notes')

if [ "$EXIT" = "0" ]; then
  node "${CLAUDE_SKILL_DIR}/scripts/append-trace.mjs" "$FEAT_ID" --from "$FROM" --to "$NEXT_PHASE" --args "$ARGS_LIST"
  # Dispatch the named skill per Step 2 below
elif [ "$EXIT" = "3" ]; then
  node "${CLAUDE_SKILL_DIR}/scripts/append-trace.mjs" "$FEAT_ID" --halt "$NOTES"
  echo "orchestrate-task-delivery: HALT — $NOTES"
  exit 0
elif [ "$EXIT" = "4" ]; then
  echo "orchestrate-task-delivery: CYCLE — operator must inspect"
  exit 1
elif [ "$EXIT" = "5" ]; then
  node "${CLAUDE_SKILL_DIR}/scripts/append-trace.mjs" "$FEAT_ID" --done
  echo "orchestrate-task-delivery: DONE for $FEAT_ID"
  exit 0
fi
```

Repeat until DONE or HALT.

## Step 2 — Dispatch the named skill

For each `nextPhase` value, dispatch via the appropriate channel:

| nextPhase | Dispatch |
|---|---|
| `brainstorming` | `Skill(browzer:brainstorming)` with arg `$FEAT_ID` |
| `generate-prd` | `Agent(subagent_type: "browzer:pm", model + effort scaled by COMPLEXITY)` with feature prompt |
| `scope-feature` | `Agent(subagent_type: "browzer:scoper", model: haiku, effort: high)` |
| `generate-task` | `Agent(subagent_type: "browzer:po", model + effort scaled by COMPLEXITY)` |
| `execute-task` | `Skill(browzer:execute-task)` with arg `$FEAT_ID` (loops internally over pending tasks per CONFIG.executionStrategy) |
| `code-review` | `Skill(browzer:code-review)` with arg `$FEAT_ID` |
| `receiving-code-review` | `Skill(browzer:receiving-code-review)` with arg `$FEAT_ID` |
| `write-tests` | `Skill(browzer:write-tests)` with arg `$FEAT_ID` |
| `update-docs` (primary) | `Skill(browzer:update-docs)` with arg `$FEAT_ID` (writes `staging/DOC_PATCHES.md` with `pass: primary`) |
| `feature-acceptance` | `Skill(browzer:feature-acceptance)` with args `$FEAT_ID $MODE` (mode from CONFIG.md or detect-phase) |
| `update-docs` (final drift-catch) | `Skill(browzer:update-docs)` with arg `$FEAT_ID` — re-invoked after acceptance. Runs the discovery skip rule first; when no NEW exported-symbol drift exists since the primary pass, the skill writes `staging/DOC_PATCHES.md` with `pass: final` + `skipped: true` and returns immediately. |
| `finalize-feature` | `Skill(browzer:finalize-feature)` with arg `$FEAT_ID` |
| `commit` | `Skill(browzer:commit)` with arg `$FEAT_ID` |

Wait for the dispatched skill to complete. Then re-run `detect-phase`
for the next iteration.

### COMPLEXITY signal (for PM / PO model selection)

When dispatching `generate-prd` (PM) or `generate-task` (PO), compute
the COMPLEXITY signal from BRIEF.md (when present) or the verbatim
request:

| Signal | PM (PRD) | PO (tasks) |
|---|---|---|
| `simple` | sonnet, medium | sonnet, medium |
| `standard` | sonnet, high | sonnet, high |
| `complex` | sonnet, xhigh | opus, xhigh |
| `architectural` | opus, max | opus, max |

Heuristic: count distinct domains (frontend / backend / infra / docs)
touched + count distinct files mentioned. ≤2 domains and ≤5 files →
`standard`. >3 domains → `complex`. Cross-cutting refactor signals →
`architectural`.

## Step 3 — Multi-tool-call batching guidance

When multiple independent tool calls can be batched (e.g. reading
several artefacts to compute COMPLEXITY), issue them in a single
response block. Inter-tool narration is ZERO — do not text between
parallel tool calls.

Subagent output discipline (refs only): when the dispatched skill emits
its artefact, the orchestrator MUST never re-cite the artefact's body
— refs only, by path. The orchestrator's only output between dispatches
is the trace bullet — the artefact IS the canonical record.

Schema cache guidance: subagents discover schema-shaped data via
`${CLAUDE_SKILL_DIR}/template.md` reads (cached per-skill); the legacy
runtime `describe-step-type --save` path is dead in the markdown-chains
era.

## Mid-workflow entry (operator-driven)

When the operator types a direct-skill phrasing (e.g. "execute TASK_03
for `<feat>`"), DO NOT engage the state machine. Apply the routing
table in `${CLAUDE_SKILL_DIR}/references/intent-detection.md §mid-workflow-entry`
and invoke the named skill directly. The operator can resume the
orchestrator later — the state machine re-detects state from the
filesystem.

## Done when

- `detect-phase` exits with code 5 (`state: done`).
- `DELEGATION_TRACE.md` has the terminal `orchestrator → DONE` entry.
- Final summary line printed:

  ```
  orchestrate-task-delivery: DONE for <feat>
    verdict: <ACCEPTANCE.md.verdict>
    tasks: <count>
    fixes: <count fixed> / <count tech-debt>
    tests: <count tests added, kill rate %>
    docs:  <count patched>
    commit sha: <full sha>
  ```

## References

- `${CLAUDE_SKILL_DIR}/references/state-machine.md` — canonical transition table; HALT conditions; DONE state; cycle guard
- `${CLAUDE_SKILL_DIR}/references/intent-detection.md` — brainstorming gate heuristic; mid-workflow entry routing
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — every file the state machine reads; staging-folder discipline
- `${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md` — canonical phase order (incl. double `update-docs` invocation)
- `${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md` — RECEIPTS.md contract (every dispatched skill appends)
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — regex shapes the chain depends on
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer used by every code-touching skill (replaces the legacy paste-include of `subagent-preamble.md`)
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (NOT paste-included by dispatchers; consulted when authoring)
- `${CLAUDE_PLUGIN_ROOT}/references/skills-discovery-limits.md` — cross-cutting concern tags + programmatic-mode contract for find-skills
