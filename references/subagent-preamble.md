# Subagent preamble — workflow dispatch contract

A reusable brief the workflow skills (`orchestrate-task-delivery`, `execute-task`, occasionally `update-docs`) include in every code-subagent dispatch. Its purpose is to avoid re-writing the same 120-line "here are the repo invariants, here is the report schema, here is the formatter rule" preamble in every dispatch prompt.

**How to use it.** The dispatching skill is a file in this plugin; Claude reads it via its own file tools before dispatching. The subagent, however, runs in a separate session whose CWD is the user's repo — not the plugin directory — so it **cannot resolve plugin-relative paths** on its own.

Consequence: the dispatcher's procedure is:

1. In the dispatcher's own context, `Read` this file (at `../skills/orchestrate-task-delivery/SKILL.md` or wherever the dispatcher sits, the path is `../references/subagent-preamble.md` relative to any `skills/<name>/SKILL.md`).
2. In the subagent prompt, **paste** the content of §Step 1 through §Step 5 verbatim — or a task-tailored distillation when the full preamble would blow the prompt budget (§Step 4, the `workflow.json` payload schema, is mandatory to include regardless).
3. Do **not** ship a path and tell the subagent "Read this file" — the path will not resolve.

The dispatcher adds a short per-dispatch prompt (role, task, scope, gates, context snippets from `browzer explore`) BEFORE the pasted preamble, and a task-specific Scope/Do-NOT-touch block AFTER. The preamble is the stable middle.

---

## Step 1 — Anchor on the target repo's rules

Before editing any code:

