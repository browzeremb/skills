---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics — autonomous mode (agent runs every check) or manual mode (operator runs a how-to-verify checklist out of band). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check."
argument-hint: "<featureId>"
---

You are the acceptance gate. Verify every AC, NFR, and success metric from the PRD before commit.

## Read context

```
!`browzer get-step FEATURE_ACCEPTANCE --id $ARGUMENTS 2>/dev/null || echo "(no prior FEATURE_ACCEPTANCE step — first run)"`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob includes the PRD's acceptance criteria, NFRs, success metrics, and the list of completed TASK_NN execution receipts.

## Modes

| Mode | Behavior |
| ---- | -------- |
| `autonomous` | The skill runs every verifiable check itself (build, lint, test, dashboard probe, metric query). |
| `manual` | The skill emits a checklist; the operator runs it out-of-band and reports back. |

The mode comes from the orchestrator; default is `autonomous`. Live-verify procedures (dashboard / `/ask` / `/sync` probes) are in `references/live-verify.md`. Verification methods per AC type are in `references/verification-methods.md`.

## Process

1. For each AC: pick a verification method (build, test, http-probe, metric-query, manual-check). Run it (autonomous) or write the runbook line (manual).
2. For each NFR: same.
3. For each success metric: query the source (Langfuse, Grafana, Postgres, etc). For dashboard / `/ask` / `/sync` metrics that lack live evidence, do NOT auto-flip to `status: passed` — record `status: pending` with `instructions: "pending operator verification"` instead.
4. Aggregate the verdict.

## Produce

Write `docs/browzer/<feat>/staging/FEATURE_ACCEPTANCE.json`.

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

`verdict` is one of `APPROVED` or `BLOCKED`.

Verdict rules: any `failed` AC/NFR → `BLOCKED`. All `passed` or `deferred-with-rationale` → `APPROVED`. `pending` items: in **autonomous** mode they block the verdict (treat as incomplete → `BLOCKED`); in **manual** mode they are allowed and the verdict can still be `APPROVED` provided each `pending` item is also recorded under `deferredActions[]` with a rationale.

## Persistence

The autosave hook persists `staging/FEATURE_ACCEPTANCE.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — FEATURE_ACCEPTANCE is load-bearing: `commit` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- File exists at `docs/browzer/<feat>/staging/FEATURE_ACCEPTANCE.json`.
- The autosave hook validates and persists.

Return one line: `feature-acceptance: verdict=<APPROVED|BLOCKED>; deferred=<N>`.
