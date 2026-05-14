---
name: orchestrate-task-delivery
description: "Master orchestrator for any non-trivial feature, bugfix, or refactor in a Browzer-indexed repo. Drives the markdown-chains pipeline filesystem-by-filesystem: brainstorming (when needed) → PRD → scope-feature → tasks → execute → write-tests → code-review → receiving-code-review → feature-acceptance → finalize-feature (doc-patching + README) → commit. State lives in docs/browzer/<feat>/staging/ — gitignored; only README.md gets committed. Resume any feat by re-invoking with the same id; the state machine reads file presence to pick the next phase. Mid-workflow entry also welcome (operator invokes /execute-task or /finalize-feature directly). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, let's start, continue feat, resume feat, what's next."
argument-hint: "<featureId-or-slug> [<strategy>]"
---

You orchestrate. You do not implement. Read filesystem state via
`scripts/detect-phase.mjs`, dispatch the named skill, append the
transition to `DELEGATION_TRACE.md`, repeat until DONE or HALT.

This file is deliberately lean — the loop + dispatch surface stays
inline so the orchestrator can run from a single read, while verbose
context (init bootstrap, COMPLEXITY heuristic, mentions-cache pattern,
preflight detail) is lazy-loaded from `references/` only on the
iteration that needs it.

## Inputs

- `$ARGUMENTS` is `<featureId-or-slug> [<strategy>]`:
  - `<featureId>` matches `^feat-\d{8}-[a-z0-9-]+$` for an existing or new feat.
  - `<slug>` (without date prefix) is normalized to `feat-YYYYMMDD-<slug>` using today's date.
  - `<strategy>` (OPTIONAL) is `serial | parallel | parallel-worktrees | agent-teams`. Defaults to `serial`. Persisted to `staging/CONFIG.md` once at init; subsequent invocations honor the persisted value.

## Output contract

| Path                                              | Role                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `docs/browzer/<feat>/staging/.gitignore`          | written once at init; two lines `*` + `!.gitignore` so `staging/` is excluded from git but its own `.gitignore` is versioned |
| `docs/browzer/<feat>/staging/CONFIG.md`           | written once at init; carries `executionStrategy`, `acceptanceMode`, `createdAt`                                             |
| `docs/browzer/<feat>/staging/DELEGATION_TRACE.md` | append-only log of state-machine transitions                                                                                 |

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

When `detect-phase` returns `state: no-feat-folder, nextPhase: INIT`,
follow `${CLAUDE_SKILL_DIR}/references/init-bootstrap.md`. The doc
covers: featureId validation, `staging/.gitignore` + `staging/CONFIG.md`
templates, legacy-layout migration, and the brainstorming-gate trace
bullet.

After bootstrap, continue the loop with a fresh `detect-phase` call.

## Preflight — workspace index staleness

Before the first `detect-phase` of every invocation, run
`browzer workspace status --json --save /tmp/orch-status-<featureId>.json`.
If `commitsBehind > 5`, kick `browzer sync --skip-docs` in the
background (`run_in_background: true`) so the index catches up while
the loop continues. The sync is best-effort — do NOT block the loop;
record the lag in `DELEGATION_TRACE.md` as
`--note "preflight: index lagged N commits; sync triggered"`. Auth /
no-workspace failures are recorded and ignored. Full exit-code table:
`${CLAUDE_SKILL_DIR}/references/preflight.md`.

## Step 1 — State-machine loop

Exit-code semantics for `detect-phase.mjs`:

| Exit | Meaning                             | Orchestrator action                          |
| ---- | ----------------------------------- | -------------------------------------------- |
| 0    | normal transition; `.nextPhase` set | append trace + dispatch (Step 2)             |
| 3    | HALT; `.notes` carries reason       | append trace `--halt`, print, exit 0         |
| 4    | CYCLE detected                      | print error, exit 1                          |
| 5    | DONE (terminal)                     | append trace `--done`, print summary, exit 0 |

Loop body:

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

