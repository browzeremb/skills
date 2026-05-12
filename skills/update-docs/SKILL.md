---
name: update-docs
description: "Find every markdown doc whose accuracy depends on the just-changed code and patch it in place. Two phases: Phase A spawns a discovery subagent that runs browzer mentions / deps --reverse / explore / search over changed files and saves JSON receipts; Phase B reads receipts and patches docs. Patches existing docs only — never writes new ones. Triggers: update the docs, sync the documentation, docs are stale, refresh the README, propagate changes to docs, 'we changed X — what docs cover X'."
argument-hint: "<featureId>"
---

You are a docs-sync engineer. Patch existing docs that drifted because of this feature; never create new docs.

## Read context

```
!`browzer get-step UPDATE_DOCS --id $ARGUMENTS 2>/dev/null || echo "(no prior UPDATE_DOCS step — first run)"`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob lists every changed file from completed TASK_NN steps.

## Phase A — Discovery (subagent dispatch)

Spawn ONE discovery subagent using the Agent tool (`subagent_type: browzer:explorer`). The subagent's contract:

**Subagent prompt** (render for each changed file set derived from the TASK_NN steps):

> Run all four discovery signals over the changed files. For EACH file in scope:
>
> 1. `browzer mentions <file> --save /tmp/update-docs-<feat-id>-mentions-<slug>.json`
> 2. `browzer deps <file> --reverse --json --save /tmp/update-docs-<feat-id>-deps-<slug>.json`
>
> Then for each concept keyword implied by the changes:
>
> 3. `browzer explore "<concept>" --save /tmp/update-docs-<feat-id>-explore-<concept>.json`
> 4. `browzer search "<concept>" --save /tmp/update-docs-<feat-id>-search-<concept>.json`
>
> **Feat-id is REQUIRED in every receipt** (autosave-hook contract, F-003 / F-017). Use the
> current `$BROWZER_WORKFLOW_ID` env var as `<feat-id>`. The `_auto-save-step.mjs`
> hook discriminates receipts via:
> 1. payload top-level `featId` field (preferred — write `{"featId": "<feat-id>", …}` into the JSON), OR
> 2. anchored filename pattern `^update-docs-(feat-[a-z0-9-]+)-[^-]+\.json$`.
>
> Receipts that fail BOTH discriminator paths are SKIPPED with a stderr WARN — they
> never enter `signals[]`. Embedding the feat-id in the filename (as shown above)
> satisfies path 2 unconditionally; adding `featId` to the JSON body is belt-and-suspenders.
>
> Inspect every doc found across all four signals: ADRs, runbooks, CLAUDE.md files, READMEs.
>
> Return ONE line: `discovery: <N> docs found, receipts: <list of /tmp/update-docs-<feat-id>-*.json paths>`
>
> Cap: 60 seconds wall-clock. If exceeded, return whatever receipts arrived with note `[capped]`.

**Calling agent** (you): wait for the subagent's one-line return. Extract the receipt paths list. If no receipts arrived (timeout or empty), proceed to Phase B with an empty signal set and record `signals: []` in the output.

Full signal heuristics live in `references/three-signals.md`.

## Phase B — Patch (direct edits by calling agent)

Dispatch the patch specialist with `subagent_type: browzer:doc-writer`, `model: sonnet`, `effort: medium`. Pass the receipt paths from Phase A in the dispatch prompt.

Read each receipt file returned by the subagent:

```bash
cat /tmp/update-docs-${BROWZER_WORKFLOW_ID}-mentions-*.json 2>/dev/null
cat /tmp/update-docs-${BROWZER_WORKFLOW_ID}-deps-*.json     2>/dev/null
cat /tmp/update-docs-${BROWZER_WORKFLOW_ID}-explore-*.json  2>/dev/null
cat /tmp/update-docs-${BROWZER_WORKFLOW_ID}-search-*.json   2>/dev/null
```

For each doc identified across all receipts:

1. Determine if it references changed symbols, paths, invariants, or commands.
2. If stale: patch it in place using the Edit tool. Never create new docs.
3. Add the receipt path(s) that identified this doc to the `signals[]` entry for the patched doc in the output artifact.

## ENOENT scan

For every doc you patch, scan its fenced ```bash and ```sh blocks. Any command whose first token would `command -v` to ENOENT in the repo is broken. Fix or remove. Procedure in `references/enoent-scan.md`.

## Post-skill audit

After staging `UPDATE_DOCS.json`, verify:

> If `body.signals[]` (or the patched-docs entries) does NOT reference at least one `/tmp/update-docs-<feat-id>-*.json` receipt path AND the changed-file count is non-empty, downgrade the skill's outcome: set `cursor` to include `signal-bypass` and add a `scopeAdjustments` entry: `"Discovery subagent produced no receipts — patching proceeded without signal coverage"`.

This prevents silent skips of the discovery phase.

## Produce

Write `docs/browzer/<feat>/staging/UPDATE_DOCS.json`.

**Required before Write** — invoke `Read ${CLAUDE_PLUGIN_ROOT}/skills/update-docs/template.md` BEFORE composing the staging payload. The template is auto-generated from the workflow CUE schema and is the canonical scaffold. Fields not present in `template.md`'s field reference are dropped on `save-step`. Do not paste schema-claiming JSON inline into this body; reference the template instead.

Key fields in the `updateDocs` body:

- **`signals[]`** — array of discovery-signal receipts (CUE: `#UpdateDocsSignal`). Each entry records `name` (string), `source` (the browzer command that ran), `hit` (bool — whether the command returned results), and optional `count` (int). Emit an empty array `[]` rather than `null` when no signals fired. Set to at least one entry when Phase A ran and produced receipts.
- **`enoentScan`** — optional object (CUE: `#UpdateDocsEnoentScan`) with `ran` (bool) and `missingFiles` (string array). Record when the Phase B ENOENT sweep ran: `{ "ran": true, "missingFiles": ["..."] }` or `{ "ran": false, "missingFiles": [] }`. Emit the empty-array form rather than `null`.

## Persistence

The autosave hook persists `staging/UPDATE_DOCS.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — UPDATE_DOCS is not load-bearing for the next phase; wait for durable write after patches are confirmed on disk.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- File exists at `docs/browzer/<feat>/staging/UPDATE_DOCS.json`.
- Every doc you patched on disk appears in `docsPatched[]`.
- `body.signals[]` references at least one `/tmp/update-docs-<feat-id>-*.json` receipt path, OR `scopeAdjustments` records `signal-bypass` with rationale.
- The autosave hook validates and persists.

Return one line: `update-docs: <N> patched, <M> considered, <K> ENOENT fixes`.
