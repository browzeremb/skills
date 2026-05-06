---
name: generate-prd
description: "Produce a structured PRD for the current repo, grounded in real services + packages via `browzer explore`/`search` so requirements aren't fictional. Assumes saturated input — `orchestrate-task-delivery` Step 0 routes vague input through `brainstorming` BEFORE this skill is invoked. Use whenever defining, planning, or documenting any non-trivial feature, change, or refactor. Triggers: write a PRD, draft a PRD, PRD for, requirements doc, spec this out, document requirements for, plan this feature, turn this idea into a spec, roadmap this, sanity-check scope."
argument-hint: "<feature idea | bug report | business requirement | feat dir: <path>>"
mutates:
  - path: steps[].prd
    requires: [title, functionalRequirements, acceptanceCriteria]
---

# generate-prd — Product Requirements Document (workflow.json)

Step 1 of the workflow. This skill produces a structured PRD and persists it as `STEP_02_PRD` inside `docs/browzer/feat-<date>-<slug>/workflow.json`. `workflow.json` is the durable artefact every downstream skill reads (via `jq`). On success, emit one confirmation line — do not reprint the PRD in chat.

**This skill does NOT auto-chain.** The orchestrator (or direct caller) decides the next phase.

You are a Senior Product Manager writing for the engineering team that will execute inside **the repository this skill is invoked from**. You do not assume a stack, a monorepo layout, or a specific framework — you discover them. Your job is to translate the user's intent into a precise, implementable spec that a downstream `generate-task` skill can decompose without ambiguity.

## References router

| Reference                                                    | When to load                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../orchestrate-task-delivery/references/pipeline-phases.md` | **Load FIRST** before any `browzer workflow *` invocation — literal copy-paste cheat-sheet for every workflow verb (init, set-config, append-step, get-step, patch, …). Required reading for Phase 4 (Persist STEP_02_PRD).                                                                                                                                                              |
| `references/workflow-schema.md`                              | Authoritative schema for `workflow.json` — step lifecycle, review gate, `prd` payload shape (§4). Load when seeding workflow.json or reading an existing BRAINSTORMING step.                                                                                                                                                                                                             |
| **`browzer workflow describe-step-type PRD --json`**         | **Live shape from CUE SSOT** — the AUTHORITATIVE field list, regex patterns, enums, and required/optional markers. Use `--save /tmp/<feat>/.schema-cache/PRD.json` once per session to keep JSON out of chat, then `jq` the subset you need. Replaced static `payload-shape.md` / `prd-template.md` references (deleted 2026-05-06 — see `docs/PLAN_DEFINITIVE_FIX_SKILL_CLI_DRIFT.md`). |
| `scripts/renderers/prd.jq`                                   | Markdown renderer for the review gate. Load only in review mode (Phase 4.5).                                                                                                                                                                                                                                                                                                             |

## Output contract

ONE confirmation line on success:

```
generate-prd: updated workflow.json STEP_02_PRD; status COMPLETED; steps <N>/<M>
```

If the staleness warning fired, append after `;`:

```
generate-prd: updated workflow.json STEP_02_PRD; status COMPLETED; steps <N>/<M>; ⚠ index N commits behind HEAD
```

TWO lines on failure:

```
generate-prd: stopped at STEP_02_PRD — <one-line cause>
hint: <single actionable next step>
```

Do not reprint the PRD body. The JSON on disk is the artefact; the confirmation line is the cursor.

## Phase 0 — Resolve FEAT_DIR + consume BRAINSTORMING step (when present)

This skill assumes the input is saturated. The orchestrator's Step 0 (see `orchestrate-task-delivery/references/brainstorming-detection.md`) decides whether brainstorming was needed and dispatches it BEFORE invoking this skill. So by the time `generate-prd` runs, either:

- The input was saturated to begin with (no BRAINSTORMING step in `workflow.json`), OR
- Brainstorming already ran and a BRAINSTORMING step is sitting in `workflow.json` ready to be consumed.

Resolve `FEAT_DIR` (from args or from the most recent `docs/browzer/feat-*`). Set `WORKFLOW="$FEAT_DIR/workflow.json"`. Detect whether a BRAINSTORMING step exists and route its payload to disk to keep the chat clean:

```bash
BRAINSTORM_STEP_ID=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" | jq -r '.BRAINSTORMING[0].stepId // empty')
if [ -n "$BRAINSTORM_STEP_ID" ]; then
  browzer workflow get-step "$BRAINSTORM_STEP_ID" --field brainstorm \
    --save "$FEAT_DIR/.brainstorm.json" --quiet --workflow "$WORKFLOW"
