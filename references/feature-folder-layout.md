# Feature folder layout — `docs/browzer/<feat>/`

> **Applicability** — cross-skill. The orchestrator and every
> phase-skill share this map. The orchestrator's filesystem-driven
> state machine (`orchestrate-task-delivery/references/state-machine.md`)
> reads file presence/absence from this layout to decide the next
> phase.

`<feat>` matches `^feat-[0-9]{8}-[a-z0-9-]+$` (date-prefixed slug).

---

## Canonical layout — staging-folder discipline

```
docs/browzer/<feat>/
├── README.md                            [finalize-feature, COMMITTED]
└── staging/                             [gitignored — workflow scratch]
    ├── .gitignore                       [orchestrator-managed, contents: "*\n!.gitignore\n"]
    ├── CONFIG.md                        [orchestrator-managed]
    ├── BRIEF.md                         [brainstorming, optional]
    ├── PRD.md                           [generate-prd]
    ├── USER_STORIES.md                  [generate-prd, script-rendered]
    ├── EXPLORATION.md                   [scope-feature]
    ├── TASK_NN.md                       [generate-task, × N tasks]
    ├── TASK_GRAPH.md                    [generate-task, script-rendered, OPTIONAL — only when CONFIG.executionStrategy != "serial"]
    ├── TASK_NN.completed.md             [execute-task, success — renamed from TASK_NN.md]
    ├── TASK_NN.failed.md                [execute-task, failure — renamed from TASK_NN.md]
    ├── REVIEW_CONTEXT.md                [code-review, script-rendered]
    ├── CODE_REVIEW.<lane>.md            [code-review, × M lanes]
    ├── CODE_REVIEW.md                   [code-review, LLM-authored aggregate]
    ├── REGRESSION_RESULTS.md            [code-review regression-tester lane, optional sidecar]
    ├── FIX_F-NNN.completed.md           [receiving-code-review, success]
    ├── FIX_F-NNN.tech_debt.md           [receiving-code-review, exhausted ladder]
    ├── RECEIVING_CODE_REVIEW.md         [receiving-code-review, LLM-authored aggregate]
    ├── TESTS.md                         [write-tests, LLM-authored aggregate]
    ├── DOC_PATCHES.md                   [finalize-feature Phase A, LLM-authored aggregate]
    ├── ACCEPTANCE.md                    [feature-acceptance]
    └── DELEGATION_TRACE.md              [orchestrator, append-only state-machine log]
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

**Why this exists.** A typical feature produces 30+ markdown artefacts
totalling ~6 000 lines. Committing those pollutes the repo history
without adding lasting value — the *audit trail* is preserved by the
artefacts on the operator's filesystem during the workflow, but the
*canonical committed record* is the human-readable README. Downstream
readers (operators, judges, future you) get a single self-contained
summary; the workflow scaffolding stays where it belongs (ephemeral,
local, gitignored).

**No subfolders inside `staging/`** — flat layout. Subfolders are
forbidden because the state machine's glob patterns assume a flat
directory.

---

## Per-file table

| File | Producer | Consumer(s) | Status | Shape |
|---|---|---|---|---|
| `README.md` | finalize-feature | commit (operator-facing summary in commit body), human review | LLM-authored + script-rendered, idempotent re-run | self-contained — flattens every finding, fix, AC verdict, tech-debt entry verbatim. Never links into `staging/` (which is gitignored). |
| `staging/.gitignore` | orchestrate-task-delivery INIT | git | immutable post-write | two lines: `*` + `!.gitignore` |
| `staging/CONFIG.md` | orchestrate-task-delivery | every phase-skill (read frontmatter only) | mutable (operator may edit between phases) | YAML frontmatter only |
| `staging/BRIEF.md` | brainstorming | generate-prd (as `$contextInput`) | immutable post-write | frontmatter + body |
| `staging/PRD.md` | generate-prd | scope-feature, generate-task (frontmatter), feature-acceptance, finalize-feature | immutable post-write | frontmatter (incl. `originalRequest`, `prdReceipts[]`, `prdSha` derivation source) + body |
| `staging/USER_STORIES.md` | generate-prd `render-user-stories.mjs` | **(no LLM consumer)** — human-review sidecar only | OPTIONAL — script-rendered when `feature.uxCategory` or PRD `userStories.diagramType` is non-default; skip otherwise to avoid orphan artefacts (RETRO §16 / JUDGMENT §3.16) | frontmatter + mermaid body |
| `staging/EXPLORATION.md` | scope-feature | generate-task; `code-review` script reads `skillsFound[]`; `finalize-feature` script reads `featureBlastRadius` top-5 + Phase A; `execute-task` script reads `prdSha` for drift | immutable post-write | frontmatter (`scopeFiles[]`, `blastRadius`, `skillsFound[]`, `findSkillsRan`, `prdSha`) + body |
| `staging/TASK_NN.md` | generate-task | execute-task | renamable | frontmatter (closed prompt: AC/FR verbatim, scope, invariants, skillsFound, testSpecs, prdSha) + body |
| `staging/TASK_GRAPH.md` | generate-task `render-task-graph.mjs` | orchestrator (parallelizable executionStrategy only) | OPTIONAL — emit only when `CONFIG.executionStrategy != "serial"` (parallel / parallel-worktrees / agent-teams). In serial runs the task graph is dead weight | frontmatter (manifest) + mermaid body |
| `staging/TASK_NN.completed.md` | execute-task | code-review, write-tests, finalize-feature | renamed from `TASK_NN.md`, body-appended | original frontmatter + body, plus appended `## Execution log` |
| `staging/TASK_NN.failed.md` | execute-task | orchestrator (HALT signal), finalize-feature (Known issues) | renamed from `TASK_NN.md`, body-appended | original frontmatter + body, plus appended `## Execution log` w/ Failure section |
| `staging/REVIEW_CONTEXT.md` | code-review `render-review-context.mjs` | code-review reviewer lanes (paste-included) | script-rendered, re-runnable | frontmatter (`diffBase`, `changedFiles[]`, `changedSymbols[]`, `reverseDeps`) + mermaid body |
| `staging/CODE_REVIEW.<lane>.md` | code-review (per-lane subagent) | code-review aggregator | immutable post-write | frontmatter (per-lane findings) + body narrative |
| `staging/CODE_REVIEW.md` | code-review `aggregate-findings.mjs` | receiving-code-review, feature-acceptance, finalize-feature | LLM-authored aggregate (idempotent re-run) | frontmatter (`findings[]` deduped, `severityCounts`, `prdSha`) + body |
| `staging/REGRESSION_RESULTS.md` | code-review regression-tester lane `parse-baseline-failures.mjs` | code-review regression-tester lane (paste-included) | script-rendered, optional | frontmatter (baseline diff structured) + body |
| `staging/FIX_F-NNN.completed.md` | receiving-code-review | write-tests, feature-acceptance, finalize-feature | atomic write, body-appended | frontmatter (`pinsFinding`, `pinsFiles[]`) + body with `## Fix log` |
| `staging/FIX_F-NNN.tech_debt.md` | receiving-code-review | orchestrator (HALT if high severity), feature-acceptance, finalize-feature | atomic write, body-appended | frontmatter (`pinsFinding`, `severity`) + body with `## Failure ladder` |
| `staging/RECEIVING_CODE_REVIEW.md` | receiving-code-review `aggregate-fixes.mjs` | write-tests, feature-acceptance, finalize-feature | LLM aggregate (idempotent) | frontmatter (`fixOutcomes[]`) + body |
| `staging/TESTS.md` | write-tests | feature-acceptance, finalize-feature | LLM aggregate (idempotent re-run) | frontmatter (`testsAdded[]`, kill-rate totals) + body |
| `staging/DOC_PATCHES.md` | finalize-feature Phase A→B (inline) | finalize-feature README render | LLM aggregate | frontmatter (`docsPatched[]`, `candidateDocs[]`) + body |
| `staging/ACCEPTANCE.md` | feature-acceptance | finalize-feature, commit (hard gate) | immutable per run; operator may delete to re-run | frontmatter (`verdict`, `perAcVerdict[]`, `nfrVerdict[]`, `metricBaseline[]`, `mode`) + body |
| `staging/DELEGATION_TRACE.md` | orchestrate-task-delivery `append-trace.mjs` | orchestrator (cycle-guard input) | append-only | one bullet per transition |

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

