<!--
  Canonical EXPLORATION.md template for the scope-feature skill.

  This file is the single source of truth for the EXPLORATION shape. The skill
  body references this file; the LLM reads it before authoring EXPLORATION.md.

  HOW TO READ THIS FILE
  - `REQUIRED` markers in comments → field MUST be present and non-empty
  - `OPTIONAL` markers in comments → field MAY be omitted entirely
  - `Pattern: ...` → regex the value must match (IDs only)
  - `Enum: ...` → allowed values
  - `Refs ...` → field references another field; values must match an existing id

  Cross-references are validated by convention. The skill body tells the agent
  to verify them. There is no automatic validator — the discipline is in the
  contract.

  Example feature used below: PRD adding `--json` flag to `browzer ask`.
-->

# EXPLORATION template

## Frontmatter

```yaml
# REQUIRED — Matches the parent folder name and the PRD's featureId.
# Pattern: ^feat-[0-9]{8}-[a-z0-9-]+$
featureId: feat-20260512-browzer-ask-json

# REQUIRED — git-blob SHA of the PRD.md that grounded this scope.
# Captured via `git hash-object docs/browzer/<feat>/staging/PRD.md`.
# Downstream skills compare against the current PRD SHA to detect post-scope
# drift. When they diverge, the operator should re-run /scope-feature.
prdSha: 9c4e7e2a3fb1d8c6a1b09e2c3f7a8d1e0b5c4d6e

# REQUIRED — RFC3339 timestamp of when scope-feature ran.
generatedAt: 2026-05-12T14:23:00Z

# REQUIRED — At least 1 domain bucket. Each bucket is one "place in the repo"
# the feature touches (apps/X, packages/Y, infra, docs). A single file belongs
# to exactly one bucket; bucket selection follows path prefix (longest match).
domains:
  - name: packages/cli                         # REQUIRED — bucket identifier

    # REQUIRED — FR references from the source PRD, FULL TEXT INLINED.
    # Downstream consumers (generate-task → execute-task) must never need to
    # back-reference PRD.md. Closure principle: the text travels with the data.
    relatedFRs:
      - id: FR-01                              # Pattern: ^FR-[0-9]+$  Refs PRD.functionalRequirements[].id
        text: |
          `browzer ask` accepts a `--json` flag.
      - id: FR-02
        text: |
          `--json` returns an object with fields: answer (string), confidence
          (number 0..1), sources (array of {path, score, excerpt}).

    # REQUIRED — Files in this bucket likely touched by the feature.
    # Empty array is valid for placeholder/follow-up domains but rare.
    likelyFiles:
      - path: packages/cli/internal/commands/ask.go    # REQUIRED — repo-relative, POSIX separators
        score: 0.91                                    # REQUIRED — 0..1 relevance from browzer explore
        # OPTIONAL — exported symbols (from browzer explore graph data)
        exports: [askRun, askConfig]
        # OPTIONAL — imports (from browzer deps forward)
        imports:
          - "@browzer/cli/internal/api"

        # REQUIRED — Blast radius (both directions). Empty arrays valid for
        # brand-new files. `reverseCount` MUST be present (may be 0).
        blastRadius:
          # OPTIONAL — Top-K forward deps. Cap 15 by relevance score.
          # Each entry carries `kind` so consumers can filter by edge type.
          forward:
            - target: packages/cli/internal/api/ask.go
              kind: imports                            # Enum: imports | imports-type
              symbols: [Ask]
          # OPTIONAL — Top-K reverse importers. Cap 15.
          # Filtering rules applied BEFORE truncation:
          #   1. Drop entries that are themselves in domains[].likelyFiles[]
          #      (co-changing — not external blast).
          #   2. ALWAYS keep test files (signal for write-tests downstream).
          #   3. Drop generated artefacts: *.gen.*, *.pb.go, vendor/**.
          reverse:
            - source: packages/cli/internal/commands/root.go
              kind: imported-by                        # Enum: imported-by
              via: rootCmd                             # OPTIONAL — the symbol or registration site
            - source: packages/cli/internal/commands/ask_test.go
              kind: imported-by
              via: testRunner
          # REQUIRED — Full reverse count BEFORE truncation. May be 0.
          reverseCount: 8
          # OPTIONAL — Present only when reverseCount > the top-K cap.
          truncatedAt: 15

    # REQUIRED — Installed domain skills resolved via find-skills programmatic.
    # Empty array is valid (no installed skill matched). Every entry MUST have
    # a verified `installedAt` path that exists on disk at scope-feature time.
    # Never invent names. Use the EXACT string from find-skills `installed[]`.
    skillsFound:
      - name: golang-best-practices             # REQUIRED — exact installed name
        relevance: high                         # Enum: high | medium | low
        installedAt: ~/.claude/skills/golang-best-practices

# OPTIONAL — Path matches against the cross-skill sensitive-path predicate
# (../../references/sensitive-paths.md). Empty array is valid — most features
# touch zero sensitive surfaces. `generate-task` reads this to require
# non-empty `task.invariants[]` for any task whose scope intersects.
sensitiveScopeHits: []
# Example shape when populated:
# sensitiveScopeHits:
#   - path: apps/auth/src/device-flow.ts
#     pattern: "**/auth/**/*.{ts,js,go}"
#     reason: identity-mutation
#     invariantSources:
#       - apps/auth/CLAUDE.md
#       - packages/skills/references/sensitive-paths.md

# REQUIRED — Feature-wide blast radius (union of every `likelyFiles[].blastRadius.reverse[]`
# minus the self-set of all `likelyFiles[]`). Rendered visually by
# scripts/render-blast.mjs into EXPLORATION_BLAST.mmd. Consumed by
# feature-acceptance and code-review to verify the actual diff stays within
# the predicted blast surface.
featureBlastRadius:
  reverseUnion:
    - packages/cli/internal/commands/root.go
    - packages/cli/internal/commands/ask_test.go
  reverseCount: 8           # union size BEFORE truncation
  truncatedAt: 50           # OPTIONAL — only when union exceeded the visual cap

# OPTIONAL — Open questions or unresolved ambiguity from the PRD. Surfaces
# to generate-task to flag in granularityWarnings or to the operator.
# Also the home for index-staleness disclaimers.
assumptions:
  - |
    PRD FR-02 says "answer (string)" without specifying max length; treating
    as unbounded for blast radius purposes.
```