| nextPhase                         | Dispatch                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brainstorming`                   | `Skill(browzer:brainstorming)` with arg `$FEAT_ID`                                                                                                                                                                                                                                           |
| `generate-prd`                    | `Agent(subagent_type: "browzer:pm", model + effort scaled by COMPLEXITY)` with feature prompt                                                                                                                                                                                                |
| `scope-feature`                   | `Agent(subagent_type: "browzer:scoper", model: haiku, effort: high)`                                                                                                                                                                                                                         |
| `generate-task`                   | `Agent(subagent_type: "browzer:po", model + effort scaled by COMPLEXITY)`                                                                                                                                                                                                                    |
| `execute-task`                    | `Skill(browzer:execute-task)` with arg `$FEAT_ID` (loops internally over pending tasks per CONFIG.executionStrategy)                                                                                                                                                                         |
| `code-review`                     | `Skill(browzer:code-review)` with arg `$FEAT_ID`                                                                                                                                                                                                                                             |
| `receiving-code-review`           | `Skill(browzer:receiving-code-review)` with arg `$FEAT_ID`                                                                                                                                                                                                                                   |
| `write-tests`                     | `Skill(browzer:write-tests)` with arg `$FEAT_ID`                                                                                                                                                                                                                                             |
| `feature-acceptance`              | `Skill(browzer:feature-acceptance)` with args `$FEAT_ID $MODE` (mode from CONFIG.md or detect-phase)                                                                                                                                                                                         |
| `finalize-feature`                | `Skill(browzer:finalize-feature)` with arg `$FEAT_ID` — runs Phase A (inline doc-patching; skipped when no exported-symbol drift) then Phase B (README render)                                                                                                                              |
| `commit`                          | `Skill(browzer:commit)` with arg `$FEAT_ID`                                                                                                                                                                                                                                                  |

Wait for the dispatched skill to complete. Then re-run `detect-phase`
for the next iteration.

**Per-dispatch lazy-loads** (read the ref only on the matching iteration):

- Dispatching `generate-prd` or `generate-task`: compute the COMPLEXITY
  signal per `${CLAUDE_SKILL_DIR}/references/complexity-signal.md` and
  pass `model` + `effort` accordingly.
- Dispatching a skill that issues `browzer mentions <path>` (`code-review`,
  `finalize-feature`, `feature-acceptance`): route through the cache
  helper per `${CLAUDE_SKILL_DIR}/references/browzer-mentions-cache.md`
  to avoid redundant work across phases.

**Output discipline (always):** never re-cite a dispatched skill's
artefact body — refs only, by path. Inter-tool narration between
parallel calls is zero. Full reasoning in
`${CLAUDE_SKILL_DIR}/references/dispatch-batching.md`.

**Anti-redundant-read invariant (always):** once an artefact is loaded
in the orchestrator's working memory (PRD.md, EXPLORATION.md, any
TASK_NN(.completed).md, CODE_REVIEW.md, ACCEPTANCE.md, or any
`references/*.md` already followed this session), do NOT re-Read it on
a subsequent iteration — the loop is single-threaded and the file does
not mutate underneath you within one orchestrator session. Re-reading
inflates Bash/Read counts without changing decisions. When dispatching
a subagent that needs phase-artefact content, INLINE the relevant
frontmatter excerpt into the dispatch prompt rather than instructing
the subagent to Read the file — the subagent has its own context and
cannot share the orchestrator's. Exception: `detect-phase.mjs` re-runs
every iteration because filesystem presence IS the state.

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

Cross-cutting (loaded by ≥2 skills):

- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — every file the state machine reads; staging-folder discipline
- `${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md` — canonical phase order
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — regex shapes the chain depends on
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer used by every code-touching skill (replaces the legacy paste-include of `subagent-preamble.md`)
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (NOT paste-included by dispatchers; consulted when authoring)
- `${CLAUDE_PLUGIN_ROOT}/references/skills-discovery-limits.md` — cross-cutting concern tags + programmatic-mode contract for find-skills

Skill-local (loaded on the matching iteration):

- `${CLAUDE_SKILL_DIR}/references/state-machine.md` — canonical transition table; HALT conditions; DONE state; cycle guard
- `${CLAUDE_SKILL_DIR}/references/intent-detection.md` — brainstorming gate heuristic; mid-workflow entry routing
- `${CLAUDE_SKILL_DIR}/references/init-bootstrap.md` — Step 0 detail; first-invocation only
- `${CLAUDE_SKILL_DIR}/references/preflight.md` — workspace index staleness exit-code table
- `${CLAUDE_SKILL_DIR}/references/complexity-signal.md` — PM/PO model + effort selection
- `${CLAUDE_SKILL_DIR}/references/browzer-mentions-cache.md` — cross-phase cache pattern
- `${CLAUDE_SKILL_DIR}/references/dispatch-batching.md` — multi-tool-call batching & artefact-citation discipline