Every artefact downstream of `generate-prd` carries `prdSha = git
hash-object docs/browzer/<feat>/staging/PRD.md` in frontmatter:

```
PRD.md                              (source — operator may regenerate via /generate-prd)
   ↓ prdSha
EXPLORATION.md                      (scope-feature)
   ↓ prdSha
TASK_NN.md                          (generate-task)
   ↓ prdSha
TASK_NN.completed.md                (execute-task verifies + carries)
   ↓ prdSha
CODE_REVIEW.md                      (code-review verifies + carries)
   ↓ prdSha
RECEIVING_CODE_REVIEW.md            (receiving-code-review verifies + carries)
   ↓ prdSha
TESTS.md / DOC_PATCHES.md           (verify only)
   ↓ prdSha
ACCEPTANCE.md                       (verifies; mismatch ⇒ hard reject)
```

Any phase that detects `prdSha` mismatch HALTS with a nudge: "PRD was
edited after this phase ran — re-run `/scope-feature` then
`/generate-task` (or as far back as the drift requires)".

---

## State-machine glob mapping (orchestrator-facing)

The orchestrator's `detect-phase.mjs` script reads glob results from the
layout above. All globs target `docs/browzer/<feat>/staging/`; the
top-level `README.md` is consulted only at the very end of the chain.

