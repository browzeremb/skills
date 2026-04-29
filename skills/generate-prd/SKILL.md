---
name: generate-prd
description: "Produce a structured PRD for the current repo, grounded in real services + packages via `browzer explore`/`search` so requirements aren't fictional. Routes through `brainstorming` first when input is vague (no persona, no success signal, no scope). Use whenever defining, planning, or documenting any non-trivial feature, change, or refactor. Triggers: write a PRD, draft a PRD, PRD for, requirements doc, spec this out, document requirements for, plan this feature, turn this idea into a spec, roadmap this, sanity-check scope."
argument-hint: "<feature idea | bug report | business requirement | feat dir: <path>>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(jq *), Bash(mv *), Read, Write, AskUserQuestion
---

# generate-prd — Product Requirements Document (workflow.json)

Step 1 of the workflow. This skill produces a structured PRD and persists it as `STEP_02_PRD` inside `docs/browzer/feat-<date>-<slug>/workflow.json`. `workflow.json` is the durable artefact every downstream skill reads (via `jq`). On success, emit one confirmation line — do not reprint the PRD in chat.

**This skill does NOT auto-chain.** In prior versions the final step invoked `generate-task`. That has been removed: the orchestrator (or direct caller) decides the next phase.

Output contract: emit ONE confirmation line on success.

You are a Senior Product Manager writing for the engineering team that will execute inside **the repository this skill is invoked from**. You do not assume a stack, a monorepo layout, or a specific framework — you discover them. Your job is to translate the user's intent into a precise, implementable spec that a downstream `generate-task` skill can decompose without ambiguity.

## Step 0 — Input saturation check (preflight)

A PRD written against a vague input is a PRD full of assumptions, and assumptions become scope drift in `generate-task`. Before doing any work, this skill checks whether the input is saturated enough to produce a useful spec — and if not, routes to `brainstorming` first.

### 0.1 — Is the input already saturated?

Look for these signals in the caller's arguments and in the existing workflow.json's `STEP_01_BRAINSTORMING` entry (if present):

| Signal                                                        | Saturated? |
| ------------------------------------------------------------- | ---------- |
| Caller passed `feat dir: <path>` AND workflow.json has a completed BRAINSTORMING step | **yes**    |
| Request ≥ 50 words AND names a persona OR a success signal OR explicit scope | **yes** (probably) |
| Request cites real file paths, an existing endpoint, or a specific bug | **yes**    |
| Request < 20 words AND no persona / scope / success signal    | **no**     |
| Request references a capability with no definition ("add X") and no other context | **no**     |
| Caller is the `orchestrate-task-delivery` skill mid-flow (pre-PRD work already happened) | **yes** |
| Spec lists ≥1 screen AND a separate endpoint set, AND any named screen is backed by an endpoint NOT in the listed set (or two screens share a name-stem with disjoint endpoint backings) | **no — surface collision; see §2.7** |

Be honest about ambiguity. If two signals conflict (e.g. "add a new auth endpoint" — 5 words, but cites a real concept the repo already has), the tie-breaker is: **can you list 3 concrete acceptance criteria without inventing facts?** If not, treat as unsaturated.

### 0.2 — Routing decision

**Saturated (path A):** continue to Step 1 directly. The clarifying step (Step 2) becomes a minimal gap-check, not a deep interview.

**Unsaturated (path B):** route to `brainstorming` and let it own the interview. One line in chat, then invoke:

> Input looks vague — routing through `brainstorming` first to converge on scope before the PRD.

```
Skill(skill: "brainstorming", args: "<caller's original request verbatim>")
```

When `brainstorming` returns it will have written `STEP_01_BRAINSTORMING` to `workflow.json` and set the feat directory. You re-enter this skill with `args: "feat dir: <FEAT_DIR>"`. That re-entry is the saturated path.

This skill does NOT duplicate brainstorming's interview discipline — it defers to the skill that owns that job. If you find yourself asking more than 1 clarifying question inside this skill, you should have routed to `brainstorming` instead.

### 0.3 — Consuming the BRAINSTORMING step when present

Resolve `FEAT_DIR` (from args or from the most recent `docs/browzer/feat-*` that matches context). Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

Read the brainstorm payload via jq:

```bash
BRAINSTORM=$(jq '.steps[] | select(.name=="BRAINSTORMING") | .brainstorm' "$WORKFLOW")
```

Seed the PRD from its dimensions:

- `dimensions.primaryUser`, `dimensions.jobToBeDone` → §5 Personas + §1 Problem.
- `dimensions.successSignal` → §10 Success metrics.
- `dimensions.inScope`, `dimensions.outOfScope` → §4 Scope.
- `dimensions.repoSurface` → PRD header "Repo surface".
- `dimensions.techConstraints` → §9 Constraints.
- `dimensions.failureModes` → §8 NFR failure modes + §12 Risks.
- `dimensions.acceptanceCriteria` → §13 Acceptance criteria (rendered as structured AC entries with IDs).
- `dimensions.dependencies` → `prd.dependencies` payload.
- `researchFindings[]` → §11 Assumptions (quote the agent answers verbatim with confidence markers).
- `assumptions[]`, `openRisks[]` → §11 Assumptions / §12 Risks respectively.

Reuse the feat folder `brainstorming` already created. Do NOT make a new one.

## Step 1 — Ground the PRD in this repo (always first)

Before writing, learn what this repo actually is. Use browzer to do it — generic Glob/Grep is blocked or discouraged by the plugin's hooks, and browzer already has the repo indexed.

**Staleness gate (run first).** Capture drift from any of the three signals below — whichever fires first. If drift is > ~10 commits, surface exactly one user-visible line and proceed:

> ⚠ Browzer index is N commits behind HEAD. Recommended: invoke `Skill(skill: "sync-workspace")` before continuing for higher-fidelity context. Continuing anyway — outputs may reflect stale reality.

Signals, in order of preference:

1. `browzer status --json` → `workspace.lastSyncCommit` is a SHA → diff against `git rev-parse HEAD` via `git rev-list --count <sha>..HEAD`. Most precise.
2. `browzer status --json` → `workspace.lastSyncCommit` is `null` or missing → fire the warning unconditionally with `N = unknown`. The CLI is unable to confirm sync state.
3. Any later `browzer explore` / `search` / `deps` call writes `⚠ Index N commits behind. Run \`browzer sync\`.` to stderr → if the warning has not yet been surfaced this turn, surface it now using the `N` from the stderr line.

Do not auto-run `sync-workspace`. Do not block. Surface the warning at most once per skill invocation, then continue.

```bash
browzer status --json 2>&1
git rev-parse HEAD

browzer explore "<feature keywords>" --json --save /tmp/prd-explore.json 2>&1
browzer search "<feature keywords>" --json --save /tmp/prd-search.json 2>&1
```

Cap at 2 queries for a PRD — you are framing the problem, not designing the solution. From the results extract:

- **Repo surface touched** — the real packages, apps, folders returned by `explore` (top scores). Use those paths verbatim; do not invent a layout.
- **Existing capabilities** this feature extends or conflicts with.
- **Prior art** — any PRD/ADR that covers this area. If present, decide: amend, supersede, or scope around it.
- **Repo conventions** — if `browzer search "conventions"` or similar surfaces a `CLAUDE.md`, `README`, or style guide, note what it says about invariants, tenancy, security, observability. These become inputs to the NFR and Constraints sections.

If the feature is genuinely green-field (user says "new product idea", nothing indexed), skip this step and state it under Assumptions.

## Step 2 — Clarify (gap-check only — brainstorming owns deep interviews)

When Step 0 routed through `brainstorming`, the convergence checklist has already resolved persona, job-to-be-done, success signal, scope, tech constraints, and failure modes. This step becomes a **minimal gap-check**, not a new interview:

- Read `STEP_01_BRAINSTORMING` (via jq) if it exists.
- Scan `brainstorm.openQuestions[]` and `brainstorm.assumptions[]`. Surface them at the top of §11 Assumptions in the PRD — don't re-ask.
- Only ask a clarifying question if a *specific* fact is missing AND cannot be inferred AND would break the PRD's §7 or §13 (functional requirements / acceptance criteria). Cap at **1** question.

When Step 0 took the saturated path (no BRAINSTORMING step), ask at most **3** targeted questions ONLY if all of these are missing:

- Primary user / persona and the concrete job-to-be-done
- Success signal — what makes this feature "working" from the user's point of view
- Hard out-of-scope — what we explicitly don't do, so `generate-task` doesn't over-reach

If more than 3 things are missing, that's a saturation failure — route back through `brainstorming` rather than asking a long chain of questions here.

Everything else can be listed as an assumption and moved on from. A PRD with assumptions beats no PRD.

## Step 2.7 — Surface-collision check (screen ↔ endpoint)

Run this check whenever the brainstorm or the operator's request lists **screens/pages** AND **endpoints** as two separate sets. The Airdrop / AccountAirDrops dogfood retro showed how a name-stem collision between two distinct UI surfaces (`/v1/airdrop` standalone CRUD vs. `AccountRewards` airdrop section using `/v1/referrals/.../air-drops/`) silently broadens the PRD's interpretation and ends up reverting half a task downstream.

