# Code-subagent preamble

Paste this into every implementation-agent dispatch: `execute-task`, `receiving-code-review`, `write-tests`. It is a stable contract — do not paraphrase.

---

## Step 0 — Load domain skills (BLOCKING — before any Read, Edit, or browzer call)

Your dispatch prompt carries `skillsFound[]` (per-domain skill paths discovered by the Explorer pass) AND/OR a `Skill to invoke:` line naming a specific skill. **Before any other action, you MUST invoke each high- and medium-relevance skill via the `Skill` tool and follow its guidance for the rest of your work.**

Concretely:

1. Parse the `skillsFound[]` (or `Skill to invoke:`) from your dispatch prompt.
2. For each entry in relevance order (`high` → `medium` → `low`), call `Skill(<name>)`. The skill's content loads and presents to you — follow it directly. Never use `Read` on the skill file.
3. Where multiple skills cover overlapping ground, follow the most-specific one first; surface conflicts in `scopeAdjustments[]`.
4. Skipping Step 0 = drift. The "training data last" fallback only applies AFTER all listed skills have been loaded AND don't address the question.
5. The orchestrator's consolidator and post-step audits MAY drop output from a subagent whose trace shows zero `Skill()` invocations when `skillsFound[]` was non-empty — silently writing code without loading domain conventions is a contract violation.

If `skillsFound[]` is empty AND no `Skill to invoke:` line was provided, skip Step 0 and proceed to Step 1.

---

## Step 1 — Anchor on the target repo's rules

Before editing any code:

1. Read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` at the repo root — the "Cross-cutting invariants" section (or equivalent) is authoritative. Always read this in full.
2. For per-package / per-app `CLAUDE.md`: FIRST run `browzer search '<package or area> invariants'` and `browzer explore '<package> conventions'`. Read the per-package doc in full ONLY when (a) the search returns no relevant chunks, OR (b) Scope explicitly modifies invariant-bearing files (RBAC seed, billing migrations, security middleware).
3. Run `browzer search "<topic>"` before touching any library, framework, or configuration syntax you did not author. Training data may be stale or not match the pinned version. `/tmp/search.json` is the receipt; don't pretend you searched if you didn't.

If a rule in the dispatching skill's prompt conflicts with a rule in `CLAUDE.md`, follow `CLAUDE.md` and flag the conflict in `workflow.json` (`scopeAdjustments` entry on your owned step — see §Step 4). `CLAUDE.md` is the repo's source of truth; the skill prompt is a proxy that may be stale.

---

## Step 2 — Capture baseline BEFORE editing anything

Run the repo's declared quality gates **scoped to your Scope block**. Never run the repo-wide gate command when your Scope is a subset of files / packages.

**Discovery order for the gate command**:

1. **The dispatching skill passes scoped gate commands in the prompt — use those verbatim.** This is the preferred path.
2. **Discover the toolchain from the repo** and pick the scoped form:
   - pnpm + Turborepo → `pnpm turbo lint typecheck test --filter=<pkg>` (single pkg) or `--filter='...[origin/main]'` (affected graph).
   - Yarn classic / npm → inspect `package.json` scripts first. Prefer `yarn lint <paths>` / `npm run lint -- <paths>`.
   - Nx → `nx affected:lint` + `nx affected:test` + `nx affected:build`.
   - Go → `go vet ./<pkg>/...` + `go test ./<pkg>/...`.
   - Python (ruff + pytest) → `ruff check <paths>` + `pytest <path>`.
   - Cargo → `cargo check -p <crate>` + `cargo test -p <crate>` + `cargo clippy -p <crate>`.
3. **Else** fall back to framework defaults AND log `scopeAdjustments[]` with `reason: "no scoped gate command discoverable in repo"`.

Record the result (pass counts, lint 0/N, typecheck pass/fail) in `gates.baseline`. If baseline is red for reasons unrelated to your task, STOP and hand back — flag it under `scopeAdjustments` with `reason: "baseline red, not my fault"`.

---

## Step 2.5 — Regression-diff contract (mandatory)

After Step 4's post-change gate run completes, you owe the orchestrator a structured `gates.regression` object:

```
regression.lint    = postChange.lint.failures   - baseline.lint.failures
regression.tests   = postChange.tests.failures  - baseline.tests.failures
regression.types   = postChange.types.errors    - baseline.types.errors
```

Emit `gates.regression` as a JSON object alongside `gates.baseline` and `gates.postChange`. If `gates.baseline` is non-null and `gates.regression` is null in the payload you write, the step has not satisfied this contract.

When any regression count is > 0, list the offending files under `gates.regressionEvidence[]` (one entry per finding with `{file, type, message}`).

---

## Step 2.5b — Loop-escape rule (mandatory)

When the same failure fingerprint repeats across consecutive iterations:

1. **Track the failure fingerprint** — the assertion message, DB constraint name, typecheck error code + path, or test ID + first stacktrace frame.
2. **On the 3rd consecutive iteration with the same fingerprint**, stop and choose ONE of:
   - `Skill('testing-strategies')` — for test-setup, fixture-isolation, or assertion-shape issues.
   - `Skill('systematic-debugging')` — for unknown runtime state (concurrency, environment, state machine).
   - **Return `status: blocked`** with the constraint quoted verbatim, iteration count, and one-line hypothesis.
3. **Do not silently retry past iteration 3.**

Encode under `gates.loopEscape` when triggered:

```jsonc
"loopEscape": {
  "fingerprint": "<verbatim assertion / constraint / typecheck / test-id>",
  "iterations": 3,
  "action": "blocked",
  "nextHint": "<one-line hypothesis>"
}
```

---

## Step 3 — Touch only what Scope names

The dispatching skill's prompt has two blocks: `Scope — only touch` and `Do NOT touch`. Take both literally.

- Files not in Scope → untouched, even if the bug's root cause is there.
- Files in "Do NOT touch" → untouched even if your change would be cleaner with an edit there.

If a gate failure makes it impossible to finish without leaving Scope, STOP. Return status `adjusted` with a specific `scopeAdjustments` entry.

**Exception**: integration glue ≤ 15 lines — a barrel export, a one-line import, a config key — may be edited even if the file isn't in Scope.

---

## Step 4 — Verify, then update workflow.json

Re-run every Step 2 gate command with identical arguments. Build a regression table (lint / typecheck / unit tests baseline vs post-change). Any regression beyond the task's stated tolerance (default 10%) is a failure.

**Update your step in workflow.json** using jq + atomic rename — the ONLY sanctioned mutation pattern:

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

See `packages/skills/references/workflow-schema.md` §4 for the full `task.execution` payload shape. Every field is REQUIRED if it would otherwise be empty; use `[]` or `null` explicitly. **Subagents that omit `.task.execution` entirely fail the F8 contract.**

Each `invariantsChecked` entry: rule quoted verbatim from `CLAUDE.md`, file + section, status (`passed` / `not-applicable` / `needs-review`).

### Mandatory: stamp `startedAt` BEFORE the work begins

The first jq mutation on a step MUST set `startedAt`. Pattern:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq --arg id "$STEP_ID" --arg now "$NOW" \
   '(.steps[] | select(.stepId==$id)) |= (.status = "RUNNING" | .startedAt = $now)
    | .currentStepId = $id
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

---

## Step 4.5 — Partial-status emission (mandatory when truncated)

If you created or modified files but did NOT reach the Step 4 atomic write, your **last output line MUST be**:

```jsonc
{"status": "partial", "filesCreated": ["<path>", ...], "filesModified": ["<path>", ...], "filesDeleted": ["<path>", ...], "lastCheckpoint": "<short phrase>", "blockedOn": "<optional>"}
```

One JSON object, last line of output, no trailing prose, no markdown fence. Include `filesDeleted` even when empty. Emit this BEFORE any Step 5 confirmation line. If you DID reach Step 4 successfully, do NOT emit this object.

---

## Step 5 — Return one line, then stop

```
<skill>: updated workflow.json <stepId>; status COMPLETED; files <created>/<modified>
```

Or on failure:

```
<skill>: workflow.json update blocked — <one-line cause>
hint: <one next step>
```

No recap, no file list, no TODO block, no "Next steps". The workflow.json is the structured record.