1. Read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` at the repo root — the "Cross-cutting invariants" section (or equivalent) is authoritative.
2. Read the nearest per-package / per-app `CLAUDE.md` for every directory your Scope block touches. Those carry the package-local rules the root doc defers to.
3. Run `browzer search "<topic>"` before touching any library, framework, or configuration syntax you did not author. Training data may be stale or not match the pinned version. `/tmp/search.json` is the receipt; don't pretend you searched if you didn't.

If a rule in the dispatching skill's prompt conflicts with a rule in `CLAUDE.md`, follow `CLAUDE.md` and flag the conflict in `workflow.json` (`scopeAdjustments` entry on your owned step — see §Step 4). `CLAUDE.md` is the repo's source of truth; the skill prompt is a proxy that may be stale.

---

## Step 2 — Capture baseline BEFORE editing anything

Run the repo's declared quality gates **scoped to your Scope block**. Never run the repo-wide gate command when your Scope is a subset of files / packages — the signal-to-noise is poor and wall-clock cost scales with repo size, not with your change. On medium monorepos this can be the difference between a 20-second baseline and a 10-minute one.

**Discovery order for the gate command**:

1. **The dispatching skill passes scoped gate commands in the prompt — use those verbatim.** This is the preferred path; the orchestrator has already computed the right filter set from `task.explorer.filesModified` + owning packages.
2. **Discover the toolchain from the repo** and pick the scoped form:
   - pnpm + Turborepo → `pnpm turbo lint typecheck test --filter=<pkg>` (single pkg) or `--filter='...[origin/main]'` (affected graph).
   - Yarn classic / npm → inspect `package.json` scripts first. Prefer `yarn lint <paths>` / `npm run lint -- <paths>` when the script accepts args; otherwise target a sub-path the script already honors.
   - Nx → `nx affected:lint` + `nx affected:test` + `nx affected:build`.
   - Go → `go vet ./<pkg>/...` + `go test ./<pkg>/...`.
   - Python (ruff + pytest) → `ruff check <paths>` + `pytest <path>` (or `pytest -k <keyword>`).
   - Cargo → `cargo check -p <crate>` + `cargo test -p <crate>` + `cargo clippy -p <crate>`.
3. **Else** fall back to framework defaults (`pnpm turbo lint typecheck test` / `go test ./...` / etc.) AND log `scopeAdjustments[]` with `reason: "no scoped gate command discoverable in repo"`. Repo-wide fallback should be an explicit recorded decision, not silent.

**Progressive-tracking tools** (`betterer`, `knip` in baseline mode, `madge` tracker mode, `danger` with config-enforced thresholds, and similar) amplify wall-clock without local feedback gain. If you detect these wired into the repo's `lint` / `typecheck` / `test` scripts, log a suggestion to `scopeAdjustments[]` (`reason: "<tool> detected in <script>; consider moving to CI-only"`) and proceed. **Do NOT edit the repo's scripts** — that's outside your Scope block.

Record the result (pass counts, lint 0/N, typecheck pass/fail) in `gates.baseline` — you'll diff against this in Step 4.

If baseline is red for reasons unrelated to your task, STOP and hand back — don't cascade broken state into your own work. Flag it under `scopeAdjustments` with `reason: "baseline red, not my fault"`.

---

## Step 2.5 — Regression-diff contract (mandatory)

After Step 4's post-change gate run completes, you owe the orchestrator a structured `gates.regression` object — it's the only signal that lets a clean autonomous gate distinguish "your changes introduced N new failures" from "the baseline was already red on N unrelated files". The dogfood retros where subagents grepped diffs by hand to attribute pre-existing 429 lint warnings + 12 test fails are exactly what this contract prevents.

The fields are simple subtraction:

```
regression.lint    = postChange.lint.failures   - baseline.lint.failures
regression.tests   = postChange.tests.failures  - baseline.tests.failures
regression.types   = postChange.types.errors    - baseline.types.errors
```

Emit `gates.regression` as a JSON object alongside `gates.baseline` and `gates.postChange`. If `gates.baseline` is non-null and `gates.regression` is null in the payload you write, your step has not satisfied this contract — the orchestrator's `validate_regression` helper (sourced from `references/jq-helpers.sh`) will fail the step at gate-merge.

When any regression count is > 0, list the offending files under `gates.regressionEvidence[]` (one entry per finding with `{file, type, message}`). Don't paper over a regression with summary text — a green step that hides reds is worse than a red step that surfaces them. The orchestrator can decide to widen scope, retry, or escalate; it can't decide on signal you didn't emit.

---

## Step 3 — Touch only what Scope names

The dispatching skill's prompt has two blocks: `Scope — only touch` and `Do NOT touch`. Take both literally.

- Files not in Scope → untouched, even if the bug you're fixing has its root cause there.
- Files in "Do NOT touch" → untouched even if your change would be cleaner with an edit there.

If a gate failure makes it physically impossible to finish without leaving Scope, STOP. Return status `adjusted` with a specific `scopeAdjustments` entry. The orchestrator decides whether to widen the task or split it — that decision is not yours.

**Exception**: integration glue ≤ 15 lines — a barrel export, a one-line import, a config key — may be edited even if the file isn't in Scope. Anything beyond that: adjust, don't expand.

---

## Step 4 — Verify, then update workflow.json

Re-run every Step 2 gate command with identical arguments. Build a regression table:

| Gate | Baseline | Post-change | Delta | Status |
| ---- | -------- | ----------- | ----- | ------ |
| lint | pass | pass | — | ok |
| typecheck | pass | pass | — | ok |
| unit tests | 47 pass | 49 pass | +2 | ok |

Any regression beyond the task's stated tolerance (default 10%) is a failure — don't report `COMPLETED` if a gate went red or a test count dropped. Either fix it (yourself if it's a one-line bug; escalate if it's a design issue) or return `blocked` with a precise description of what blocked you.

**Update your step in workflow.json** using jq + atomic rename. The `> "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"` pattern (which expands at runtime to `… > <feat>/workflow.json.tmp && mv <feat>/workflow.json.tmp <feat>/workflow.json`) is the **only** sanctioned way to mutate the file — never `Read` / `Write` / `Edit` it.

The jq filter MUST assign every field on `.task.execution` directly. Do NOT use a generic merge (`(. + $update)`) — merges silently swallow the case where the subagent forgot to populate a sub-field (the orchestrator then sees nulls and has to backfill manually). The assignment shape below makes missing fields a hard error inside jq, which is what you want:

```bash
WORKFLOW="$FEAT_DIR/workflow.json"
jq --arg id "$STEP_ID" \
   --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '(.steps[] | select(.stepId==$id)) |= (
        .status = "COMPLETED"
      | .completedAt = $now
      | .task.execution = {
          agents: [ ... ],
          files: { created: [], modified: [...], deleted: [] },
          gates: { baseline: {...}, postChange: {...}, regression: [] },
          invariantsChecked: [...],
          scopeAdjustments: [...],
          fileEditsSummary: {...},
          testsRan: {...},
          nextSteps: "..."
        }
    )
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Concretely, after the redirect the temp file lives at `<feat>/workflow.json.tmp` and `mv` renames it back to `<feat>/workflow.json` atomically. If the jq fails for ANY reason, the temp file is left for inspection and `<feat>/workflow.json` stays untouched.

See `packages/skills/references/workflow-schema.md` §4 for the full `task.execution` payload shape. Every field listed there is REQUIRED if it would otherwise be empty; use `[]` or `null` explicitly instead of omitting. **Subagents that omit `.task.execution` entirely fail the F8 contract** — the orchestrator should not have to backfill it.

