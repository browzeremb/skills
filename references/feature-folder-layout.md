# Feature folder layout — `docs/browzer/<feat>/`

> **Applicability** — cross-skill. The orchestrator and every
> phase-skill share this map. The orchestrator's filesystem-driven
> state machine (`orchestrate-task-delivery/references/state-machine.md`)
> reads file presence/absence from this layout to decide the next
> phase.

`<feat>` matches `^feat-[0-9]{8}-[a-z0-9-]+$` (date-prefixed slug).

---

## Canonical layout — six per-phase subfolders under `staging/`

```
docs/browzer/<feat>/
├── README.md                              [finalize-feature, COMMITTED]
└── staging/                               [gitignored — workflow scratch]
    ├── .gitignore                         [orchestrator-managed, contents: "*\n!.gitignore\n"]
    ├── .prd-frozen                        [generate-prd sentinel — owned by generate-prd; honoured by the prd-frozen hook]
    ├── .regression-guard-rerun            [transient — regression-guard writes; receiving-code-review deletes on next round]
    ├── CONFIG.md                          [orchestrator-managed; carries tier, executionStrategy, acceptanceMode, regressionGuardRound]
    ├── DELEGATION_TRACE.md                [orchestrator append-only state-machine log]
    │
    ├── planning/
    │   ├── BRIEF.md                       [brainstorming, optional; contains `## PRD-compact` when tier=express]
    │   ├── PRD.md                         [generate-prd; standard/full tiers only]
    │   ├── USER_STORIES.md                [generate-prd render-user-stories.mjs; full only, optional sidecar]
    │   └── EXPLORATION.md                 [scope-feature; standard/full only; strict intermediate (only generate-task reads it)]
    │
    ├── tasks/
    │   ├── TASKS_MANIFEST.md              [generate-task; standard/full only]
    │   ├── TASK_GRAPH.md                  [generate-task render-task-graph.mjs; optional, only when executionStrategy != "serial"]
    │   ├── TASK_NN.md                     [generate-task or orchestrator inline-write; × N tasks]
    │   ├── TASK_NN.completed.md           [execute-task success — atomic rename from TASK_NN.md]
    │   └── TASK_NN.failed.md              [execute-task failure — atomic rename from TASK_NN.md]
    │
    ├── review/
    │   ├── REVIEW_CONTEXT.md              [code-review render-review-context.mjs output]
    │   ├── CODE_REVIEW.md                 [code-review aggregate-findings.mjs output; findings list grows when regression-guard appends round-2/3 findings]
    │   ├── REGRESSION_RESULTS.md          [code-review regression-tester lane parse-baseline-failures.mjs; structured baseline-failure sidecar, NOT mutation testing]
    │   ├── GATE_REPORT.md                 [regression-guard output — lint/typecheck/test/build results over the post-fix aggregate diff]
    │   └── RECEIVING_CODE_REVIEW.md       [aggregate-fixes.mjs; back-compat sidecar — derived from FIXES.md; will be removed in a follow-up cleanup]
    │
    ├── review-lanes/
    │   ├── CODE_REVIEW.senior-engineer.md
    │   ├── CODE_REVIEW.software-architect.md
    │   ├── CODE_REVIEW.qa.md
    │   ├── CODE_REVIEW.regression-tester.md
    │   ├── CODE_REVIEW.pr-coherence.md    [cheap haiku lane — AC-contract shape check]
    │   └── CODE_REVIEW.<domain>.md        [× N dynamic specialist lanes discovered via find-skills]
    │
    ├── fixes/
    │   ├── F-NNN.completed.md             [receiving-code-review fixer success; `FIX_F-` prefix dropped — subfolder gives namespace]
    │   ├── F-NNN.tech_debt.md             [receiving-code-review fixer exhausted ladder]
    │   └── FIXES.md                       [aggregate-fixes.mjs primary output — index + status + ladderSteps + modelAtSuccess]
    │
    └── acceptance/
        ├── DOC_PATCHES.md                 [finalize-feature Phase A inline doc-patching aggregate]
        └── ACCEPTANCE.md                  [feature-acceptance verdict]
