---
name: receiving-code-review
description: "Consumes `codeReview.findings[]` from the previous CODE_REVIEW step and dispatches per-domain fix agents through a 7-step escalation ladder. Each fix agent receives the finding body, the source file, browzer deps + mentions, and the relevant skill from `finding.assignedSkill`. Findings successfully resolved end as `status: fixed`; findings that exhaust all fix attempts are recorded as `status: tech_debt`. Use after `code-review` and before `write-tests`. Triggers: receive code review, apply code review fixes, fix the findings, close the review, fix-findings, address review feedback, resolve code review."
argument-hint: "<featureId>"
---

You are a fix-dispatch controller. Close every finding from CODE_REVIEW on a 7-step model-escalation ladder.

## Read context

```
!`browzer get-step CODE_REVIEW --id $ARGUMENTS`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-my-feature`); it is also the directory name under `docs/browzer/`.

The blob lists every finding with severity, file, deps, mentions, and `assignedSkill`. Process highest severity first.

## File-overlap pre-check (MUST run before any dispatch)

Before dispatching any fix agent, build a file-overlap map from the findings list:

```
overlapMap = {}
for each finding F in codeReview.findings[]:
  for each file in F.filesChanged (or F.file if no filesChanged):
    overlapMap[file] = overlapMap[file] ?? []
    overlapMap[file].push(F.id)
```

Any file that appears in `overlapMap[file].length >= 2` is a **contested file**. Findings whose fix touches a contested file MUST be dispatched **serially** — each fixer for that subset runs to completion (its `staging/RECEIVING_CODE_REVIEW.<finding-id>.json` must exist on disk) before the next overlapping fixer starts.

### Dispatch modes

| Condition | Mode |
|---|---|
| No contested files | Parallel — dispatch all fixers simultaneously |
| Some contested files | Split: non-overlapping findings dispatch in parallel; contested-file findings dispatch serially within the contested subset |
| All findings share a file | Fully serial — one fixer at a time |

### Serial-completion signal

The receiving-code-review controller detects fixer completion by polling for the per-finding scratch file:

```
docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.<finding-id>.json
```

Do NOT dispatch the next overlapping fixer until this file exists on disk for the current one. The fixer is contractually bound to emit this file as soon as its escalation ladder resolves (see `agents/fixer.md` — Binding emit-on-completion contract).

### Worked example — 2 findings touching the same file

Suppose CODE_REVIEW returns three findings:

```
F-1: file = src/routes/auth.ts   severity = high
F-2: file = src/routes/auth.ts   severity = medium
F-3: file = src/utils/helpers.ts severity = low
```

Building the overlap map:
```
overlapMap = {
  "src/routes/auth.ts":   ["F-1", "F-2"],   ← contested (2 findings)
  "src/utils/helpers.ts": ["F-3"]            ← safe (1 finding)
}
```

Dispatch plan:
1. F-3 dispatches in parallel with the contested-file leader.
2. F-1 (highest severity in contested set) dispatches first; F-2 waits.
3. Controller polls: does `staging/RECEIVING_CODE_REVIEW.F-1.json` exist?
   - YES → dispatch F-2.
   - NO  → wait (re-check every ~15s or on next agent wake).
4. F-2 completes → aggregation proceeds.

This ordering guarantees no two fixers write conflicting edits to `src/routes/auth.ts` simultaneously.

## Iteration ladder (per finding)

The full step-by-step ladder lives in `references/iteration-ladder.md`. Summary:

1. sonnet attempt — `reason: "initial"`
2. sonnet retry with explicit failure context — `reason: "retry"`
3. sonnet + research dispatch (WebSearch / Context7) — `reason: "research-then-sonnet"`
4. opus attempt — `reason: "initial"` (iteration=2)
5. opus retry — `reason: "retry"` (iteration=2)
6. opus + research dispatch — `reason: "research-then-opus"`
7. tech-debt log (only after the prior six exhaust) — record under `finding.tech_debt: true`

`dispatches[].reason` enum (from CUE schema): `initial | retry | research-then-sonnet | research-then-opus | staging-regression | post-deploy | operator-feedback`. Use the appropriate value for each ladder step. Do NOT use any other values — they will fail CUE validation.

Haiku is forbidden for fix dispatch. Zero-tech-debt is the default; reaching step 7 requires recorded justification.

Spawn each fix attempt with `subagent_type: browzer:fixer`. For ladder steps 1–3 use `model: sonnet`; for steps 4–6 use `model: opus`. Set `effort: xhigh` for `high`-severity findings; `effort: high` for `medium` and `low`.

### Dispatch reason mapping

Every `dispatches[i]` entry MUST record a `reason` from this exact 7-value enum:

| Ladder step | `reason` value |
|---|---|
| Step 1 — initial sonnet | `initial` |
| Step 2 — sonnet retry | `retry` |
| Step 3 — research + sonnet | `research-then-sonnet` |
| Step 4 — initial opus | `initial` |
| Step 5 — opus retry | `retry` |
| Step 6 — research + opus | `research-then-opus` |
| Post-deploy re-open | `post-deploy` |
| Operator-triggered re-run | `operator-feedback` |
| Regression introduced after fix | `staging-regression` |

Any value outside this enum fails CUE validation and `save-step` will reject the payload. Use `--hint-fixes` to get a worked example when validation fails.