| Glob pattern (under `docs/browzer/<feat>/staging/`) | Signal |
|---|---|
| `staging/` missing | Need INIT (orchestrator creates folder + `.gitignore`) |
| `PRD.md` missing | Need brainstorming OR generate-prd |
| `PRD.md` present, `EXPLORATION.md` missing | Need scope-feature |
| `EXPLORATION.md` present, no `TASK_*.md` | Need generate-task |
| `TASK_*.md` exists w/o `.completed.md` AND no `.failed.md` siblings | Need execute-task (loop) |
| Any `TASK_*.failed.md` | HALT — operator triage required |
| All `TASK_*.completed.md`, no `CODE_REVIEW.md` | Need code-review |
| `CODE_REVIEW.md.frontmatter.findings` is empty | Skip receiving-code-review → write-tests |
| `CODE_REVIEW.md.frontmatter.findings` non-empty, no `RECEIVING_CODE_REVIEW.md` | Need receiving-code-review |
| Any `FIX_*.tech_debt.md` with `severity: high` | HALT |
| `RECEIVING_CODE_REVIEW.md` present, no `TESTS.md` | Need write-tests |
| `TESTS.md` present, no `ACCEPTANCE.md` | Need feature-acceptance |
| `ACCEPTANCE.md.frontmatter.verdict == rejected` | HALT |
| `ACCEPTANCE.md.verdict == accepted`, no top-level `README.md` (sibling of `staging/`) | Need finalize-feature (runs Phase A doc-patching + Phase B README inline) |
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

- Flatten every `findings[]` entry from `CODE_REVIEW.md` verbatim into
  the README's `## Code review` section (id + severity + title +
  resolution one-liner).
- Flatten every `FIX_*.completed.md` / `FIX_*.tech_debt.md` summary
  inline.
- Inline every `### Files modified` block from each
  `TASK_*.completed.md`.
- Quote `originalRequest` verbatim from `BRIEF.md` (or `PRD.md` body
  block when `BRIEF.md` is absent).
- Inline every `perAcVerdict[]` row from `ACCEPTANCE.md`.

Never write `[FIX_F-003](staging/FIX_F-003.completed.md)` style
hyperlinks into the README — the target is gitignored. Either inline
the content or omit the reference entirely.

---

## Migration note — legacy flat layout

Prior versions of this plugin used a flat layout (every artefact at
`docs/browzer/<feat>/<file>.md`, no `staging/` subfolder). When
encountering a feat folder that pre-dates this change:

1. The orchestrator's INIT detects the legacy shape (any
   `PRD.md`/`TASK_*.md` at the top level, no `staging/` subfolder) and
   migrates by moving every file except `README.md` into a newly
   created `staging/` subfolder, then writes the `staging/.gitignore`.
2. The migration is idempotent — re-running on an already-migrated
   folder is a no-op.
3. The migration commit is the *only* time `staging/` paths appear in
   git history; from that point forward `staging/` is gitignored and
   never re-committed.

Skills inspecting the layout for diagnostics MUST treat both shapes as
valid; only the orchestrator's INIT performs the migration.

---

## Forbidden patterns

- **No nested feat folders.** `docs/browzer/<feat>/sub-feat/` is
  forbidden.
- **No symlinks.** Atomic rename semantics require flat regular files.
- **No `*.json` artefacts in the feat folder.** All structured data is
  in markdown frontmatter. The only exceptions are
  `/tmp/<phase>-*.json` discovery receipts (scratch, ephemeral) and
  operator-supplied `.browzer/sensitive-paths.json` (config, not
  artefact).
- **No README hyperlinks into `staging/`.** Gitignored target;
  hyperlink rots immediately after commit.
- **No subfolders under `staging/`.** Glob patterns assume a flat
  layout.