```

**Only `README.md` is committed.** Every other artefact lives under
`staging/`, which carries an auto-generated `.gitignore` with the two
lines:

```
*
!.gitignore
```

This excludes every file under `staging/` from version control while
keeping the gitignore itself versioned so the discipline survives across
clones. The orchestrator writes this file at INIT and never edits it
afterwards.

**Why this exists.** A typical feature produces 30–80 markdown artefacts
totalling thousands of lines. Committing those pollutes the repo
history without adding lasting value — the *audit trail* is preserved
by the artefacts on the operator's filesystem during the workflow, but
the *canonical committed record* is the human-readable README.
Downstream readers (operators, judges, future you) get a single
self-contained summary; the workflow scaffolding stays where it belongs
(ephemeral, local, gitignored).

**Subfolders by phase, not by writer.** `planning/ tasks/ review/
review-lanes/ fixes/ acceptance/` maps to the operator's mental model
of pipeline phases. The state-machine glob patterns target these
subfolders directly. Files at the staging-root are limited to
cross-phase state (`CONFIG.md`, `DELEGATION_TRACE.md`, the two
sentinels, the `.gitignore` itself).

---

## Per-file table

| File | Producer | Consumer(s) | Tier presence | Status | Shape |
|---|---|---|---|---|---|
| `README.md` | finalize-feature | commit (operator-facing summary), human review | all tiers | LLM-authored + script-rendered, idempotent re-run | self-contained — flattens every finding, fix, AC verdict, tech-debt entry verbatim. Never links into `staging/` (which is gitignored). |
| `staging/.gitignore` | orchestrate-task-delivery INIT | git | all tiers | immutable post-write | two lines: `*` + `!.gitignore` |
| `staging/.prd-frozen` | generate-prd skill body | `prd-frozen` PreToolUse hook | standard/full | sentinel — empty file | presence-only |
| `staging/.regression-guard-rerun` | regression-guard | receiving-code-review (deletes on next round entry) | all tiers (only when fixers ran AND gate failed) | transient sentinel | presence-only |
| `staging/CONFIG.md` | orchestrate-task-delivery | every phase-skill (read frontmatter only) | all tiers | mutable (operator may edit between phases) | YAML frontmatter only — `featureId`, `tier`, `executionStrategy`, `acceptanceMode`, `regressionGuardRound`, `createdAt` |
| `staging/DELEGATION_TRACE.md` | orchestrate-task-delivery `append-trace.mjs` | orchestrator (cycle-guard input) | all tiers | append-only | one bullet per transition |
| `staging/planning/BRIEF.md` | brainstorming OR orchestrator (express tier) | generate-prd, feature-acceptance (express tier reads `## PRD-compact` here) | all tiers | immutable post-write | frontmatter + body; carries `## PRD-compact` heading in express tier (functionalRequirements + acceptanceCriteria inlined) |
| `staging/planning/PRD.md` | generate-prd | scope-feature, generate-task (frontmatter), feature-acceptance, finalize-feature | standard/full | immutable post-write | frontmatter (incl. `originalRequest`, `prdSha` derivation source) + body |
| `staging/planning/USER_STORIES.md` | generate-prd `render-user-stories.mjs` | **(no LLM consumer)** — human-review sidecar | full only (when uxCategory non-default) | OPTIONAL — script-rendered | frontmatter + mermaid body |
| `staging/planning/EXPLORATION.md` | scope-feature | **generate-task only** — strict intermediate; closure-violations.mjs forbids any other consumer | standard/full | immutable post-write | frontmatter (`scopeFiles[]`, `blastRadius`, `skillsFound[]`, `findSkillsRan`, `prdSha`) + body |
| `staging/tasks/TASKS_MANIFEST.md` | generate-task | human-review sidecar | standard/full | OPTIONAL | YAML index of all TASK_NN files |
| `staging/tasks/TASK_GRAPH.md` | generate-task `render-task-graph.mjs` | orchestrator (parallelizable strategies only) | when `executionStrategy != "serial"` | OPTIONAL — script-rendered | frontmatter (manifest) + mermaid body |
| `staging/tasks/TASK_NN.md` | generate-task OR orchestrator (express tier inline write) | execute-task | all tiers | renamable | frontmatter (closed prompt: AC/FR verbatim, scope.files[].blastRadius, invariants, skillsFound[], testSpecs[], prdSha may be null in express) + body |
| `staging/tasks/TASK_NN.completed.md` | execute-task | code-review, regression-guard, finalize-feature | all tiers | renamed from `TASK_NN.md`, body-appended | original frontmatter + `qualityGate: {typecheck, test, lint, build?, output}` + `testsAdded[]` + body, plus appended `## Execution log` |
| `staging/tasks/TASK_NN.failed.md` | execute-task | orchestrator (HALT signal), finalize-feature (Known issues) | all tiers | renamed from `TASK_NN.md`, body-appended | original frontmatter + body, plus appended `## Execution log` w/ Failure / `## Quality gate failure` section |
| `staging/review/REVIEW_CONTEXT.md` | code-review `render-review-context.mjs` | code-review reviewer lanes (paste-included) | all tiers | script-rendered, re-runnable | frontmatter (`diffBase`, `changedFiles[]`, `changedSymbols[]`, `reverseDeps`, `skillsFound[]` from TASK_*.completed) + mermaid body |
| `staging/review/CODE_REVIEW.md` | code-review `aggregate-findings.mjs` | receiving-code-review, regression-guard (appends round-2/3 findings in-place), feature-acceptance, finalize-feature | all tiers | LLM-authored aggregate (idempotent re-run) | frontmatter (`findings[]` with optional `round` and `fixStatus`, `severityCounts`, `prdSha`) + body |
| `staging/review/REGRESSION_RESULTS.md` | code-review regression-tester lane `parse-baseline-failures.mjs` | code-review regression-tester lane (paste-included) | all tiers | OPTIONAL — script-rendered | frontmatter (baseline diff structured) + body |
| `staging/review/GATE_REPORT.md` | regression-guard | finalize-feature, judge | all tiers (when regression-guard runs) | atomic write | frontmatter (`gateResults: {lint, typecheck, test, build?}`, `round`) + code-fenced gate output bodies |
| `staging/review/RECEIVING_CODE_REVIEW.md` | receiving-code-review `aggregate-fixes.mjs` (back-compat sidecar) | finalize-feature (legacy reader) | all tiers (when fixers ran) | derived; will be removed once finalize-feature switches to FIXES.md | frontmatter (`fixOutcomes[]`) + body — semantically a subset of `fixes/FIXES.md` |
| `staging/review-lanes/CODE_REVIEW.<lane>.md` | code-review (per-lane subagent) | code-review aggregator | all tiers (lanes vary per tier) | immutable post-write | frontmatter (per-lane findings) + body narrative |
| `staging/fixes/F-NNN.completed.md` | receiving-code-review fixer | aggregate-fixes.mjs, finalize-feature | all tiers (when findings > 0) | atomic write, body-appended | frontmatter (`pinsFinding`, `pinsFiles[]`, `ladderStepsUsed`, `modelAtSuccess`) + body with `## Fix log` |
| `staging/fixes/F-NNN.tech_debt.md` | receiving-code-review fixer | aggregate-fixes.mjs, orchestrator (HALT if high severity), finalize-feature | all tiers (when ladder exhausted) | atomic write, body-appended | frontmatter (`pinsFinding`, `severity`, `techDebtSubtype`) + body with `## Failure ladder` |
| `staging/fixes/FIXES.md` | receiving-code-review `aggregate-fixes.mjs` | regression-guard, finalize-feature, judge | all tiers (when fixers ran) | LLM aggregate (idempotent) | frontmatter (`fixOutcomes[]` index, `summary`, `techDebtBreakdown`) + body |
| `staging/acceptance/DOC_PATCHES.md` | finalize-feature Phase A | finalize-feature README render | all tiers | LLM aggregate | frontmatter (`docsPatched[]`, `candidateDocs[]`) + body |
| `staging/acceptance/ACCEPTANCE.md` | feature-acceptance | finalize-feature, commit (hard gate) | all tiers | immutable per run; operator may delete to re-run | frontmatter (`verdict`, `perAcVerdict[]`, `nfrVerdict[]`, `metricBaseline[]`, `mode`, optional `gateOverride: {reason, operator}`) + body |

