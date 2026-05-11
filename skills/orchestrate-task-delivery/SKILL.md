---
name: orchestrate-task-delivery
description: "Master orchestrator for any feature, bugfix, or refactor that touches more than a few files in a Browzer-indexed repo. Drives the full pipeline: brainstorming-when-needed → PRD → task plan → execute → code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit. Grounds decisions in `browzer explore`/`search`/`deps`; delegates all implementation to specialist subagents. Mid-workflow entry also welcome ('execute TASK_03', 'update the docs', 'commit what I staged'). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, 'let's start'."
---

You orchestrate. You do not implement. Route → ground context → invoke the next phase skill → confirm the staging artifact landed → move on.

State lives in `docs/browzer/<feat>/workflow.json`. Phase skills produce artifacts at `docs/browzer/<feat>/staging/<PHASE>.{md,json}` via Write; the PostToolUse autosave hook validates each artifact and persists it into `workflow.json`. You read context with `browzer get-step <ID> --id <feat>` — not `Read`, not `jq`.

## Setup (bookkeeping, no artifacts the operator reviews)

| # | Step | Skill | Output |
| - | ---- | ----- | ------ |
| S0 | Daemon ensure (best-effort) | (inline) | daemon warmed up or silently skipped |
| S1 | Probe | (inline) | shell bindings `BRAINSTORMING_NEEDED` + `COMPLEXITY` |
| S2 | Resolve executionStrategy + mode | (inline; see below) | `$STRATEGY` + `$MODE` held for S3 |
| S3 | Init | (inline) | `<feat>/workflow.json` seeded with `config.executionStrategy` |
| S4 | Brainstorm-if-needed | `brainstorming` | `staging/BRAINSTORM.md` (skipped when input is saturated) |
| S5 | Schema prefetch | (inline; see below) | `.browzer/.schema-cache/<PHASE>.json` per persistable phase |

## Pipeline (artifact-producing phases)

When invoking each phase skill, pass the feature id (basename of `$FEAT_DIR`, e.g. `feat-20260507-preamble-staging-migration`) as the skill's **single** argument — the runtime substitutes it as `$ARGUMENTS` inside the skill body. Multi-token args break shell substitution into `--id` flags.

| # | Phase | Skill | Artifact |
| - | ----- | ----- | -------- |
| 1 | PRD | `Agent(browzer:pm)` | `staging/PRD.md` |
| 2 | Tasks | `Agent(browzer:po)` | `staging/TASKS.json` |
| 3 | Execute | `execute-task` | `staging/TASK_NN.json` per task |
| 4 | Code review | `code-review` | `staging/CODE_REVIEW.json` |
| 5 | Receiving review | `receiving-code-review` | `staging/RECEIVING_CODE_REVIEW.json` |
| 6 | Write tests | `write-tests` | `staging/WRITE_TESTS.json` |
| 7 | Update docs | `update-docs` | `staging/UPDATE_DOCS.json` |
| 8 | Feature acceptance | `feature-acceptance` | `staging/FEATURE_ACCEPTANCE.json` |
| 9 | Finalize | `finalize-feature` | `<feat>/README.md` |
| 10 | Commit | `commit` | `staging/COMMIT.json` |

For the universal subagent prompt header, see `references/subagent-preamble.md`.

## Phase dispatch overrides

Phases 1 and 2 use `Agent(...)` dispatches (not the Skill tool). Select model and effort from `$COMPLEXITY` before dispatching:

| `$COMPLEXITY` | Phase 1 `browzer:pm` | Phase 2 `browzer:po` |
| ------------- | -------------------- | -------------------- |
| `simple` | `model: sonnet`, `effort: medium` | `model: sonnet`, `effort: medium` |
| `standard` | `model: sonnet`, `effort: high` | `model: sonnet`, `effort: high` |
| `complex` | `model: sonnet`, `effort: xhigh` | `model: opus`, `effort: xhigh` |
| `architectural` | `model: opus`, `effort: max` | `model: opus`, `effort: max` |

**Phase 1 — PRD:**
```
Agent(
  subagent_type: browzer:pm
  model: <from table>
  effort: <from table>
  prompt: "<feat-id> | Mode: $MODE"
)
```

Wait for `staging/PRD.md` to appear before dispatching Phase 2.

