<!--
  Canonical TASK_NN.md template for the generate-task skill.

  This file replaces the previous auto-generated template (CUE-derived) that
  was retired in the markdown-chains refactor. It is the single source of
  truth for the per-task contract — there is no JSON / CUE / save-step
  involved anymore.

  HOW TO READ THIS FILE
  - `REQUIRED` markers in comments → field MUST be present and non-empty
  - `OPTIONAL` markers in comments → field MAY be omitted entirely
  - `Pattern: ...` → regex the value must match (IDs only)
  - `Enum: ...` → allowed values
  - `Refs ...` → field references another field; values must match an existing id

  CLOSURE PRINCIPLE
  TASK_NN.md is the closed prompt consumed by execute-task. It must contain
  everything an executor needs to act WITHOUT reading PRD.md or EXPLORATION.md.
  That is why FR text, AC text, blast radius, and invariants are inlined
  VERBATIM here — IDs alone do not suffice.

  generate-task does NOT emit a TASKS.md manifest. The orchestrator-facing
  manifest (order, deps, parallelizable groups) is rendered deterministically
  by scripts/render-task-graph.mjs into TASK_GRAPH.md after all TASK_NN.md
  files exist on disk.

  Example feature used below: PRD adding `--json` flag to `browzer ask`.
-->

# TASK_NN.md template

## Frontmatter

