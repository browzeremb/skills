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

## Per-finding output

Each fix agent writes:

```
docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.<finding-id>.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

## Aggregator (final)

After all findings are processed, write the merged file:

```
docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body. Any field not present there is dropped on save.

The autosave hook validates and persists RECEIVING_CODE_REVIEW.json.

## Persistence

The autosave hook persists `staging/RECEIVING_CODE_REVIEW.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — RECEIVING_CODE_REVIEW is load-bearing: `write-tests` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- Every finding has a per-finding JSON file.
- The aggregated JSON has `summary.fixed + summary.techDebt == total findings`.
- Tech-debt entries each carry an `iterations[]` of length 6 documenting the exhausted ladder.

Return one line: `receiving-code-review: <fixed> fixed, <techDebt> tech-debt; <totalIterations> iterations`.