**Phase 2 — Tasks:**

After `staging/PRD.md` lands, re-assess complexity from the PRD itself (acceptance criteria count, services mentioned). If PRD complexity is higher than `$COMPLEXITY` from S1, upgrade the level before dispatching:

```
Agent(
  subagent_type: browzer:po
  model: <from table, re-assessed>
  effort: <from table, re-assessed>
  prompt: "<feat-id> | Mode: $MODE"
)
```

Phases 3–10 continue to use the Skill tool per the loop in "Phases 1–10 — Loop".

## Dispatch-ledger checkpoint (forward-compatible)

After each `Agent(...)` call in Phases 1 and 2 returns (and after any `Agent(...)` dispatch in Phases 3–10 that uses the Agent tool rather than the Skill tool), the orchestrator SHOULD record dispatch metadata inline in its phase-cursor output — one line per Agent call:

```
dispatch: subagentType=<x> model=<y> effort=<z> phase=<p> bytes=<n>
```

This is observable in trace logs and does not require any `workflow.json` mutation.

**Future-state entry shape** (schema reference for when CLI support lands):

```json
{
  "subagentType": "<browzer:pm|browzer:po|browzer:coder|...>",
  "model": "<sonnet|opus|haiku>",
  "effort": "<medium|high|xhigh|max>",
  "phase": "<PRD|TASKS|EXECUTE|CODE_REVIEW|...>",
  "promptByteCount": 0,
  "renderTemplateUsed": false
}
```

**Field definitions:**

- `subagentType` — the `subagent_type` value passed to `Agent(...)`, e.g. `browzer:pm`.
- `model` — the model selected from the complexity table before dispatch.
- `effort` — the effort level selected from the same table.
- `phase` — the canonical phase label matching the pipeline table (e.g. `PRD`, `TASKS`, `EXECUTE`).
- `promptByteCount` — UTF-8 byte length of the full prompt string passed to `Agent(...)`.
- `renderTemplateUsed` — `true` when the dispatch prompt was produced by rendering the skill's `template.md`; `false` when composed ad-hoc inline by the orchestrator.

**Upgrade path:** Dispatch-ledger persistence via `workflow.json` is a planned capability pending a CLI release that introduces (a) a `dispatch-ledger` step type in `#StepView.name`, AND (b) an `append-step` command surface that accepts a positional phase argument or a dedicated `dispatch ledger append` verb. Until that CLI lands, the inline trace-log line above is the canonical record. When the CLI capability lands, the contract upgrades from SHOULD (inline log) to MUST (persist to `workflow.json`). The upgrade trigger is a `browzer workflow describe-step-type DISPATCH_LEDGER --json` exit 0 with a valid schema — at that point, update this section to use the new verb surface.

## Setup S0 — Daemon ensure (best-effort)

Warm the browzer daemon before the pipeline begins. This suppresses the `warn: daemon path unavailable` noise that appears when the daemon is not running but the fallback is working correctly.

```bash
browzer daemon ensure 2>/dev/null || true
```

This step is **best-effort**: if the subcommand is missing (older CLI versions) or the daemon is unreachable, the error is swallowed and the orchestrator continues normally. The pipeline MUST NOT fail if this step exits non-zero.

## Setup S1 — Probe

Decide if the operator's input is saturated enough for a useful PRD. Count missing dimensions: persona, success signal, concrete scope, file/endpoint/module reference. Two missing OR a vague trigger ("what if", "could we", "I'm thinking") sets `BRAINSTORMING_NEEDED=yes`. No persistence yet — `workflow.json` does not exist.

Also assess `COMPLEXITY` from the original request. Set one of four levels:

| Level | Signal |
| ----- | ------ |
| `simple` | Single domain, ≤5 acceptance criteria implied, no cross-service touch |
| `standard` | 1–2 services, clear scope, no security/auth/billing keywords |
| `complex` | ≥3 services OR cross-service data flow OR security / auth / billing keywords |
| `architectural` | "redesign", "migrate", "replace", "extract", or product-level structural decision |

Hold both bindings:

```bash
BRAINSTORMING_NEEDED="yes|no"
COMPLEXITY="simple|standard|complex|architectural"
```