For every screen named in scope, identify the endpoints that back it by `Read`-ing the source — do not infer from the name. If EITHER condition holds, append a verbatim `assumptions[]` entry BEFORE the PRD seals:

  (a) The PRD lists screen X AND a set of endpoints E, but the endpoint backing X is not in E.
  (b) Another screen Y shares a name-stem with X (e.g. "AccountAirDrops" vs. "Airdrop") and is backed by a disjoint endpoint set.

The assumption text is exact:

> Spec lists screen `<X>` and endpoints `<E>`; `<E>` does not include the endpoint backing `<X>`. Treating `<X>` = the standalone screen at `<E>`, NOT any other UI surface that happens to share the name. The user-facing `<Y>` section (which uses `<E_y>`) is out of scope.

In autonomous mode this assumption ships as-is — `generate-task` reads it and narrows scope accordingly. In review mode the operator MUST acknowledge the assumption (or amend it) before the PRD seals. The check is cheap (a few `Read` calls); the alternative is a half-applied removal task and a manual `git checkout HEAD --` revert, which the retro logged as the most expensive friction of the run.

## Step 3 — Assemble the PRD payload (matches `workflow.json` schema §4 `prd`)

Build a single JSON object conforming to the `prd` payload shape documented in `references/workflow-schema.md` §4 — discriminated by `name: "PRD"`. Mandatory top-level fields:

```jsonc
{
  "title": "<feature name>",
  "overview": "<1-paragraph problem + vision prose>",
  "personas": [
    { "id": "P-1", "description": "<persona description, one sentence>" }
  ],
  "objectives": ["<measurable objective>", "..."],
  "functionalRequirements": [
    { "id": "FR-1", "description": "<observable behavior>", "priority": "must|should|could" }
  ],
  "nonFunctionalRequirements": [
    { "id": "NFR-1", "category": "perf|security|a11y|observability|scalability|...",
      "description": "<requirement>", "target": "<measurable target>" }
  ],
  "successMetrics": [
    { "id": "M-1", "metric": "<KPI name>", "target": "<value>", "method": "<how measured>" }
  ],
  "acceptanceCriteria": [
    { "id": "AC-1", "description": "<binary demoable condition>", "bindsTo": ["FR-1"] }
  ],
  "assumptions": ["<assumption>", "..."],
  "risks": [
    { "id": "R-1", "description": "<risk>", "mitigation": "<mitigation>" }
  ],
  "deliverables": ["<artifact or surface to be shipped>"],
  "inScope": ["<atomic capability>"],
  "outOfScope": ["<explicit exclusion>"],
  "dependencies": { "external": ["<service>"], "internal": ["<package>"] },
  "taskGranularity": "one-task-one-commit"
}
```

Rules:

- Every functional requirement MUST have at least one matching acceptance criterion via `bindsTo`.
- IDs are stable: `FR-N`, `NFR-N`, `M-N`, `AC-N`, `P-N`, `R-N`. Never renumber.
- `taskGranularity` is a hint for `generate-task`: `one-task-one-commit` (default) or `grouped-by-layer`.
- No invented stack facts. If you haven't seen a file, command, or convention in browzer results, don't claim it exists.
- No vague verbs. "Handle X" / "improve Y" / "work well" are rejected. Every FR must have an observable signal.

## Step 4 — Persist STEP_02_PRD to workflow.json

Resolve / create `FEAT_DIR`:

### 4.1 — Feat folder (only when no BRAINSTORMING predecessor)

Format: `feat-YYYYMMDD-<kebab-slug>` (under `docs/browzer/`).

- `YYYYMMDD` — UTC date, `date -u +%Y%m%d`.
- `<kebab-slug>` — 2–6 words, lowercase ASCII kebab-case, derived from the feature's core noun+verb. No accents, no punctuation, no articles. ≤ 40 chars.

State the chosen path in chat before writing:

> Proposed feat folder: `docs/browzer/feat-20260420-user-auth-device-flow/` — reply with an alternate slug if you want something else, otherwise I'll proceed.

If the operator supplies an override, re-validate it (ASCII, kebab-case, ≤40 chars) and proceed. Don't loop on naming.

### 4.2 — Handle collisions

```bash
FEAT_DIR="docs/browzer/feat-$(date -u +%Y%m%d)-<slug>"
test -d "$FEAT_DIR" && echo "exists" || echo "clear"
```

If the folder exists but `workflow.json` doesn't, continue (we'll seed it). If `workflow.json` already has a PRD step and you're about to overwrite, surface the collision via `AskUserQuestion`: **update | new | abort**. Proceed only after the operator picks.

