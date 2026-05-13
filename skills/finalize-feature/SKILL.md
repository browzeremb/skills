---
name: finalize-feature
description: "Use after feature-acceptance and before commit. Writes a self-contained, human-readable docs/browzer/<feat>/README.md summarizing the completed feature — title, original request quoted verbatim, verdict, every finding + resolution flattened in line, every fix log, every tech-debt entry, every AC verdict. Idempotent: re-running overwrites cleanly. README is the ONLY committed artefact under the feat folder; every other workflow file lives in the gitignored staging/ subfolder. README must therefore stand alone — never hyperlink into staging/. Triggers: finalize feature, write README, summarize feature, commitable summary, finalize-feature."
argument-hint: "<featureId>"
---

You write the human-readable `docs/browzer/<feat>/README.md` for a
completed feature. You do NOT implement code. You read every prior
phase's artefacts under `docs/browzer/<feat>/staging/` and produce a
**self-contained** committable summary.

## Why self-contained matters

Every workflow artefact except `README.md` lives under
`docs/browzer/<feat>/staging/`, which is gitignored. The moment the
operator commits the feature and another collaborator pulls the
commit, the staging folder ceases to exist on their machine. Any
`README.md` that hyperlinks into `staging/FIX_F-003.completed.md` or
`staging/CODE_REVIEW.md` becomes a broken link.

`README.md` is therefore the canonical *committed* record of the
feature — the only thing the audit trail leaves behind. Treat it as a
self-contained document: flatten every finding, fix, AC verdict, and
tech-debt entry **verbatim inline**, not as a hyperlink.

## Inputs