`COMPLEXITY` feeds the model+effort selection for Phase 1 (`browzer:pm`) and Phase 2 (`browzer:po`) dispatches.

## Setup S2 — Resolve executionStrategy + mode

Ask the operator with two adjacent `AskUserQuestion` calls (or one combined prompt) if neither value was already stated in the original request:

**Question 1 — execution strategy:**
> Which execution strategy for this feature?
> - `serial` — one task at a time in main context
> - `parallel` — fan-out subagents in main context (file overlap pre-check)
> - `parallel-worktrees` — git worktree per task (isolated trees)
> - `agent-teams` — multi-agent specialist teams per task

**Question 2 — autonomy mode:**
> Run in `autonomous` mode (no pauses between phases) or `review` mode (pause for operator approval after each phase)?
> Default: `autonomous`

If the operator already stated both values, take them verbatim and skip the prompts. Default `serial` + `autonomous` when nothing is specified. Hold both in shell:

```bash
STRATEGY="<serial|parallel|parallel-worktrees|agent-teams>"
MODE="<autonomous|review>"
```

Default `MODE=autonomous` when the operator does not specify.

`$STRATEGY` is seeded into `workflow.json` via `workflow init --execution-strategy`. `$MODE` is seeded via `workflow init --mode "$MODE"` (CLI accepts `autonomous|review`, default `autonomous`). Always pass `--mode "$MODE"` in S3 so `CONFIG.mode` reflects the operator's choice — feature-acceptance reads `CONFIG.mode` as the **default suggestion** for its own per-run mode picker (see F-7 reconciliation). As a defensive belt-and-suspenders, ALSO thread `Mode: $MODE (autonomous|review)` into every phase skill dispatch prompt so skills can fall back to the dispatch context if `CONFIG.mode` is somehow missing.

> **Orthogonality note.** `CONFIG.mode` (`autonomous|review`) is workflow-wide and governs whether each phase pauses for operator review. `featureAcceptance.mode` (`autonomous|hybrid|manual`) is per-run and governs how acceptance verifies — chosen via the feature-acceptance Phase 0 capability probe + `AskUserQuestion`, with `CONFIG.mode` only setting the suggested default. Don't conflate the two.

## Setup S3 — Init

`FEAT_DIR` is **always relative** to the target repo root. Never absolute.

```bash
FEAT_DIR="docs/browzer/feat-$(date -u +%Y%m%d)-<slug>"
mkdir -p "$FEAT_DIR/staging"
browzer workflow init \
  --workflow "$FEAT_DIR/workflow.json" \
  --feature-id "feat-$(date -u +%Y%m%d)-<slug>" \
  --feature-name "<label>" \
  --original-request "<verbatim ask>" \
  --execution-strategy "$STRATEGY" \
  --mode "$MODE"
export BROWZER_WORKFLOW_ID="$(basename "$FEAT_DIR")"
```

The operator substitutes `<slug>` per-feature; `FEAT_DIR` uses the same value as `--feature-id`. Deriving `BROWZER_WORKFLOW_ID` via `$(basename "$FEAT_DIR")` is the canonical form — it is deterministic and avoids re-templating the date and slug separately. Example: if `FEAT_DIR="docs/browzer/feat-20260511-my-feature"` then `BROWZER_WORKFLOW_ID` becomes `feat-20260511-my-feature`.

`browzer workflow init` derives `featDir` from `--workflow` parent. Pass `--force` to overwrite an existing seed. `--execution-strategy` is optional — omit when the operator did not pick one. `--mode` accepts `autonomous|review` (default `autonomous`); always pass it explicitly so `CONFIG.mode` reflects the operator's S2 choice. Also thread `Mode: $MODE (autonomous|review)` into every subsequent phase skill dispatch prompt as a fallback (see S2).

The `export BROWZER_WORKFLOW_ID` line is additive and non-breaking (FR-8 / AC-8). It is consumed by hooks and guards as a fallback identifier when the workflow path is ambiguous — for example, the autosave hook reads `BROWZER_WORKFLOW_ID` when it cannot derive the feature id from the staged file path alone. Always export the value immediately after `workflow init` so every subsequent shell invocation in the same session inherits it.

## Setup S4 — Brainstorm-if-needed