### 4.3 — Seed workflow.json if missing

If `$FEAT_DIR/workflow.json` does not exist (direct invocation, no brainstorming upstream), create the v1 top-level skeleton exactly as brainstorming does — see `references/workflow-schema.md` §2 for the shape. `config.mode` stays null; the orchestrator fills it.

### 4.4 — Append STEP_02_PRD via jq + mv (atomic)

```bash
WORKFLOW="$FEAT_DIR/workflow.json"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PRD_PAYLOAD='<the JSON object assembled in Step 3>'

STEP=$(jq -n \
  --arg id "STEP_02_PRD" \
  --arg now "$NOW" \
  --argjson prd "$PRD_PAYLOAD" \
  '{
     stepId: $id,
     name: "PRD",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "default path" },
     startedAt: $now,
     completedAt: $now,
     elapsedMin: 0,
     retryCount: 0,
     itDependsOn: (if any(.; true) then ["STEP_01_BRAINSTORMING"] else [] end),
     nextStep: "STEP_03_TASKS_MANIFEST",
     skillsToInvoke: ["generate-prd"],
     skillsInvoked: ["generate-prd"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     prd: $prd
   }')

echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

Never edit `workflow.json` with `Read`/`Write`/`Edit`. Only `browzer workflow *`.

### 4.5 — Review gate (when `config.mode == "review"`)

```bash
MODE=$(browzer workflow get-config mode --workflow "$WORKFLOW" --no-lock)
MODE=${MODE:-autonomous}
```

- `autonomous` → skip this subsection.
- `review` → set `status` to `AWAITING_REVIEW`, render `prd.jq`, enter the gate loop:

```bash
browzer workflow set-status --await "STEP_02_PRD" AWAITING_REVIEW --workflow "$WORKFLOW"

jq -r --from-file references/renderers/prd.jq \
   --arg stepId "STEP_02_PRD" \
   "$WORKFLOW" > "/tmp/review-STEP_02_PRD.md"

cat "/tmp/review-STEP_02_PRD.md"
```

Then via `AskUserQuestion`: **Approve / Adjust / Skip / Stop**. Translate operator's natural-language edits into jq operations against the PRD payload (e.g. "remove the rate-limit FR" → `del(.steps[] | select(.name=="PRD") | .prd.functionalRequirements[] | select(.description | test("rate-limit";"i")))`). Append each round to `reviewHistory[]` per `references/workflow-schema.md` §7. Loop until approved.

## Step 5 — Finalize and hand off

After the PRD step is COMPLETED in workflow.json, emit the one-line confirmation and return. Do NOT invoke `generate-task`. The orchestrator (or direct caller) decides the next phase.

## Step 6 — Emit confirmation

After writing, count completed steps and emit exactly one line:

```
generate-prd: updated workflow.json STEP_02_PRD; status COMPLETED; steps <N>/<M>
```

If the staleness warning fired in Step 1, append it after a `;`:

```
generate-prd: updated workflow.json STEP_02_PRD; status COMPLETED; steps <N>/<M>; ⚠ index N commits behind HEAD
```

On failure, two lines — nothing more:

```
generate-prd: stopped at STEP_02_PRD — <one-line cause>
hint: <single actionable next step>
```

Do not reprint the PRD body. Do not add a "Next steps" block. The JSON on disk is the artefact; the confirmation line is the cursor.

## Constraints on what you write

- **Output language: English.** Render the PRD payload fields, IDs, and citations in English regardless of the operator's input language. The conversational wrapper around the artifact follows the operator's language.
- No code, no schema, no folder layout. Those belong to `generate-task` and `execute-task`.
- No "how to implement" guides. If you catch yourself writing a specific file path as a requirement (e.g. `src/foo/bar.ts`), stop — it belongs in the `generate-task` output.
- No invented stack facts. If you haven't seen a file, a command, or a convention in browzer results, don't claim it exists.
- Repo-level invariants (security rules, layering, testing policy) are **givens** discovered from CLAUDE.md-style docs — list them in `nonFunctionalRequirements` only if the feature changes them; otherwise downstream skills carry them forward.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

## Related skills

- `brainstorming` — step 0 preflight; owns the clarification interview when this skill's input is vague. Writes STEP_01_BRAINSTORMING that this skill reads as saturated input.
- `generate-task` — consumes STEP_02_PRD and emits STEP_03_TASKS_MANIFEST + N task steps. Invoked by the orchestrator, not by this skill.
- `orchestrate-task-delivery` — master router; drives the full pipeline.
- `references/workflow-schema.md` — authoritative schema for `workflow.json`.
- `references/renderers/prd.jq` — markdown renderer invoked in review mode.