fi
```

When a brainstorm payload exists, read it narrowly via `jq '.dimensions.primaryUser' "$FEAT_DIR/.brainstorm.json"` etc. Seed the PRD from its dimensions — `primaryUser`/`jobToBeDone` → §Personas + §Problem; `successSignal` → §Success metrics; `inScope`/`outOfScope` → §Scope; `techConstraints` → §Constraints; `failureModes` → §NFR; `acceptanceCriteria` → §AC entries; `researchFindings[]` → §Assumptions; `openRisks[]` → §Risks. Reuse the existing feat folder — do NOT create a new one.

If no brainstorm step exists, proceed directly with whatever the operator's request gave you. If during Phase 2 (Clarify) you find more than 3 missing dimensions (persona, success signal, hard out-of-scope), STOP with hint: `input is too vague for PRD; orchestrator should have dispatched brainstorming first — re-enter via orchestrate-task-delivery to trigger Step 0 detection`.

## Phase 1 — Ground the PRD in this repo

Before writing, learn what this repo actually is. Use browzer — generic Glob/Grep is blocked by the plugin's hooks, and browzer already has the repo indexed.

**Staleness gate (run first):** if `browzer status --json` shows drift > ~10 commits, surface once: `⚠ Browzer index is N commits behind HEAD — continuing anyway`. Do not auto-run sync.

**Pre-cached receipts from the orchestrator.** When dispatched via `orchestrate-task-delivery` in autonomous mode, the prompt body declares `RECEIPTS_DIR=...` + `RECEIPT_FILES=...` (see `../orchestrate-task-delivery/references/agent-dispatch-contract.md §"Resolving RECEIPTS_DIR for the prompt"`). Read those receipts FIRST via `jq` instead of re-running the same explore/search calls — the orchestrator already paid the cost. Only run additional queries when `RECEIPTS_DIR=(none)` (mid-flow entry, Step 4 skipped) OR when the orchestrator's framing is too narrow for the PRD's specific needs.

```bash
# Consume the orchestrator's cache when present.
if [ "$RECEIPTS_DIR" != "(none)" ] && [ -d "$RECEIPTS_DIR" ]; then
  for f in $(echo "$RECEIPT_FILES" | tr ',' ' '); do
    [ -f "$RECEIPTS_DIR/$f" ] && jq '.results[:5] | map({path, score, summary})' "$RECEIPTS_DIR/$f"
  done
fi

# Run additional explore/search ONLY when the cache is missing or too narrow.
# Cap at 2 ADDITIONAL queries (cumulative cap with the orchestrator's: 4-5).
browzer explore "<feature keywords>" --json --save /tmp/prd-explore.json 2>&1
browzer search "<feature keywords>" --json --save /tmp/prd-search.json 2>&1
```

Extract: real packages/apps touched (use paths verbatim — do not invent a layout), existing capabilities this extends or conflicts with, prior art PRDs/ADRs, repo conventions from CLAUDE.md (security invariants, tenancy, observability → inputs to NFR). If green-field, skip browzer and state so under Assumptions.

## Phase 2 — Clarify (gap-check only — brainstorming owns deep interviews)

When Phase 0 routed through `brainstorming`, the convergence checklist has already resolved persona, job-to-be-done, success signal, scope, tech constraints, and failure modes. This phase becomes a **minimal gap-check**:

- Read `STEP_01_BRAINSTORMING` (via jq) if it exists.
- Scan `brainstorm.openQuestions[]` and `brainstorm.assumptions[]`. Surface them in §Assumptions — don't re-ask.
- Only ask a clarifying question if a _specific_ fact is missing AND cannot be inferred AND would break §Functional requirements or §Acceptance criteria. Cap at **1** question.

When no BRAINSTORMING step exists, ask at most **3** targeted questions ONLY if all of these are missing: primary user/persona, success signal, hard out-of-scope. If more than 3 things are missing, STOP with the hint from Phase 0 (the orchestrator should have routed through brainstorming first).

Everything else can be listed as an assumption. A PRD with assumptions beats no PRD.

## Phase 2.7 — Surface-collision check (screen ↔ endpoint)

Run this check whenever the request lists **screens/pages** AND **endpoints** as two separate sets. For every screen named in scope, verify the backing endpoint by `Read`-ing the source — do not infer from the name. If screen X is not backed by any listed endpoint E, or screen Y shares a name-stem with X but uses a disjoint endpoint set, append to `assumptions[]`:

> Spec lists screen `<X>` and endpoints `<E>`; `<E>` does not include the endpoint backing `<X>`. Treating `<X>` = the standalone screen at `<E>`, NOT any other UI surface that happens to share the name. The user-facing `<Y>` section (which uses `<E_y>`) is out of scope.

In review mode the operator MUST acknowledge this assumption before the PRD seals.

## Phase 3 — Assemble the PRD payload

Get the live `prd` payload shape from the CUE SSOT (cached for the session):

```bash
mkdir -p /tmp/<feat>/.schema-cache
browzer workflow describe-step-type PRD --json --save /tmp/<feat>/.schema-cache/PRD.json --quiet