## Tech-debt taxonomy

When a finding cannot be fixed, classify it into one of two sub-types based on `iterations[]` length:

| Sub-type | `iterations[]` length | Meaning |
|---|---|---|
| `scope_deferred` | 1 | Intentionally out-of-scope for this feature cycle. One iteration recorded; `rationale` field required. Valid terminal state — do NOT penalize in validation or scoring. |
| `ladder_exhausted` | 6 | All six ladder steps attempted and failed. Every iteration documented with failure trace. |

Classification rule: if the fix agent was instructed to skip the ladder (deferred by design), set `techDebtSubtype: "scope_deferred"` and record `rationale`. If the full 7-step ladder ran to exhaustion, set `techDebtSubtype: "ladder_exhausted"`. No other values are valid.

## Per-finding output

Each fix agent writes a scratch file immediately upon completing its escalation ladder:

```
docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.<finding-id>.json
```

**Required before Write** — invoke `Read ${CLAUDE_PLUGIN_ROOT}/skills/receiving-code-review/template.md` BEFORE composing the staging payload. The template is auto-generated from the workflow CUE schema and is the canonical scaffold. Fields not present in `template.md`'s field reference are dropped on `save-step`. Do not paste schema-claiming JSON inline into this body; reference the template instead.

The fixer is bound to emit this file **as soon as the ladder resolves** — NOT batched at the end of all findings. The serialization controller above depends on this to detect completion and release the next overlapping fixer. See `agents/fixer.md` — Binding emit-on-completion contract.

Tech-debt entries in the per-finding file MUST include a `techDebtSubtype` field:

```json
{
  "findingId": "F-3",
  "status": "tech_debt",
  "techDebtSubtype": "scope_deferred",
  "rationale": "Auth refactor is planned for a future task; not in scope here.",
  "iterations": [{ "step": 1, "model": "sonnet", "outcome": "deferred" }]
}
```

```json
{
  "findingId": "F-7",
  "status": "tech_debt",
  "techDebtSubtype": "ladder_exhausted",
  "iterations": [
    { "step": 1, "model": "sonnet", "outcome": "failed" },
    { "step": 2, "model": "sonnet", "outcome": "failed" },
    { "step": 3, "model": "sonnet", "outcome": "failed" },
    { "step": 4, "model": "opus",   "outcome": "failed" },
    { "step": 5, "model": "opus",   "outcome": "failed" },
    { "step": 6, "model": "opus",   "outcome": "failed" }
  ]
}
```

Do not emit `techDebtSubtype` on `status: fixed` entries.

**Note on autosave**: per-finding files are scratch and do NOT autosave. The autosave hook's `STAGING_RE` (`/docs\/browzer\/([^/]+)\/staging\/([A-Z_0-9]+)\.(md|json)$/`) requires the phase segment to match `[A-Z_0-9]+` — a dot (`.`) does not match, so `RECEIVING_CODE_REVIEW.<finding-id>.json` filenames are intentionally excluded. Use per-finding files as the source of truth for the aggregator step below, but do not rely on the hook to persist them.

## Aggregator (final)

After all findings are processed, merge all per-finding scratch files into the canonical aggregated file:

```
docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.json
```

**Required before Write** — invoke `Read ${CLAUDE_PLUGIN_ROOT}/skills/receiving-code-review/template.md` BEFORE composing the staging payload. The template is auto-generated from the workflow CUE schema and is the canonical scaffold. Fields not present in `template.md`'s field reference are dropped on `save-step`. Do not paste schema-claiming JSON inline into this body; reference the template instead.

The aggregated summary block MUST include a `techDebtBreakdown` object counting each sub-type:

```json
{
  "summary": {
    "fixed": 5,
    "total": 7,
    "unrecovered": 2,
    "techDebtBreakdown": {
      "scopeDeferred": 1,
      "ladderExhausted": 1
    }
  }
}
```

`scopeDeferred + ladderExhausted` MUST equal `summary.unrecovered`. An aggregated file without `techDebtBreakdown` is a contract violation and MUST NOT be accepted by the aggregator or downstream validators.

The autosave hook validates and persists only `RECEIVING_CODE_REVIEW.json` (the aggregated file — its phase segment contains no dot and matches `STAGING_RE`).

## Persistence

The autosave hook persists `staging/RECEIVING_CODE_REVIEW.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — RECEIVING_CODE_REVIEW is load-bearing: `write-tests` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- File-overlap map was built and serial dispatch applied to all contested-file finding subsets.
- Every finding has a per-finding JSON file.
- The aggregated JSON has `summary.fixed + summary.unrecovered == summary.total`.
- Every tech-debt entry carries a `techDebtSubtype` field (`scope_deferred` or `ladder_exhausted`) and an `iterations[]` whose length matches the sub-type: 1 for `scope_deferred`, 6 for `ladder_exhausted`.
- The aggregated `summary` includes `techDebtBreakdown: { scopeDeferred: N, ladderExhausted: M }` where `N + M == summary.unrecovered`. An aggregated output missing `techDebtBreakdown` is a contract violation.

Return one line: `receiving-code-review: <fixed> fixed, <techDebt> tech-debt; <totalIterations> iterations`.

Your turn is incomplete until `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.<finding-id>.json` exists for every finding and `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.json` (aggregated) exists on disk. Do not stop to summarize or investigate further after writing it.
