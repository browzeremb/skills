---
name: regression-guard
description: "Post-fix host-quality-gate re-runner. Executes the host's lint+typecheck+test (and full-tier build) over the aggregate post-fix diff after `receiving-code-review` lands every fix. Failures emit synthetic HIGH findings into `staging/review/CODE_REVIEW.md` and loop back through the receiving-code-review fix ladder for round 2/3 (max 3 rounds total). State-machine bypasses the skill entirely when `staging/fixes/` is empty. Runs identically across all tiers — mutation testing is removed from the workflow; this skill is the empirical regression net. Triggers: regression guard, validate aggregate diff, re-run quality gate, gate fixes, post-fix lint+typecheck+test, check for regressions after fixes."
argument-hint: "<featureId>"
---

# Regression guard — post-fix host quality gate

> **Why this exists.** Each fixer in `receiving-code-review` is
> dispatched in isolation against its assigned finding. Two non-overlapping
> fixers can land semantically conflicting changes; a fixer may
> inadvertently break a sibling test or introduce a type error the
> per-task quality gate (under `execute-task`) never saw. This skill
> re-runs the host's quality gate over the **aggregate post-fix diff**
> as the last empirical net before `feature-acceptance`. Failures are
> not silently absorbed — they become normal `CODE_REVIEW.md` findings
> that flow back through the existing 7-step fix ladder. Bounded by
> three rounds total before a hard HALT.

This skill runs identically across all three tiers (`express`,
`standard`, `full`). The host-detected gate is the same chain
`execute-task` uses; the only delta for full tier is that `build` is
added to the gate when public API drifted during a TASK.

---

## Inputs

- `$ARGUMENTS` is `<featureId>` matching `^feat-\d{8}-[a-z0-9-]+$`.
- The skill **does not read PRD.md or EXPLORATION.md**. It reads only:
  - `staging/CONFIG.md` — for `tier` and `regressionGuardRound`.
  - `staging/review/CODE_REVIEW.md` — to know which findings the
    fixers were dispatched against (so the round-N findings can be
    correlated back to the original round-1 findings).
  - `staging/fixes/FIXES.md` — for the index of fixers that ran in
    this round.
  - The live git diff (working tree vs `HEAD`, or `merge-base..HEAD`).

## Output contract

- `staging/review/GATE_REPORT.md` (always when the skill runs) — gate
  command output + structured `gateResults: {lint, typecheck, test,
  build?}` frontmatter + `round: <N>`.
- `staging/review/CODE_REVIEW.md` (in-place patch when gate fails) —
  new findings appended to `frontmatter.findings[]` with
  `lane: regression-guard, round: <N>` so the next fixer round picks
  them up.
- `staging/.regression-guard-rerun` (sentinel when gate fails and
  `round < 3`) — read by the next `detect-phase` cycle to route back to
  `receiving-code-review`. **Deleted** by `receiving-code-review` on
  entry to prevent stale-sentinel reentry.
- `staging/CONFIG.md.regressionGuardRound` (incremented on each
  loop-back).

## State-machine bypass

The orchestrator's `detect-phase.mjs` routes around this skill entirely
when `staging/fixes/` is empty. Rationale: the per-task quality gate
(under `execute-task`) already validated the diff at task-completion
time, and the code-review lanes found zero findings, so there is
nothing post-fix to validate.

You DO NOT need to handle that case in this skill body — when this skill
is invoked, by contract at least one fix file exists. Defensive:
if `fixes/F-*.md` glob returns empty when the skill body runs, write a
trivial `GATE_REPORT.md` with `gateResults: {}` and `notes: "empty
fixes/ — regression-guard had nothing to validate"`, then exit.

---

## Step 1 — Resolve the quality-gate commands

Invoke the cross-skill detector:

```bash
node "${CLAUDE_PLUGIN_ROOT}/references/scripts/detect-quality-gate.mjs" \
  --json \
  $TIER_BUILD_FLAG \
  > /tmp/regression-guard-${FEAT_ID}-gate.json
```

Where `$TIER_BUILD_FLAG` is `--build` if `CONFIG.tier == full`, blank
otherwise.

The script returns one JSON object:

```json
{
  "runner": "turbo" | "pnpm" | "npm" | "yarn" | "go" | "cargo" | "pytest" | "unknown",
  "lint":      ["pnpm", "turbo", "lint", "--filter=..."],
  "typecheck": ["pnpm", "turbo", "typecheck", "--filter=..."],
  "test":      ["pnpm", "turbo", "test", "--filter=..."],
  "build":     ["pnpm", "turbo", "build", "--filter=..."]    // only when --build requested
}
```