```yaml
# REQUIRED — Stable task identifier within this feature.
# Pattern: ^TASK_[0-9]{2}$
taskId: TASK_01

# REQUIRED — Human-readable summary, one line.
title: "Wire --json flag into browzer ask command"

# REQUIRED — Specialist domain hint that execute-task uses to pick the right
# subagent profile and model. Free-form but conventional values listed below.
# Common: frontend | backend | cli | infra | docs | migration | tests
role: cli

# REQUIRED — git-blob SHA of the PRD.md the task plan was derived from.
# Mirrors EXPLORATION.md's prdSha. Downstream skills compare against the
# current PRD SHA to detect drift; if mismatched, the operator should re-run
# the planning chain (scope-feature → generate-task).
prdSha: 9c4e7e2a3fb1d8c6a1b09e2c3f7a8d1e0b5c4d6e

# OPTIONAL — Execute-task uses this hint to size the dispatch model.
# Enum: haiku | sonnet | opus  (default: sonnet)
suggestedModel: sonnet

# OPTIONAL — Trivial flag for execute-task fast-path (skip subagent dispatch
# and act in main thread). Reviewer sets when scope is ≤2 small files AND
# no sensitive surface AND no skillsFound[].
trivial: false

# REQUIRED — Files the task will touch, with blast radius inlined VERBATIM
# from EXPLORATION.md. execute-task uses this to scope edits without
# re-querying browzer.
scope:
  files:
    - path: packages/cli/internal/commands/ask.go    # repo-relative POSIX
      blastRadius:
        forward:
          - target: packages/cli/internal/api/ask.go
            kind: imports
            symbols: [Ask]
        reverse:
          - source: packages/cli/internal/commands/root.go
            kind: imported-by
            via: rootCmd
          - source: packages/cli/internal/commands/ask_test.go
            kind: imported-by
            via: testRunner
        reverseCount: 8
        truncatedAt: 15    # OPTIONAL — present only when reverseCount > 15

# REQUIRED — Acceptance criteria with FR/AC text inlined VERBATIM from PRD.
# execute-task reads these to know which behaviors must be true after the
# work; feature-acceptance uses the same text as its gate input.
#
# When a single PRD AC binds MULTIPLE FRs (e.g. AC-01.bindsTo: [FR-01, FR-02]),
# produce ONE bindsTo[] entry per (acId, frId) pair — i.e. two entries with
# the SAME acText repeated. The duplication is the intended encoding; the
# template prioritises a flat (acId, acText, frId, frText) tuple over a
# nested form because downstream LLM consumers parse the flat shape faster
# and miss fewer edges. Do NOT collapse the FR list into one entry with
# `frIds: [FR-01, FR-02]` — that nested shape is not the contract.
acceptanceCriteria:
  - id: T-AC-01                                     # Pattern: ^T-AC-[0-9]+$
    description: |
      Implement --json flag on `browzer ask` that emits { answer, confidence,
      sources } and leaves the default prose output unchanged.
    bindsTo:
      - acId: AC-01                                 # Refs source PRD.acceptanceCriteria[].id
        acText: |
          Given a logged-in CLI user, when they run `browzer ask "..." --json`,
          then stdout is parseable JSON with required fields {answer,
          confidence, sources}.
        frId: FR-01                                 # Refs source PRD.functionalRequirements[].id
        frText: |
          `browzer ask` accepts a `--json` flag.
      - acId: AC-03
        acText: |
          Given a user runs `browzer ask "..."` without `--json`, then stdout
          remains the existing prose format byte-for-byte.
        frId: FR-03
        frText: "Default output (no --json) is unchanged prose"

# OPTIONAL — But REQUIRED when scope.files[].path intersects EXPLORATION.md
# sensitiveScopeHits[]. Empty array on a sensitive task is a Reviewer-pass
# rejection: populate from project conventions OR add a sentinel
# INVARIANT_RATIONALE: rule explaining the absence.
invariants:
  - rule: "Token comparison MUST use timingSafeEqual from node:crypto — never ==="
    source: "packages/cli/internal/api/ask.go"

# REQUIRED — Installed domain skills copied VERBATIM from
# EXPLORATION.md.domains[].skillsFound[] for the bucket this task belongs to.
# execute-task invokes each entry via Skill() before any code work — see
# packages/skills/references/subagent-preamble.md for the invocation rule.
# Empty array is valid; if EXPLORATION.md had no skills for this domain,
# leave empty rather than inventing a skill name.
skillsFound:
  - name: golang-best-practices                     # exact installed name
    relevance: high                                 # Enum: high | medium | low
    installedAt: ~/.claude/skills/golang-best-practices

# OPTIONAL — Reviewer flag for granularity concerns. Surfaces to the operator
# pre-execute-task; execute-task itself does NOT block on this — it is
# advisory. Set when this task's scope.files[] is unusually small (<2) or
# large (>10), or when the Reviewer detected a premature-completion signal.
granularityNote:
  verdict: ok                                       # Enum: ok | split | collapse | premature
  rationale: "Bucketed cli scope with 4 files — within typical range."

# OPTIONAL — Test specs to author later (consumed by write-tests, NOT by
# execute-task). Each entry names the test file to create, the assertion
# intent, and STRUCTURED AC/FR ID arrays. The `description` field stays
# focused on TEST LOGIC — do not paste AC/FR prose ("Pins AC-03 / FR-03")
# into it. Use `pinsAcs[]` + `pinsFrs[]` instead so write-tests has an
# unambiguous cross-reference into acceptanceCriteria[] in this same file.
# Empty array is valid.
testSpecs:
  - testId: T-1                                     # Pattern: ^T-[0-9]+$
    file: packages/cli/internal/commands/ask_test.go
    intent: green                                   # Enum: green | red | chaos
    scope: unit                                     # Enum: unit | integration | e2e | chaos
    description: |
      Asserts that --json output parses as JSON with required fields.
    pinsAcs: [AC-01]                                # OPTIONAL — PRD AC IDs this test pins.
                                                    # Each ID MUST also appear in
                                                    # acceptanceCriteria[].bindsTo[].acId on
                                                    # this same task (no orphan pin).
    pinsFrs: [FR-01, FR-02]                         # OPTIONAL — PRD FR IDs this test pins.
                                                    # Each ID MUST also appear in
                                                    # acceptanceCriteria[].bindsTo[].frId on
                                                    # this same task.

# OPTIONAL — Task-to-task dependencies. Pattern: ^TASK_[0-9]{2}$
# An entry means "TASK_XX must complete before this task starts".
# Used by render-task-graph.mjs to topologically sort and group
# parallelizable tasks (disjoint scope within same layer).
dependsOn: []
```

## Body convention

The markdown body below the frontmatter is **narrative for the executor**.
Frontmatter is the structured contract; the body explains rationale and
context that does not fit in fields. Downstream LLMs read the frontmatter
first and may skip the body for ALL fields that exist in frontmatter — do
not duplicate frontmatter data in the body.

