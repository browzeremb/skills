---
name: generate-prd
description: "Produce a structured PRD for the current repo, grounded in real services + packages via `browzer explore`/`search` so requirements aren't fictional. Routes through `brainstorming` first when input is vague (no persona, no success signal, no scope). Use whenever defining, planning, or documenting any non-trivial feature, change, or refactor. Triggers: write a PRD, draft a PRD, PRD for, requirements doc, spec this out, document requirements for, plan this feature, turn this idea into a spec, roadmap this, sanity-check scope."
argument-hint: "<feature idea | bug report | business requirement | feat dir: <path>>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(jq *), Bash(mv *), Read, Write, AskUserQuestion
---

# generate-prd — Product Requirements Document (workflow.json)

Step 1 of the workflow. This skill produces a structured PRD and persists it as `STEP_02_PRD` inside `docs/browzer/feat-<date>-<slug>/workflow.json`. `workflow.json` is the durable artefact every downstream skill reads (via `jq`). On success, emit one confirmation line — do not reprint the PRD in chat.

**This skill does NOT auto-chain.** The orchestrator (or direct caller) decides the next phase.

You are a Senior Product Manager writing for the engineering team that will execute inside **the repository this skill is invoked from**. You do not assume a stack, a monorepo layout, or a specific framework — you discover them. Your job is to translate the user's intent into a precise, implementable spec that a downstream `generate-task` skill can decompose without ambiguity.

## References router

| Reference | When to load |
|-----------|-------------|
| [references/prd-template.md](references/prd-template.md) | Full PRD JSON shape, field-by-field authoring guidance with examples. Load during Phase 3 (Assemble PRD payload) before constructing the JSON object. |
| `references/workflow-schema.md` | Authoritative schema for `workflow.json` — step lifecycle, review gate, `prd` payload shape (§4). Load when seeding workflow.json or reading an existing BRAINSTORMING step. |
| `references/renderers/prd.jq` | Markdown renderer for the review gate. Load only in review mode (Phase 4.5). |

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

---

## Phase 0 — Input saturation check (preflight)

A PRD written against a vague input is a PRD full of assumptions, and assumptions become scope drift in `generate-task`. Before doing any work, check whether the input is saturated enough to produce a useful spec — and if not, route to `brainstorming` first.

### 0.1 — Is the input already saturated?

Key signals — **yes** (saturated): `feat dir: <path>` arg + completed BRAINSTORMING step; request ≥ 50 words with a persona OR success signal OR scope; request cites real file paths/endpoints/bugs; caller is `orchestrate-task-delivery` mid-flow. **No** (unsaturated): request < 20 words with no persona/scope/signal; capability named with no definition ("add X"). Tie-breaker: can you list 3 concrete acceptance criteria without inventing facts? If not, treat as unsaturated.

### 0.2 — Routing decision

**Saturated (path A):** continue to Phase 1 directly.

**Unsaturated (path B):** route to `brainstorming`:

> Input looks vague — routing through `brainstorming` first to converge on scope before the PRD.

```
Skill(skill: "brainstorming", args: "<caller's original request verbatim>")
```

When `brainstorming` returns, re-enter this skill with `args: "feat dir: <FEAT_DIR>"`.

If you find yourself asking more than 1 clarifying question inside this skill, you should have routed to `brainstorming` instead.

### 0.3 — Consuming the BRAINSTORMING step when present

Resolve `FEAT_DIR` (from args or from the most recent `docs/browzer/feat-*`). Set `WORKFLOW="$FEAT_DIR/workflow.json"`. Read the brainstorm payload via `jq '.steps[] | select(.name=="BRAINSTORMING") | .brainstorm' "$WORKFLOW"`. Seed the PRD from its dimensions — `primaryUser`/`jobToBeDone` → §Personas + §Problem; `successSignal` → §Success metrics; `inScope`/`outOfScope` → §Scope; `techConstraints` → §Constraints; `failureModes` → §NFR; `acceptanceCriteria` → §AC entries; `researchFindings[]` → §Assumptions; `openRisks[]` → §Risks. Reuse the feat folder — do NOT create a new one.

---

## Phase 1 — Ground the PRD in this repo

Before writing, learn what this repo actually is. Use browzer — generic Glob/Grep is blocked by the plugin's hooks, and browzer already has the repo indexed.

**Staleness gate (run first):** if `browzer status --json` shows drift > ~10 commits, surface once: `⚠ Browzer index is N commits behind HEAD — continuing anyway`. Do not auto-run sync.

```bash
browzer explore "<feature keywords>" --json --save /tmp/prd-explore.json 2>&1
browzer search "<feature keywords>" --json --save /tmp/prd-search.json 2>&1
```

Cap at 2 queries. Extract: real packages/apps touched (use paths verbatim — do not invent a layout), existing capabilities this extends or conflicts with, prior art PRDs/ADRs, repo conventions from CLAUDE.md (security invariants, tenancy, observability → inputs to NFR). If green-field, skip browzer and state so under Assumptions.

---

## Phase 2 — Clarify (gap-check only — brainstorming owns deep interviews)

When Phase 0 routed through `brainstorming`, the convergence checklist has already resolved persona, job-to-be-done, success signal, scope, tech constraints, and failure modes. This phase becomes a **minimal gap-check**:

- Read `STEP_01_BRAINSTORMING` (via jq) if it exists.
- Scan `brainstorm.openQuestions[]` and `brainstorm.assumptions[]`. Surface them in §Assumptions — don't re-ask.
- Only ask a clarifying question if a *specific* fact is missing AND cannot be inferred AND would break §Functional requirements or §Acceptance criteria. Cap at **1** question.

When Phase 0 took the saturated path (no BRAINSTORMING step), ask at most **3** targeted questions ONLY if all of these are missing: primary user/persona, success signal, hard out-of-scope. If more than 3 things are missing, route back through `brainstorming`.

Everything else can be listed as an assumption. A PRD with assumptions beats no PRD.

---

## Phase 2.7 — Surface-collision check (screen ↔ endpoint)

Run this check whenever the request lists **screens/pages** AND **endpoints** as two separate sets. For every screen named in scope, verify the backing endpoint by `Read`-ing the source — do not infer from the name. If screen X is not backed by any listed endpoint E, or screen Y shares a name-stem with X but uses a disjoint endpoint set, append to `assumptions[]`:

> Spec lists screen `<X>` and endpoints `<E>`; `<E>` does not include the endpoint backing `<X>`. Treating `<X>` = the standalone screen at `<E>`, NOT any other UI surface that happens to share the name. The user-facing `<Y>` section (which uses `<E_y>`) is out of scope.

In review mode the operator MUST acknowledge this assumption before the PRD seals.

---

## Phase 3 — Assemble the PRD payload

Load [references/prd-template.md](references/prd-template.md) now — it documents the full JSON shape, field-by-field guidance, and examples. Build a JSON object per the `prd` payload shape (also in `references/workflow-schema.md` §4). Key authoring rules:

- Every FR MUST have at least one AC bound via `bindsTo`. IDs are stable (`FR-N`, `NFR-N`, `AC-N`, …); never renumber.
- `taskGranularity`: `one-task-one-commit` (default) or `grouped-by-layer`.
- No invented stack facts. No vague verbs ("handle", "improve", "work well").

---

## Phase 4 — Persist STEP_02_PRD to workflow.json

Resolve / create `FEAT_DIR`. Format: `feat-YYYYMMDD-<kebab-slug>` under `docs/browzer/` (only when no BRAINSTORMING predecessor). State chosen path in chat before writing; reuse the existing folder if brainstorming ran.

Handle collisions: if `workflow.json` already has a PRD step, surface via `AskUserQuestion`: **update | new | abort**. If `$FEAT_DIR/workflow.json` does not exist, seed the v1 skeleton (see `references/workflow-schema.md` §2; `config.mode` stays null). Append via `browzer workflow append-step --await`. Never edit `workflow.json` with `Read`/`Write`/`Edit`.

### Phase 4.5 — Review gate (when `config.mode == "review"`)

Read mode: `browzer workflow get-config mode --workflow "$WORKFLOW" --no-lock`. `autonomous` → skip. `review` → set status `AWAITING_REVIEW`, render `references/renderers/prd.jq`, enter `AskUserQuestion` loop: **Approve / Adjust / Skip / Stop**. Translate natural-language edits to jq ops. Append each round to `reviewHistory[]` per `references/workflow-schema.md` §7.

---

## Phase 5 — Finalize and emit confirmation

After the PRD step is COMPLETED in workflow.json, emit the one-line confirmation and return. Do NOT invoke `generate-task`. Do NOT add a "Next steps" block.

---

## Banned dispatch-prompt patterns

This skill dispatches a `brainstorming` subagent (Phase 0.2) when input is unsaturated. When composing the `Skill(skill: "brainstorming", ...)` invocation, NEVER:

- Pass `Read $WORKFLOW` or raw workflow.json content in the args — brainstorming starts from the operator's original request verbatim.
- Pre-answer the brainstorming checklist questions — the point is for brainstorming to ask them.
- Truncate the operator's original request to "save tokens" — pass it verbatim.

---

## Non-negotiables

- **Output language: English** for PRD fields, IDs, and citations. Conversational wrapper follows operator's language.
- Do NOT reprint the PRD in chat. Do NOT invoke `generate-task`. Do NOT add a "Next steps" block.
- Do NOT ask more than 1 clarifying question when brainstorming ran upstream, or more than 3 when it didn't.
- No code, no file paths, no folder layout. Those belong to `generate-task` and `execute-task`.
- No invented stack facts. No vague verbs ("handle", "improve", "support").
- Repo-level invariants are **givens** — list them in NFRs only if the feature changes them.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — the common production path. Orchestrator drives the pipeline; this skill writes STEP_02_PRD and returns.
- **Via `brainstorming`'s Phase 6.4 handoff** — re-entered with `feat dir: <FEAT_DIR>`; BRAINSTORMING step already present; saturated path.
- **Direct via `/generate-prd`** — operator supplies a feature idea or feat dir. Saturation check runs first.

## Related skills

- `brainstorming` — step 0 preflight; owns the clarification interview when this skill's input is vague. Writes STEP_01_BRAINSTORMING that this skill reads as saturated input.
- `generate-task` — consumes STEP_02_PRD and emits STEP_03_TASKS_MANIFEST + N task steps. Invoked by the orchestrator, not by this skill.
- `orchestrate-task-delivery` — master router; drives the full pipeline.
- `references/workflow-schema.md` — authoritative schema for `workflow.json`.
- `references/renderers/prd.jq` — markdown renderer invoked in review mode.