If `BRAINSTORMING_NEEDED=yes`, invoke the `brainstorming` skill. It writes `staging/BRAINSTORM.md` and pauses for operator approval before returning. If `no`, skip — Phase 1 (`generate-prd`) will fall back to `browzer get-step ORIGINAL_REQUEST --id <feat>`, the verbatim ask `workflow init` recorded.

## Setup S5 — Schema prefetch

After S3 (once `workflow.json` exists), pre-fetch the CUE-derived schema for every persistable phase. This eliminates enum-probe round-trips during execution.

```bash
mkdir -p .browzer/.schema-cache
for PHASE in PRD TASKS_MANIFEST TASK CODE_REVIEW RECEIVING_CODE_REVIEW \
             WRITE_TESTS UPDATE_DOCS FEATURE_ACCEPTANCE COMMIT BRAINSTORMING; do
  browzer workflow describe-step-type "$PHASE" \
    --json --save .browzer/.schema-cache/"$PHASE".json --quiet
done
```

This is best-effort: a cache miss (CLI version mismatch, schema not yet defined for a phase) is non-fatal — the phase skill proceeds without the cached file. When building phase skill dispatch prompts, include the path `.browzer/.schema-cache/<PHASE>.json` so the specialist can read the exact field/enum surface before staging its artifact.

## Setup S6 — find-skills prefetch

After S5 (schema prefetch), dispatch the `browzer:explorer` agent to discover applicable domain skills and emit `staging/SKILLS_FOUND.json`:

> Use the Agent tool: `subagent_type: browzer:explorer`, prompt:
> "Run find-skills **programmatic discovery** (§0) for feature `<feat-id>`. Scan installed skills under `.claude/skills/`, `.claude/plugins/`, and `~/.claude/skills/`. Match against the feature domain. Save ONLY invocable skill names (not marketplace URLs) to `docs/browzer/<feat-id>/staging/SKILLS_FOUND.json`. Return one line: `explorer: <N> installed skills matched; path: docs/browzer/<feat-id>/staging/SKILLS_FOUND.json`."

The goal is skills agents can invoke via `Skill(...)` — installed skills only. The output must never contain marketplace links or `npx skills add` commands.

`execute-task` (Phase 3) and downstream skills consume `SKILLS_FOUND.json` so each specialist receives a deterministic skill-path list rather than re-discovering on every dispatch. This prevents per-task skill-discovery divergence and keeps dispatch prompts lean.

Best-effort — if the explorer dispatch fails or `SKILLS_FOUND.json` is absent after the agent returns, continue without it and emit a warning in the closure block. Do not block the pipeline on a prefetch failure.

## Autonomous-mode rules

When `CONFIG.mode == autonomous` (or `$MODE=autonomous` held from S2):

- The orchestrator MUST NOT call `AskUserQuestion` between phases.
- Pause only when a phase skill explicitly returns `status: PAUSED_PENDING_OPERATOR`.
- **Empty stdout + exit code 0** from any `browzer ... --quiet` command IS success — proceed without verification. Do not re-run the command or request confirmation. Verify with `browzer get-step <PHASE> --id <feat>` only when the immediately following phase reads that artifact back.
- Do not insert any "shall I continue?" or "does this look right?" checkpoints unless the pipeline is in `review` mode.

## Phases 1–10 — Loop

For each pipeline phase in order:

1. Invoke the phase skill via the Skill tool with `args: <feature-id>` ONLY (basename of `$FEAT_DIR`, e.g. `feat-20260507-foo`). The Skill arg substitutes literally as `$ARGUMENTS` into shell commands inside the skill body — extra tokens break `--id` parsing. Skills load their context via `browzer get-step <PHASE> --id $ARGUMENTS` and read `executionStrategy` from `browzer get-step CONFIG` when needed.
2. Wait for the skill to return its one-line cursor.
3. Confirm the artifact exists at the expected staging path.
4. If the autosave hook reported a validation error (rewake message), surface the error and re-dispatch the skill with the failure context.

Never re-cite a skill's body in chat — pass artifact paths and let the next skill load via `browzer get-step`.

### Parallel groups from task plan

After `generate-task` completes and `staging/TASKS_MANIFEST.json` is persisted, read the artifact via `browzer get-step TASKS_MANIFEST --id <feat> --json`. Examine the `parallelizable[]` array — it contains groups of task IDs with no file-scope overlap, ready to run concurrently.