---

## Status semantics

| Status keyword | Meaning |
|---|---|
| `immutable post-write` | Phase writes once; downstream MAY read but MUST NOT modify. Operator may delete to re-run the phase entirely. |
| `mutable` | Operator may edit between invocations. Skills MUST re-read on every invocation rather than caching. |
| `renamable` | Producer writes, downstream consumer (execute-task) renames via atomic `mv` with body append. The pre-rename file (`.md`) and post-rename (`.completed.md` / `.failed.md`) are the same file. |
| `atomic write, body-appended` | First write creates the file; subsequent re-runs may append additional `## Retry attempt N` sections (without rewriting prior content). |
| `script-rendered, re-runnable` | A bundled script regenerates byte-identically from the upstream frontmatter; running it twice produces no diff. |
| `LLM aggregate (idempotent re-run)` | An LLM authors content but the shape is constrained enough that re-running produces semantically equivalent output. |
| `append-only ledger` | Multiple producers write to the same file; each producer's section is sentinel-bounded and idempotent within its sentinel pair. |

---

## prdSha drift fingerprint chain

For features that ran `generate-prd` (tiers `standard`/`full`), every
artefact downstream carries `prdSha = git hash-object
docs/browzer/<feat>/staging/planning/PRD.md` in frontmatter:

```
planning/PRD.md                     (source — operator may regenerate via /generate-prd)
   ↓ prdSha
planning/EXPLORATION.md             (scope-feature)
   ↓ prdSha
tasks/TASK_NN.md                    (generate-task)
   ↓ prdSha
tasks/TASK_NN.completed.md          (execute-task verifies + carries)
   ↓ prdSha
review/CODE_REVIEW.md               (code-review verifies + carries)
   ↓ prdSha
fixes/FIXES.md                      (receiving-code-review verifies + carries)
   ↓ prdSha
acceptance/DOC_PATCHES.md           (verify only)
   ↓ prdSha
acceptance/ACCEPTANCE.md            (verifies; mismatch ⇒ hard reject)
```

Any phase that detects `prdSha` mismatch HALTs with a nudge: "PRD was
edited after this phase ran — re-run `/scope-feature` then
`/generate-task` (or as far back as the drift requires)".

In `tier=express`, no `PRD.md` exists; `prdSha` is `null` across the
chain and drift-detection short-circuits. The express-tier compact PRD
lives at `planning/BRIEF.md` under a `## PRD-compact` heading and is
fingerprinted via `briefSha` only when `feature-acceptance` consumes it.

---

## State-machine glob mapping (orchestrator-facing)

The orchestrator's `detect-phase.mjs` script reads glob results from the
layout above. All globs target subfolders of
`docs/browzer/<feat>/staging/`; the top-level `README.md` is consulted
only at the very end of the chain.

| Glob pattern (under `docs/browzer/<feat>/staging/`) | Signal |
|---|---|
| `staging/` missing | Need INIT (orchestrator creates folder + subfolders + `.gitignore` + `CONFIG.md`) |
| `CONFIG.md` missing OR `CONFIG.tier` unset | Need probe-tier (orchestrator Step 0.5) |
| `planning/PRD.md` missing AND tier != express | Need brainstorming OR generate-prd |
| `planning/PRD.md` present, `planning/EXPLORATION.md` missing AND tier != express | Need scope-feature |
| `planning/EXPLORATION.md` present (or tier=express), no `tasks/TASK_*.md` | Need generate-task (or inline-write in express) |
| `tasks/TASK_*.md` exists w/o `.completed.md` AND no `.failed.md` siblings | Need execute-task (loop) |
| Any `tasks/TASK_*.failed.md` | HALT — operator triage required |
| All `tasks/TASK_*.completed.md` written, no `review/CODE_REVIEW.md` | Need code-review |
| `review/CODE_REVIEW.md.frontmatter.findings[]` empty AND no `fixes/` content | Skip receiving-code-review → skip regression-guard → feature-acceptance |
| `review/CODE_REVIEW.md.frontmatter.findings[]` non-empty, no `fixes/FIXES.md` | Need receiving-code-review |
| `fixes/FIXES.md` present, no `review/GATE_REPORT.md` | Need regression-guard |
| `review/GATE_REPORT.md.frontmatter.gateResults.*` has any `fail` AND `CONFIG.regressionGuardRound < 3` | Loop back to receiving-code-review (round 2/3) |
| `review/GATE_REPORT.md.frontmatter.gateResults.*` has any `fail` AND `CONFIG.regressionGuardRound == 3` | HALT — operator may `--override-gate` |
| Any `fixes/F-*.tech_debt.md` with `severity: high` (no `.browzer/accepted-tech-debt.json`) | HALT |
| Gate passed (or override accepted), no `acceptance/ACCEPTANCE.md` | Need feature-acceptance |
| `acceptance/ACCEPTANCE.md.frontmatter.verdict == rejected` | HALT |
| `acceptance/ACCEPTANCE.md.verdict == accepted`, no top-level `README.md` | Need finalize-feature (Phase A doc-patching + Phase B README) |
| Top-level `README.md` present, git diff non-empty | Need commit |
| Everything consistent + git clean | DONE |