In worktree-isolated parallel dispatch, `$WORKFLOW` points to your worktree's copy; the orchestrator merges at rendezvous. Never read or write another subagent's step.

Each `invariantsChecked` entry is a rule you quoted verbatim from `CLAUDE.md` (or equivalent), plus the file + section you got it from, plus a status:

- `passed` — your diff respects it.
- `not-applicable` — rule is real but your diff doesn't touch its area.
- `needs-review` — you're uncertain; the orchestrator must verify before closing the task.

If you skipped a rule because it's not in your area, still list it with `not-applicable` — a readable absence beats a guessable one.

---

## Step 5 — Return one line, then stop

Your final chat message is one line:

```
<skill>: updated workflow.json <stepId>; status COMPLETED; files <created>/<modified>
```

Or, on failure:

```
<skill>: workflow.json update blocked — <one-line cause>
hint: <one next step>
```

No recap of what you built. No file list. No TODO block. No "Next steps". The workflow.json is the structured record; the orchestrator reads it when it needs to decide. Full detail lives on disk; the chat line is the cursor.

This matches the plugin's `README.md` §"Skill output contract" rules (at `../README.md` relative to this file) — the same discipline the workflow skills themselves follow.

---

## Formatter delegation

Do **not** run `biome check --write`, `prettier --write`, `ruff format`, `rustfmt`, `gofmt`, etc. as a gate. In Browzer-initialized repos (the common case when this preamble fires), a PostToolUse `Edit|Write` hook (the plugin's `auto-format.mjs`, shipped in `../hooks/guards/` relative to this file) runs the repo's formatter in-loop after every Edit/Write — running it again as a gate is pure duplication and adds ~1-2 seconds per dispatch.

Keep these as gates:

- Linter **rule checks** (not format-fixes) — `biome lint`, `eslint --no-fix`, `ruff check` (without `--fix`), `golangci-lint run`, etc.
- Typecheck — `pnpm typecheck`, `tsc --noEmit`, `mypy`, `go vet`, `cargo check`.
- Tests — `pnpm test`, `pytest`, `go test ./...`, `cargo test`.
- Build — only when the task actually changed build inputs.

If the repo is NOT Browzer-initialized (`.browzer/config.json` missing), or the operator has `BROWZER_HOOK=off`, keep the formatter run as a gate. The dispatching skill tells you which case applies.

---

## Parallel-safety

If the dispatching skill told you to work in an isolated worktree (`isolation: "worktree"`), you already have one — just operate inside it. The orchestrator cleans up afterward.

If you're running alongside other subagents without worktree isolation, touch only your Scope files. Do not edit shared configuration files (barrel exports, vitest config, `turbo.json`, CI workflows) unless Scope explicitly lists them — those are the common collision points. If an edit to a shared file is required, flag it under `scopeAdjustments` and let the orchestrator decide.

---

## Browzer first, training data last

For every library / framework / config syntax you touch in this repo, the sequence is:

1. `browzer search "<topic>" --save /tmp/search.json` — project's own doc corpus, authoritative for this version.
2. `browzer explore "<symbol or concern>"` — repo's own code, authoritative for "how do we do X here".
3. Context7 (if installed and if browzer returned nothing) — third-party library docs pinned to the project's version.
4. Your training data — last resort, note "assumed from training data, not verified" in `scopeAdjustments`.

Skipping the first two and writing "how I remember the library working" is the single most common cause of drift in this plugin's retros. Don't.

---

## What this preamble does NOT cover

Per-task specifics — the exact lines to change, the test case to add, the file path to create — come from the dispatching skill's prompt. That skill has the context this preamble can't have (the PRD, the task spec, the browzer context the orchestrator gathered). If the dispatching prompt contradicts this preamble on a tactical point (e.g., it says "format the file after editing" even though an auto-format hook exists), follow the prompt and flag the contradiction; the orchestrator can update the preamble if the pattern recurs.


### Optional: self-populate `.elapsedMin` at step completion

When you finish a step (set `status: "COMPLETED"` and `completedAt`), include the elapsed-minutes field in the same jq mutation so the orchestrator's Step 7 roll-up does not have to backfill:

```bash
jq --arg id "$STEP_ID" '
  .steps |= map(
    if .stepId == $id then
      ((.startedAt | fromdateiso8601) as $s
       | (.completedAt | fromdateiso8601) as $e
       | .elapsedMin = (($e - $s) / 60 | floor))
    else . end)
' "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

The orchestrator will still backfill any step that did not set `.elapsedMin` itself.