If `runner == "unknown"`, skip Step 2 and write `gateResults: {}` with
`notes: "no detectable quality gate; skipping regression-guard"`. Do
NOT emit findings.

## Step 2 — Run each gate command sequentially

For each command in `[lint, typecheck, test, build]` (build only when
present): execute via the `Bash` tool, capture stdout+stderr, classify
as `pass` (exit 0) or `fail` (non-zero exit). Capture the last ~200
lines of output per command for the `GATE_REPORT.md` body.

The commands run **in the host repo root**, against the current working
tree. Do not stash or check out — the fixers already committed in
sequence (or left edits in the working tree per the executionStrategy);
`regression-guard` must see exactly what `feature-acceptance` and the
operator's `git commit` will see next.

## Step 3 — Write `GATE_REPORT.md`

Use `${CLAUDE_SKILL_DIR}/template.md` as the body shape. The frontmatter
carries:

```yaml
---
featureId: <feat>
round: <N>                          # 1 on first run, 2/3 on reruns
generatedAt: <RFC3339>
runner: <runner from detect-quality-gate output>
gateResults:
  lint: pass | fail | n/a
  typecheck: pass | fail | n/a
  test: pass | fail | n/a
  build: pass | fail | n/a          # only present when full tier
correlatedFixes: [F-001, F-002, ...]  # all F-NNN ids referenced by fixes/FIXES.md
---
```

`n/a` is used when the detector returned an empty command list for that
slot (e.g. host has no `lint` script).

## Step 4 — On failure, emit synthetic findings

For each `gateResults.<cmd> == fail`, append one entry to
`staging/review/CODE_REVIEW.md.frontmatter.findings[]`:

```yaml
- id: F-<next sequential>
  severity: high
  lane: regression-guard
  ruleId: gate-<cmd>-regression
  round: <current-round>
  title: "Post-fix regression: <gate command> failed after applying fixes F-NNN..F-MMM"
  description: |
    <last ~30 lines of gate output, code-fenced>

    Correlated fixers (this round): <comma-separated F-NNN list>
  pinsFiles: []
  fix: ""
```

Use `aggregate-findings.mjs`'s shape (the `round` field is a new
optional addition, backward-compatible default `round: 1` for pre-existing
findings).

## Step 5 — Round management

Read `CONFIG.md.regressionGuardRound`:

- **First run** (`round == 1`): if gate passed, do not write a sentinel
  — orchestrator routes to `feature-acceptance` next cycle. If gate
  failed, set `round = 2`, write `staging/.regression-guard-rerun`,
  increment `CONFIG.regressionGuardRound`, and exit. Orchestrator
  routes back to `receiving-code-review` for round 2 fixers.
- **Round 2**: same logic. Promote to `round = 3` on failure.
- **Round 3 on failure**: do NOT write the sentinel. Instead write
  `GATE_REPORT.md` with the `## HALT` block in the body and exit 0.
  Orchestrator's `detect-phase` sees `gateResults.* == fail` AND
  `regressionGuardRound == 3` AND no `gateOverride` field on
  `ACCEPTANCE.md`, then HALTs with the operator-facing nudge:

  ```
  regression-guard: exceeded max rounds (3); operator must inspect or
  pass --override-gate to feature-acceptance.
  ```

The operator's escape hatch: re-invoke `/feature-acceptance <feat>
--override-gate` to record the override in
`ACCEPTANCE.md.frontmatter.gateOverride: {reason: ..., operator: ...}`,
which routes past row #12b in the state machine.

## Step 6 — Update `CONFIG.md`

After every run, atomic-write the new `regressionGuardRound` value back
into `CONFIG.md`. The orchestrator's state machine reads this value to
decide whether row #12b's HALT triggers.

---

## Closure principle

This skill MUST NOT read `planning/EXPLORATION.md` or
`planning/PRD.md`. The closure-violations audit
(`scripts/audit/closure-violations.mjs`) rejects any reference to those
paths in this skill body or its scripts.

The skill MAY read:

- `staging/CONFIG.md` — for tier + round counter (mutable, re-read
  every invocation).
- `staging/review/CODE_REVIEW.md` — to know the findings the fixers
  closed.
- `staging/fixes/FIXES.md` — for the fixer index of the most recent
  round.
- `staging/fixes/F-*.{completed,tech_debt}.md` — for the per-fix
  pinsFiles[] mapping used to correlate gate failures back to their
  authoring fix.

## References

Cross-cutting (loaded by ≥2 skills):

- `${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md` — phase position
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — paths
- `${CLAUDE_PLUGIN_ROOT}/references/scripts/detect-quality-gate.mjs` — gate command resolver