- `$ARGUMENTS` is the `<featureId>`.
- This skill reads everything under `docs/browzer/<feat>/staging/`:
  - `BRIEF.md` (operator's raw request — source for `## Original request`)
  - `PRD.md` (title, fallback `originalRequest`, deploy notes, out-of-scope, NFRs)
  - `EXPLORATION.md` (blast-radius receipts)
  - `TASK_*.completed.md` (task list, files modified, files created, symbols changed)
  - `TASK_*.failed.md` (only present when the feature shipped with known issues — surfaced under `## Known issues`)
  - `CODE_REVIEW.md` (every `findings[]` entry — flattened inline)
  - `RECEIVING_CODE_REVIEW.md` (every `fixOutcomes[]` entry — flattened inline)
  - `FIX_*.completed.md` (fix log + symbols touched — flattened inline)
  - `FIX_*.tech_debt.md` (tech-debt entries — flattened inline)
  - `TESTS.md` (coverage summary, mutation kill rate)
  - `DOC_PATCHES.md` (every docsPatched[] entry)
  - `ACCEPTANCE.md` (verdict + perAcVerdict[] + operatorActions[])

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/README.md` | self-contained feature summary, COMMITTED |
| `docs/browzer/<feat>/staging/RECEIPTS.md` (append) | `## finalize-feature` section |

Shape in `${CLAUDE_SKILL_DIR}/template.md`. Closed set of H2 headings;
optional sections omitted entirely when empty.

## Preflight (halt conditions)

1. **ACCEPTANCE.md missing** — halt with: "run `/feature-acceptance <feat>` first".
2. **Any `TASK_*.failed.md` present** — emit a `## Known issues` section flattening each failure log verbatim; do NOT halt. The feature may legitimately ship with deferred work.
3. **prdSha drift** — `git hash-object docs/browzer/<feat>/staging/PRD.md` must match `ACCEPTANCE.md.prdSha`. Mismatch HALTS.
4. **staging/ folder absent** — halt with: "no staging/ folder for <feat>; run `/orchestrate-task-delivery <feat>` to initialize".

## Required README sections (closed set)

Every README MUST include these H2 sections in this order; optional
sections are omitted entirely (not stubbed) when empty.

```markdown
# <feature title from PRD>

## Summary
<2-4 sentence verdict — autonomous prose, written by the LLM extension after script renders the canonical body>

## Original request
> <verbatim quote from BRIEF.md body; fallback PRD.md.frontmatter.originalRequest; final fallback CONFIG.md.frontmatter.note>

## Acceptance
- Verdict: <accepted | conditionally-accepted | rejected>
- Mode: <autonomous | autonomous-with-stack-boot | hybrid | manual>
- Per-AC verdicts:
  - AC-01 — <verbatim AC text>: <pass | fail | skipped> — <one-line evidence>
  - AC-02 — ...
- Operator actions required:
  - <flattened verbatim from ACCEPTANCE.operatorActionsRequested[]; section omitted when empty>

## Tasks completed
- TASK_01 — <title>
  - Files modified: <flattened verbatim from TASK_01.completed.md ### Files modified — every bullet inlined; (none) preserved>
  - Files created: <same shape>
  - Symbols changed: <same shape>
- TASK_02 — ...

## Code review
- Total findings: <H> high, <M> medium, <L> low
- Findings (one bullet per entry, verbatim from CODE_REVIEW.md.frontmatter.findings[]):
  - **F-001 (high)** — `<file>:<line>` — <title>
    Resolution: <fixed | tech_debt | deferred> — <one-line resolution from FIX_F-001.completed.md or .tech_debt.md>
  - **F-002 (medium)** — ...

## Fixes applied
- One bullet per FIX_*.completed.md, verbatim from its frontmatter + first 2 lines of `## Fix log`:
  - **F-001** — `<file>:<line>` — ladder steps: <N> — model at success: <sonnet|opus>
    - Files modified: <flattened from FIX_F-001.completed.md ### Files modified>

## Tests added
- Suite: <vitest | jest | pytest | go-test | cargo-test | none>
- Tests added: <N>
- Mutation kill rate: <pct>% across <K> mutants
- Coverage delta: <pre>% → <post>%

## Docs patched
- One bullet per DOC_PATCHES.md.frontmatter.docsPatched[]:
  - `<path>` — <one-line summary of the patch>

## Tech debt
- One bullet per FIX_*.tech_debt.md, verbatim from frontmatter + `## Failure ladder` first sentence:
  - **F-NNN (severity)** — `<file>:<line>` — <title>
    Reason: <ladder_exhausted | scope_deferred>
    Recommended follow-up: <verbatim first sentence from `## Recommended follow-up`>
  (Section omitted entirely when no tech-debt entries exist.)

## Known issues
- One bullet per TASK_*.failed.md, verbatim from its `### Failure` block:
  - **TASK_NN** — Reason: <reason>; Details: <verbatim first sentence>
  (Section omitted entirely when no failed tasks exist.)

## Deploy notes
- Flattened verbatim from PRD.md.frontmatter.deployNotes + ACCEPTANCE.md.frontmatter.deployNotes (deduped).
- (Section omitted entirely when both sources are empty.)

## Blast radius (top reverse dependencies)
- Top-5 entries from EXPLORATION.md.frontmatter.featureBlastRadius (highest-fan-in files first).
- (Section omitted entirely when empty.)
```

The header content is closed; the renderer enforces the order and the
LLM may extend the `## Summary` section with up to 2 paragraphs of
prose. No other section is LLM-editable.

## Workflow

### Step 1 — Render the README

```bash
node "${CLAUDE_SKILL_DIR}/scripts/render-readme.mjs" "$ARGUMENTS"
```

The script:

1. Reads `BRIEF.md` body (when present) and quotes verbatim into `##
   Original request`. Falls back to
   `PRD.md.frontmatter.originalRequest`; final fallback to
   `CONFIG.md.frontmatter.note`. Never leaves the section with an empty
   `> ` block — when ALL three sources are absent, emit `> *(operator
   did not record an original request)*` and surface the gap in the
   `## Summary` LLM extension.
2. Reads `PRD.md.frontmatter.title` for the `# <title>` heading; falls
   back to the `featureId` slug humanized.
3. Reads `ACCEPTANCE.md` frontmatter for verdict, mode,
   `perAcVerdict[]`, `operatorActionsRequested[]`, `deployNotes[]`.
4. Globs `TASK_*.completed.md` and parses each execution log per the
   canonical regex in
   `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md`.
   Each `### Files modified`, `### Files created`, `### Symbols
   changed` bullet flattens inline — preserve the `(+N/-N)` suffix and
   the literal `(none)` bullets. Drop nothing.
5. Reads `CODE_REVIEW.md.frontmatter.findings[]` and flattens every
   entry verbatim under `## Code review`. For each finding, looks up
   the matching `FIX_<id>.completed.md` or `FIX_<id>.tech_debt.md` for
   the resolution one-liner.
6. Globs `FIX_*.completed.md` and flattens each fix under `## Fixes
   applied`, inlining the `### Files modified` block from the fix
   body.
7. Globs `FIX_*.tech_debt.md` and flattens each under `## Tech debt`
   (omits the section entirely when no entries exist).
8. Globs `TASK_*.failed.md` and flattens each under `## Known issues`
   (omits the section entirely when no entries exist).
9. Reads `TESTS.md.frontmatter` for the test-counts + kill-rate.
10. Reads `DOC_PATCHES.md.frontmatter.docsPatched[]` and flattens.
11. Reads `EXPLORATION.md.frontmatter.featureBlastRadius` for the
    top-5 reverse-importers section.
12. Writes the README atomically (rename-from-tmp) with the closed-set
    H2 headings. Optional sections are omitted entirely (not stubbed).

The script HALTS with non-zero exit when preflight fails. Surface its
stderr to the operator.

### Step 2 — Optional LLM extension (Summary section only)

The script produces the canonical README. The skill MAY extend the `##
Summary` section's prose with a 1-2 paragraph LLM-authored narrative —
useful when the operator wants a more polished commit-body hook.

**Strict rules:**

- ONLY the `## Summary` section may be edited.
- Do NOT touch `## Original request`, `## Acceptance`, `## Tasks
  completed`, `## Code review`, `## Fixes applied`, `## Tests added`,
  `## Docs patched`, `## Tech debt`, `## Known issues`, `## Deploy
  notes`, or `## Blast radius` — these are script-rendered for
  consistency and audit reliability.
- Do NOT introduce hyperlinks into `staging/` — the target is
  gitignored.
- Do NOT introduce references to workflow artefact IDs (FR-N, AC-N,
  F-NNN, TASK_NN) in the Summary prose; the per-section bullets
  already carry those IDs. The Summary is the human-facing narrative.

### Step 3 — Append receipts

```bash
node "${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs" "$ARGUMENTS"
```

Idempotent `## finalize-feature` section in
`staging/RECEIPTS.md`.

## Done when

- `docs/browzer/<feat>/README.md` exists with all REQUIRED H2 headings (Summary, Original request, Acceptance, Tasks completed, Code review, Fixes applied, Tests added, Docs patched).
- Optional headings (Tech debt, Known issues, Deploy notes, Blast radius) present only when content exists.
- `## Original request` contains a non-empty quote block (verbatim from BRIEF.md or fallback chain).
- Every `## Code review` finding bullet carries the verbatim title + a `Resolution:` line.
- Every `## Tasks completed` task carries non-`(no files)` bullets for at least one of Files modified / Files created / Symbols changed (or all three carry `(none)` when the task legitimately produced no surface change).
- README.md contains ZERO hyperlinks pointing into `staging/`.
- `README.md.Verdict:` line equals `ACCEPTANCE.md.frontmatter.verdict`.
- `staging/RECEIPTS.md` has exactly one `## finalize-feature` section.
- Return line: `finalize-feature: README.md written for <featureId>`.

## Self-contained audit

Before declaring done, the renderer self-audits:

```bash
grep -E "staging/[A-Z]" docs/browzer/$ARGUMENTS/README.md
```

A non-empty result is a contract violation — the README contains a
hyperlink into the gitignored `staging/` folder and will rot the
moment the operator commits. The renderer either inlines the target
content or omits the reference; it never emits the staging-path
hyperlink.

## References

- `${CLAUDE_SKILL_DIR}/template.md` — closed-set H2 headings, idempotency rule, invariants
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — full input map, staging-folder discipline, gitignore policy
- `${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md` — RECEIPTS.md contract
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — regex shapes the renderer parses
