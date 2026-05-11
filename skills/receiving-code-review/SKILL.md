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

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob lists every finding with severity, file, deps, mentions, and `assignedSkill`. Process highest severity first.

## Iteration ladder (per finding)

The full step-by-step ladder lives in `references/iteration-ladder.md`. Summary:

1. sonnet attempt
2. sonnet retry with explicit failure context
3. sonnet + research dispatch (WebSearch / Context7)
4. opus attempt
5. opus retry
6. opus + research dispatch
7. tech-debt log (only after the prior six exhaust) — record under `finding.tech_debt: true`

Haiku is forbidden for fix dispatch. Zero-tech-debt is the default; reaching step 7 requires recorded justification.

Spawn each fix attempt with `subagent_type: browzer:fixer`. For ladder steps 1–3 use `model: sonnet`; for steps 4–6 use `model: opus`. Set `effort: xhigh` for `high`-severity findings; `effort: high` for `medium` and `low`.

## Tech-debt taxonomy

When a finding cannot be fixed, classify it into one of two sub-types based on `iterations[]` length:

| Sub-type | `iterations[]` length | Meaning |
|---|---|---|
| `scope_deferred` | 1 | Intentionally out-of-scope for this feature cycle. One iteration recorded; `rationale` field required. Valid terminal state — do NOT penalize in validation or scoring. |
| `ladder_exhausted` | 6 | All six ladder steps attempted and failed. Every iteration documented with failure trace. |

Classification rule: if the fix agent was instructed to skip the ladder (deferred by design), set `techDebtSubtype: "scope_deferred"` and record `rationale`. If the full 7-step ladder ran to exhaustion, set `techDebtSubtype: "ladder_exhausted"`. No other values are valid.

## Per-finding output

Each fix agent writes a scratch file:

```
docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.<finding-id>.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

Tech-debt entries in the per-finding file MUST include a `techDebtSubtype` field:

```json
{
  "findingId": "F-3",
  "status": "tech_debt",
  "techDebtSubtype": "scope_deferred",
  "rationale": "Auth refactor is planned for feat-next-auth; not in scope here.",
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

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body. Any field not present there is dropped on save.

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

- Every finding has a per-finding JSON file.
- The aggregated JSON has `summary.fixed + summary.unrecovered == summary.total`.
- Every tech-debt entry carries a `techDebtSubtype` field (`scope_deferred` or `ladder_exhausted`) and an `iterations[]` whose length matches the sub-type: 1 for `scope_deferred`, 6 for `ladder_exhausted`.
- The aggregated `summary` includes `techDebtBreakdown: { scopeDeferred: N, ladderExhausted: M }` where `N + M == summary.unrecovered`. An aggregated output missing `techDebtBreakdown` is a contract violation.

Return one line: `receiving-code-review: <fixed> fixed, <techDebt> tech-debt; <totalIterations> iterations`.

Your turn is incomplete until `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.<finding-id>.json` exists for every finding and `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.json` (aggregated) exists on disk. Do not stop to summarize or investigate further after writing it.