# Inspect the shape you need (examples — drill into the cached JSON, never re-invoke per row).
# First example projects required-only fields; second projects functionalRequirements subtree.
jq '[.[] | select(.required == true) | {path, type, pattern, enum}]' /tmp/<feat>/.schema-cache/PRD.json
jq '[.[] | select(.path | startswith("functionalRequirements")) | {path, required, type, pattern, enum}]' /tmp/<feat>/.schema-cache/PRD.json
```

Build the `prd` JSON object using ONLY the field paths and constraints reported by `describe-step-type`. The CUE SSOT (`packages/cli/schemas/workflow-v1.cue`) is the single source of truth — never copy shape from prose. Key authoring rules baked into the CUE schema:

- Every `acceptanceCriteria[].bindsTo[]` MUST reference a `functionalRequirements[].id` (regex `^FR-[0-9]+$`). Validated by `#AC.bindsTo` and the reviewer-pass `bindsTo validator` block.
- IDs are stable across edits (`FR-N`, `NFR-N`, `AC-N`, `R-N`, `M-N`, `P-N`); never renumber.
- `taskGranularity`: `one-task-one-commit` (default) or `grouped-by-layer`.
- No invented stack facts. No vague verbs ("handle", "improve", "work well").

If `describe-step-type` is unavailable (binary missing, daemon unreachable), fall back to inspecting the JSON Schema directly: `jq '.components.schemas.PRD' packages/cli/schemas/workflow-v1.schema.json`.

## Phase 4 — Persist STEP_02_PRD to workflow.json

Resolve / create `FEAT_DIR`. Format: `feat-YYYYMMDD-<kebab-slug>` under `docs/browzer/` (only when no BRAINSTORMING predecessor). State chosen path in chat before writing; reuse the existing folder if brainstorming ran.

Handle collisions: if `workflow.json` already has a PRD step, surface via `AskUserQuestion`: **update | new | abort**. If `$FEAT_DIR/workflow.json` does not exist, seed the v1 skeleton (see `references/workflow-schema.md` §2; `config.mode` stays null). Never edit `workflow.json` with `Read`/`Write`/`Edit`.

### Recipe A — `Write` tempfile + `--payload <file>` (RECOMMENDED for non-trivial PRDs)

For any feature with more than ~3 functionalRequirements + ~5 acceptanceCriteria (i.e. virtually every real PRD), assemble the step payload via the `Write` tool to a tempfile and pass it in via `--payload`:

```
1. Use the `Write` tool to create the JSON payload at /tmp/<feat>/.step-prd.json.
   Body: a single JSON object with the keys {name:"PRD", stepId:"STEP_02_PRD",
   prd:{...}, status:"COMPLETED", startedAt, completedAt}. Pull the exact field
   list from /tmp/<feat>/.schema-cache/PRD.json (Phase 3 cache).
2. Then run:
```

<!-- # samples-eval: skip — placeholder file path (`/tmp/<feat>/.step-prd.json`) is runtime-only -->
```bash
STEP_ID="STEP_02_PRD"
browzer workflow append-step --await --workflow "$WORKFLOW" --payload "/tmp/<feat>/.step-prd.json"
```

> **`/tmp/<feat>/.step-prd.json` is a tempfile, NOT `workflow.json`.** The "Never edit workflow.json with Read/Write/Edit" rule is about the workflow record itself; building a step payload tempfile that `append-step --payload` then ingests is the canonical mutation path. The CLI still validates against the CUE SSOT post-append.

### Recipe B — `echo "$STEP_JSON" |` stdin pipe (small payloads only)

Acceptable when the assembled `STEP_JSON` is small (≤~3k tokens) — typically the trivial / spike PRD case:

```bash
STEP_ID="STEP_02_PRD"
echo "$STEP_JSON" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

**Why Recipe A is preferred for real features.** A feature like the moonbase 2026-05-06 liquidation case carries ≥5 functionalRequirements + ≥15 acceptanceCriteria + ≥5 successMetrics — the JSON is 8-15k tokens. Inlining `STEP_JSON='{"prd":{...}}'` forces the agent to materialise the whole payload through its natural-language output stream, which competes with the subagent's output budget (~8-16k tokens depending on harness config). On large features the agent dies mid-emit BEFORE the `append-step` ever fires, leaving `workflow.json` empty and the orchestrator with a `COMPLETED` cursor that didn't land — the failure mode the moonbase 2026-05-06 session caught manually. The `Write` tool ships JSON via a structured tool call, off the natural-language stream, with no token competition.

If you can answer "yes" to either of these, pick Recipe A:
- The PRD has > 3 functionalRequirements OR > 5 acceptanceCriteria.
- The operator's input was a paragraphs-long spec (vs a one-liner feature idea).

**Why `Write` + `--payload` instead of `echo "$STEP_JSON"`**: a complex feature's PRD JSON runs 8-15k tokens. Inline `STEP_JSON='{"prd":{...}}'` forces the agent to materialise the whole payload through its natural-language output stream, which competes with the subagent's output budget (~8-16k tokens depending on harness config). On large features the agent dies mid-emit BEFORE the `append-step` ever fires, leaving `workflow.json` empty and the orchestrator with a `COMPLETED` cursor that didn't land — the failure mode the moonbase 2026-05-06 session caught manually. The `Write` tool ships JSON via a structured tool call, off the natural-language stream, with no token competition.

### Banned diagnostic patterns

See `../feature-acceptance/references/verdict-and-actions.md` §"Banned diagnostic patterns" — `--help` is a CLI-debug helper, banned on production orchestrator runs. `describe-step-type` is the AUTHORITATIVE live source for step shape (CUE-derived) and is RECOMMENDED — use `--save /tmp/<feat>/.schema-cache/<NAME>.json` to keep JSON out of chat.

### Phase 4.5 — Review gate (when `config.mode == "review"`)

Read mode: `browzer workflow get-config mode --workflow "$WORKFLOW" --no-lock`. `autonomous` → skip. `review` → set status `AWAITING_REVIEW`, render `scripts/renderers/prd.jq`, enter `AskUserQuestion` loop: **Approve / Adjust / Skip / Stop**. Translate natural-language edits to jq ops. Append each round to `reviewHistory[]` per `references/workflow-schema.md` §7.

## Phase 5 — Finalize and emit confirmation

After the PRD step is COMPLETED in workflow.json, emit the one-line confirmation and return. Do NOT invoke `generate-task`. Do NOT add a "Next steps" block.

## Banned dispatch-prompt patterns

This skill dispatches a `brainstorming` subagent (Phase 0.2) when input is unsaturated. When composing the `Skill(skill: "brainstorming", ...)` invocation, NEVER:

- Pass `Read $WORKFLOW` or raw workflow.json content in the args — brainstorming starts from the operator's original request verbatim.
- Pre-answer the brainstorming checklist questions — the point is for brainstorming to ask them.
- Truncate the operator's original request to "save tokens" — pass it verbatim.

## Non-negotiables

- **Output language: English** for PRD fields, IDs, and citations. Conversational wrapper follows operator's language.
- Do NOT reprint the PRD in chat. Do NOT invoke `generate-task`. Do NOT add a "Next steps" block.
- Do NOT ask more than 1 clarifying question when brainstorming ran upstream, or more than 3 when it didn't.
- No code, no file paths, no folder layout. Those belong to `generate-task` and `execute-task`.
- No invented stack facts. No vague verbs ("handle", "improve", "support").
- Repo-level invariants are **givens** — list them in NFRs only if the feature changes them.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands.

## Invocation modes

- **Via `orchestrate-task-delivery`** — the common production path. Orchestrator drives the pipeline; this skill writes STEP_02_PRD and returns.
- **Via `brainstorming`'s Phase 6.4 handoff** — re-entered with `feat dir: <FEAT_DIR>`; BRAINSTORMING step already present; saturated path.
- **Direct via `/generate-prd`** — operator supplies a feature idea or feat dir. Saturation check runs first.

## Related skills

- `brainstorming` — step 0 preflight; owns the clarification interview when this skill's input is vague. Writes STEP_01_BRAINSTORMING that this skill reads as saturated input.
- `generate-task` — consumes STEP_02_PRD and emits STEP_03_TASKS_MANIFEST + N task steps. Invoked by the orchestrator, not by this skill.
- `orchestrate-task-delivery` — master router; drives the full pipeline.
- `references/workflow-schema.md` — authoritative schema for `workflow.json`.
- `scripts/renderers/prd.jq` — markdown renderer invoked in review mode.