- **If `parallelizable[]` is non-empty and `CONFIG.executionStrategy` is `serial` or `parallel`:** the task plan discovered parallelizable groups that the chosen strategy may not fully exploit. In review mode, notify the operator; in autonomous mode, log as an advisory but continue. The strategy was committed at workflow init time; reversing it mid-pipeline is not supported.
- **If `parallelizable[]` is empty:** the task plan found no parallelizable pairs — strategy choice (serial or otherwise) is well-aligned with the plan. Proceed as-is.

Example task plan advisory (autonomous mode):
> `generate-task: 8 tasks written; strategy=serial; note: parallelizable groups detected in [[TASK_02, TASK_03, TASK_05], ...] — consider re-running with parallel-worktrees strategy for better throughput.`

### Mid-workflow entry

Operator says "execute TASK_03" / "commit what I staged" / "update the docs" → jump straight to that phase skill. Skip earlier phases. Confirm the prerequisite artifacts exist; if missing, surface a one-line error.

### Stop conditions

- Phase returns `status: PAUSED_PENDING_OPERATOR` → emit pause cursor, exit.
- Phase returns `status: FAILED` after one retry → emit failure cursor, exit.
- After `commit` with `status: COMPLETED` → emit closure block (cursor + gate-status table + "What was NOT verified") and stop. The `<feat>/README.md` written by `finalize-feature` is included in the commit.

## Closure block

Four parts on completion. Each numbered section MUST be emitted exactly ONCE. If finalize-feature's `<feat>/README.md` already contains an equivalent section, omit it from the chat closure to avoid duplication. The orchestrator's closure is the SOLE surface for sections 3 and 4 — finalize-feature's README is the SOLE surface for the human-readable feature summary.

1. One-line cursor: `orchestrate-task-delivery: pipeline complete; <N> phases written; SHA <sha> ready for operator-driven push`
2. Markdown table: one row per canonical phase, status `RAN | SKIPPED <reason> | FAILED <reason>`.
3. `### What was NOT verified` — enumerate remote/out-of-band gates the local pipeline never ran (CI, integration suite when scoped, e2e, security review). Emit ONCE; do not repeat per phase or per task.
4. `### Blast-radius receipts` — non-blocking check. Iterate `scope[]` files ONCE across all TASK_NN; emit one warning line per missing receipt. Do NOT iterate per-task and concatenate — that produces N copies of the same warning when a file appears in multiple tasks.

   Algorithm (deduplicating pass):
   1. Collect raw paths from `union(TASK_NN.scope[])` across every TASK_NN step. **Prefer reading the per-task persisted view `browzer get-step TASK_NN --id <feat>` over `TASKS_MANIFEST.tasks[].scope` so late `execution.scopeAdjustments[]` are captured.**
   2. **Normalize each path before deduplication**: strip a leading `./`, strip any trailing `/`, and resolve to repo-relative POSIX form (equivalent to `path.posix.normalize`). Build the dedupe `Set<file>` from normalized paths only — variants like `./foo`, `foo`, and `foo/` MUST collapse to one entry.
   3. For each unique normalized file in the set, verify `/tmp/rdeps-<sanitized-path>.json` exists (`test -f /tmp/rdeps-$(echo "$F" | tr '/' '_').json`).
   4. Emit at most ONE warning line per missing receipt: `WARN: blast-radius receipt missing for <file> — deps --reverse was not run`.

   Do NOT fail the pipeline over missing receipts; record the warning and continue.

   **Glossary note**: `scope[]` is the TASK CUE field — a flat array of repo-relative file paths the task is authorized to modify. There is no nested `scope.files[]` shape; do not invent one.

## Non-negotiables

- Output language: English. Conversational wrapper follows operator's language.
- No application code in the orchestrator.
- No silent skips. A genuinely n/a phase records `status: SKIPPED` with rationale.
- No inline gate-failure fixes. Dispatch `receiving-code-review`.
- `finalize-feature` runs AFTER `feature-acceptance` and BEFORE `commit`. It writes the human-readable `<feat>/README.md` summary — the committable artifact included in the feature commit.
- `commit` is the last phase.
- Skills must map 1:1 with the `browzer` CLI surface — never invent step types or config keys.