---

## File presence ≠ phase completed

Presence of a file means the phase wrote it; it does NOT guarantee the
phase's body content is well-formed. Each consumer validates the
frontmatter shape of its inputs on entry — invalid frontmatter is a
contract violation that halts the consumer with a precise pointer back
to the producer skill.

---

## README.md must be self-contained

Because `staging/` is gitignored, anything the README hyperlinks into
`staging/<file>` becomes a dead link after the workflow folder is
cleaned up (or simply when another operator pulls the commit and the
staging dir doesn't exist locally). `finalize-feature` MUST therefore:

- Flatten every `findings[]` entry from `review/CODE_REVIEW.md` verbatim
  into the README's `## Code review` section (id + severity + title +
  resolution one-liner).
- Flatten every `fixes/F-*.completed.md` / `fixes/F-*.tech_debt.md`
  summary inline.
- Inline every `### Files modified` block from each
  `tasks/TASK_*.completed.md`.
- Quote `originalRequest` verbatim from `planning/BRIEF.md` (or
  `planning/PRD.md` body block when `BRIEF.md` is absent).
- Inline every `perAcVerdict[]` row from `acceptance/ACCEPTANCE.md`.

Never write `[F-003](staging/fixes/F-003.completed.md)` style
hyperlinks into the README — the target is gitignored. Either inline
the content or omit the reference entirely.

---

## Migration note — legacy flat layout

Two legacy shapes may be encountered:

1. **Pre-`staging/` flat layout** — every artefact at
   `docs/browzer/<feat>/<file>.md` with no `staging/` subfolder. The
   orchestrator's INIT detects this and migrates by moving every file
   except `README.md` into a newly created `staging/` subfolder.
2. **Flat `staging/` layout** — every artefact directly under
   `staging/` (`staging/PRD.md`, `staging/FIX_F-NNN.completed.md`,
   …) with no per-phase subfolders. This is the layout shipped by
   prior versions of this plugin; **the current release has no
   automatic migrator for it**.

For the flat-`staging/` shape, the operator has two options:

- Pin the previous plugin version (`claude --plugin-dir <path-to-old-plugin>`)
  and let the in-flight feature complete under the legacy contract.
- Reset the feature: `rm -rf docs/browzer/<feat>/staging/` and re-run
  `/orchestrate-task-delivery <feat>`. The orchestrator's INIT will
  rebuild the staging tree under the current layout.

The current release does NOT carry a dual-path resolver — every skill
reads the new subfolder paths directly. Mixing the two layouts in one
session produces predictable, easy-to-diagnose errors rather than
silent fallback.

---

## Forbidden patterns

- **No nested feat folders.** `docs/browzer/<feat>/sub-feat/` is
  forbidden.
- **No symlinks.** Atomic rename semantics require flat regular files.
- **No `*.json` artefacts in the feat folder.** All structured data is
  in markdown frontmatter. The only exceptions are
  `/tmp/<phase>-*.json` discovery receipts (scratch, ephemeral) and
  operator-supplied `.browzer/sensitive-paths.json` /
  `.browzer/accepted-tech-debt.json` (config, not artefact).
- **No README hyperlinks into `staging/`.** Gitignored target;
  hyperlink rots immediately after commit.
- **No `.md` files at the staging-root other than `CONFIG.md` and
  `DELEGATION_TRACE.md`.** `scripts/audit/staging-layout.mjs` enforces
  this. Sentinels (`.prd-frozen`, `.regression-guard-rerun`) are dotfiles
  so they don't trip the glob.
- **No `FIX_F-` prefix anywhere.** Fixes live as `fixes/F-NNN.{completed,tech_debt}.md`;
  the subfolder gives the namespace.
- **No `CODE_REVIEW.<lane>.md` at the staging-root.** Lane outputs live
  under `review-lanes/`; the aggregator's consolidated output lives at
  `review/CODE_REVIEW.md`.
- **EXPLORATION.md is consumed only by `generate-task`.** `scripts/audit/closure-violations.mjs`
  rejects any other skill body or script reading `planning/EXPLORATION.md`.
  PRD.md is similarly closed to `scope-feature` / `generate-task` /
  `generate-prd` only.
