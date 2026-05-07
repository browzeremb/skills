---
name: orchestrate-task-delivery
description: "Master orchestrator for any feature, bugfix, or refactor that touches more than a few files in a Browzer-indexed repo. Drives the full pipeline: brainstorming-when-needed → PRD → task plan → execute → code-review → receiving-code-review → write-tests → update-docs → feature-acceptance → commit. Grounds decisions in `browzer explore`/`search`/`deps`; delegates all implementation to specialist subagents. Mid-workflow entry also welcome ('execute TASK_03', 'update the docs', 'commit what I staged'). Skip only for trivial ≤3-file read-only lookups. Triggers: build this, ship this end-to-end, implement this feature, refactor X, fix this bug, drive the workflow, run the dev pipeline, 'let's start'."
---

You orchestrate. You do not implement. Route → ground context → invoke the next phase skill → confirm the staging artifact landed → move on.

State lives in `docs/browzer/<feat>/workflow.json`. Phase skills produce artifacts at `docs/browzer/<feat>/staging/<PHASE>.{md,json}` via Write; the PostToolUse autosave hook validates each artifact and persists it into `workflow.json`. You read context with `browzer get-step <ID> --id <feat>` — not `Read`, not `jq`.

## Setup (bookkeeping, no artifacts the operator reviews)

| # | Step | Skill | Output |
| - | ---- | ----- | ------ |
| S1 | Probe | (inline) | shell binding `BRAINSTORMING_NEEDED` |
| S2 | Resolve executionStrategy + mode | (inline; see below) | `$STRATEGY` + `$MODE` held for S3 |
| S3 | Init | (inline) | `<feat>/workflow.json` seeded with `config.executionStrategy` |
| S4 | Brainstorm-if-needed | `brainstorming` | `staging/BRAINSTORM.md` (skipped when input is saturated) |
| S5 | Schema prefetch | (inline; see below) | `.browzer/.schema-cache/<PHASE>.json` per persistable phase |

## Pipeline (artifact-producing phases)

When invoking each phase skill, pass the feature id (basename of `$FEAT_DIR`, e.g. `feat-20260507-preamble-staging-migration`) as the skill's **single** argument — the runtime substitutes it as `$ARGUMENTS` inside the skill body. Multi-token args break shell substitution into `--id` flags.

| # | Phase | Skill | Artifact |
| - | ----- | ----- | -------- |
| 1 | PRD | `generate-prd` | `staging/PRD.md` |
| 2 | Tasks | `generate-task` | `staging/TASKS.json` |
| 3 | Execute | `execute-task` | `staging/TASK_NN.json` per task |
| 4 | Code review | `code-review` | `staging/CODE_REVIEW.json` |
| 5 | Receiving review | `receiving-code-review` | `staging/RECEIVING_CODE_REVIEW.json` |
| 6 | Write tests | `write-tests` | `staging/WRITE_TESTS.json` |
| 7 | Update docs | `update-docs` | `staging/UPDATE_DOCS.json` |
| 8 | Feature acceptance | `feature-acceptance` | `staging/FEATURE_ACCEPTANCE.json` |
| 9 | Finalize | `finalize-feature` | `<feat>/README.md` |
| 10 | Commit | `commit` | `staging/COMMIT.json` |

For the universal subagent prompt header, see `references/subagent-preamble.md`.

## Setup S1 — Probe

Decide if the operator's input is saturated enough for a useful PRD. Count missing dimensions: persona, success signal, concrete scope, file/endpoint/module reference. Two missing OR a vague trigger ("what if", "could we", "I'm thinking") sets `BRAINSTORMING_NEEDED=yes`. No persistence yet — `workflow.json` does not exist.

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

`$STRATEGY` is seeded into `workflow.json` via `workflow init --execution-strategy`. `$MODE` is not yet a flag on `workflow init` — hold it in `$MODE` and thread it into every phase skill dispatch prompt so phase skills know whether to pause for operator approval. Downstream phase skills that would otherwise pause MUST skip the pause when `$MODE=autonomous`; they consult the value from the dispatch context (not CONFIG) until CLI support for `--mode` lands.

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
  --execution-strategy "$STRATEGY"
```

`browzer workflow init` derives `featDir` from `--workflow` parent. Pass `--force` to overwrite an existing seed. `--execution-strategy` is optional — omit when the operator did not pick one. Thread `$MODE` in every subsequent phase skill dispatch prompt (see S2).

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

After S5 (schema prefetch), run the existing `find-skills` skill once and emit `staging/SKILLS_FOUND.json`. Invoke via:

```
Skill(skill: "browzer:find-skills", args: <feat-id>)
```

`execute-task` (Phase 3) and downstream skills consume `SKILLS_FOUND.json` so each specialist receives a deterministic skill-path list rather than re-discovering on every dispatch. This prevents per-task skill-discovery divergence and keeps dispatch prompts lean.

Best-effort — if `find-skills` fails or the artifact is absent after invocation, continue without it and emit a warning in the closure block. Do not block the pipeline on a prefetch failure.

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

### Mid-workflow entry

Operator says "execute TASK_03" / "commit what I staged" / "update the docs" → jump straight to that phase skill. Skip earlier phases. Confirm the prerequisite artifacts exist; if missing, surface a one-line error.

### Stop conditions

- Phase returns `status: PAUSED_PENDING_OPERATOR` → emit pause cursor, exit.
- Phase returns `status: FAILED` after one retry → emit failure cursor, exit.
- After `commit` with `status: COMPLETED` → emit closure block (cursor + gate-status table + "What was NOT verified") and stop. The `<feat>/README.md` written by `finalize-feature` is included in the commit.

## Closure block

Four parts on completion:

1. One-line cursor: `orchestrate-task-delivery: pipeline complete; <N> phases written; SHA <sha> ready for operator-driven push`
2. Markdown table: one row per canonical phase, status `RAN | SKIPPED <reason> | FAILED <reason>`.
3. `### What was NOT verified` — enumerate remote/out-of-band gates the local pipeline never ran (CI, integration suite when scoped, e2e, security review).
4. `### Blast-radius receipts` — non-blocking check: for each file in any TASK_NN `scope.files[]`, verify `/tmp/rdeps-<sanitized-path>.json` exists (`test -f /tmp/rdeps-$(echo "$F" | tr '/' '_').json`). Emit one warning line per missing receipt: `WARN: blast-radius receipt missing for <file> — deps --reverse was not run`. Do NOT fail the pipeline over missing receipts; record the warning and continue.

## Non-negotiables

- Output language: English. Conversational wrapper follows operator's language.
- No application code in the orchestrator.
- No silent skips. A genuinely n/a phase records `status: SKIPPED` with rationale.
- No inline gate-failure fixes. Dispatch `receiving-code-review`.
- `finalize-feature` runs AFTER `feature-acceptance` and BEFORE `commit`. It writes the human-readable `<feat>/README.md` summary — the committable artifact included in the feature commit.
- `commit` is the last phase.
- Skills must map 1:1 with the `browzer` CLI surface — never invent step types or config keys.