## Body convention

The markdown body below the frontmatter is **narrative for human review**.
Downstream LLMs read only the frontmatter — never duplicate frontmatter data
in the body (drift bait).

Canonical body sections (all optional):

```markdown
# Scope map — {featureId}

## Domains covered
{One paragraph per bucket — what files were discovered and why they form a domain.}

## Sensitive scope
{Narrative on what was matched and what invariants generate-task should enforce.}

## Open questions for generate-task
- {Operator-actionable question.}

## Related
- EXPLORATION_BLAST.mmd — generated mermaid blast graph
- RECEIPTS.md — appended scope-feature section
```

## How to extend this template

Adding a new field to the EXPLORATION contract:

1. Add the field to the frontmatter example above with `# REQUIRED` or `# OPTIONAL` marker.
2. Include pattern/enum/cross-ref note in the comment.
3. Update `scripts/render-blast.mjs` if the new field affects the mermaid diagram.
4. Update downstream skill bodies (`generate-task`, `feature-acceptance`) if they consume the new field.

The contract has no formal schema. Discipline lives in this file plus the
SKILL.md body. Drift is caught at integration time when downstream consumers
hit unexpected shapes.

## ID format quick reference

| Field | Pattern | Example |
|---|---|---|
| `featureId` | `^feat-[0-9]{8}-[a-z0-9-]+$` | `feat-20260512-browzer-ask-json` |
| `domains[].relatedFRs[].id` | `^FR-[0-9]+$` | `FR-01` |
| `prdSha` | `^[0-9a-f]{40}$` | git-blob SHA (40 hex chars) |

## Cross-reference invariants

By convention (verified by the agent during authoring, not by a script):

1. Every `domains[].relatedFRs[].id` references an existing `functionalRequirements[].id` in the source PRD.
2. Every PRD `functionalRequirements[].id` is referenced by ≥1 `domains[].relatedFRs[]` (no orphan FRs in scope — every requirement maps to a place in the repo).
3. Every `likelyFiles[].path` is repo-relative POSIX (no absolute paths, no leading `./`, no `\` separators).
4. Every `domains[].skillsFound[].installedAt` is a path that exists on disk when scope-feature ran (verified before persistence).
5. `prdSha` matches `git hash-object docs/browzer/<feat>/staging/PRD.md` at scope-feature run time.
6. Every `likelyFiles[].blastRadius.reverse[].source` is repo-relative and is NOT itself an entry in any `likelyFiles[].path` (co-changing files are excluded by the filter rule above).
7. Every `featureBlastRadius.reverseUnion[]` entry equals the union of `likelyFiles[].blastRadius.reverse[].source` minus the self-set of `likelyFiles[].path`.