Canonical body sections (all optional except `## Goal`):

```markdown
# {title}

## Goal
{One-paragraph statement of what "done" looks like for this task.}

## Implementation hints
{Optional. Architecture context, prior art, or tradeoffs the executor
should know. NOT a prescriptive step-by-step — execute-task subagents are
trusted to design implementation. Hint, don't dictate.}

## Open questions
- {Operator-actionable question raised during decomposition.}

## Related
- TASK_GRAPH.md — dependency graph + parallelizable groups
- EXPLORATION.md — feature-wide context (operator review only — executor does not read this)
- PRD.md — original requirements (operator review only)
```

## How to extend this template

Adding a new field to the TASK_NN.md contract:

1. Add the field to the frontmatter example with `# REQUIRED` or `# OPTIONAL`.
2. Include pattern/enum/cross-ref note in the comment.
3. Update downstream skills (`execute-task`, `write-tests`, `feature-acceptance`)
   that consume the field. Each consumer skill explicitly names which fields
   it reads in its own SKILL.md — keep those in sync.
4. If the new field affects the manifest view, update
   `scripts/render-task-graph.mjs`.

The contract has no formal schema. Discipline lives in this file plus the
SKILL.md body. Drift is caught at integration time.

## ID format quick reference

| Field | Pattern | Example |
|---|---|---|
| `taskId` | `^TASK_[0-9]{2}$` | `TASK_01` |
| `acceptanceCriteria[].id` | `^T-AC-[0-9]+$` | `T-AC-01` |
| `acceptanceCriteria[].bindsTo[].acId` | `^AC-[0-9]+$` | `AC-03` (refs PRD) |
| `acceptanceCriteria[].bindsTo[].frId` | `^FR-[0-9]+$` | `FR-01` (refs PRD) |
| `testSpecs[].testId` | `^T-[0-9]+$` | `T-1` |
| `dependsOn[]` | `^TASK_[0-9]{2}$` | `TASK_02` |
| `prdSha` | `^[0-9a-f]{40}$` | git-blob SHA (40 hex chars) |

## Cross-reference invariants

By convention (verified by the agent during authoring, not by a script):

1. Every `acceptanceCriteria[].bindsTo[].acId` references an existing `acceptanceCriteria[].id` in the source PRD.
2. Every `acceptanceCriteria[].bindsTo[].frId` references an existing `functionalRequirements[].id` in the source PRD.
3. Every `bindsTo[].frText` matches the source PRD's FR text verbatim (modulo whitespace normalisation).
4. Every `bindsTo[].acText` matches the source PRD's AC text verbatim.
5. Every `scope.files[].path` matches a `domains[].likelyFiles[].path` in the source EXPLORATION.md (or is a brand-new file the task creates — flag in body).
6. Every `scope.files[].blastRadius` is copied verbatim from EXPLORATION.md.
7. Every `skillsFound[].name` and `installedAt` matches the source EXPLORATION.md `domains[].skillsFound[]` for this task's bucket.
8. When a `scope.files[].path` matches EXPLORATION.md's `sensitiveScopeHits[].path`, `invariants[]` MUST be non-empty (or carry an `INVARIANT_RATIONALE:` sentinel entry).
9. `prdSha` matches the source EXPLORATION.md's `prdSha` (which in turn matches PRD.md at scope-feature run time).
10. Every `dependsOn[]` entry references a `taskId` of another TASK_NN.md in the same feature directory.
11. Every `testSpecs[].pinsAcs[]` entry references an `acId` that already appears in this task's `acceptanceCriteria[].bindsTo[].acId` (no orphan pin — a test cannot pin an AC that the task does not bind).
12. Every `testSpecs[].pinsFrs[]` entry references an `frId` that already appears in this task's `acceptanceCriteria[].bindsTo[].frId`.
13. `testSpecs[].description` MUST stay focused on TEST LOGIC. It MUST NOT carry AC/FR prose references like "Pins AC-03 / FR-03" — those are an intra-file leak. Use `pinsAcs[]` / `pinsFrs[]` instead.
