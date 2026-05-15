<!--
  Compact PRD template for the generate-prd skill (tier=standard).

  Target: 200–400 lines. Strips uxCategory / overview / objectives /
  inScope / outOfScope / deliverables / nonFunctionalRequirements / risks /
  dependencies / assumptions / the elaborate USER_STORIES section. Keeps:
    - featureId + title (header)
    - personas (terse — 1–2 entries)
    - userStories (terse — required by SKILL.md §grounding-protocol; pruned of
      journeySteps + sentiment richness)
    - functionalRequirements (no NFR reconfirmation prompt)
    - acceptanceCriteria (with verification[] block; less elaborate than full)
    - successMetrics (the single optional section retained)

  Use this template when CONFIG.tier == standard. For tier=full use
  template.full.md. tier=express never dispatches this skill — the
  orchestrator inline-writes a `## PRD-compact` section into BRIEF.md.

  HOW TO READ THIS FILE
  - `REQUIRED` markers in comments → field MUST be present and non-empty
  - `OPTIONAL` markers in comments → field MAY be omitted entirely
  - `Pattern: ...` → regex the value must match (IDs only)
  - `Enum: ...` → allowed values
  - `Refs ...` → field references another field; values must match an existing id

  Example feature used below: "Add `lastLoginAt` field to user schema and
  surface in dashboard". Paths in angle brackets are PLACEHOLDERS —
  substitute your host repo's actual app/package name.
-->

# PRD template — compact (tier=standard)

## Frontmatter

```yaml
# REQUIRED — Stable feature identifier matching the parent folder name.
# Pattern: ^feat-[0-9]{8}-[a-z0-9-]+$
featureId: feat-20260512-last-login-at

# REQUIRED — Human-readable feature label. Minimum 3 chars.
title: "Surface lastLoginAt in user dashboard"

# OPTIONAL — Carry-forward receipts from PRD grounding so scope-feature can
# dedup `browzer` queries. See scope-feature §PRD receipt carry-forward.
prdReceipts: []

# REQUIRED — At least 1 persona, verified via `browzer search`/`explore`.
personas:
  - id: P-01                                  # Pattern: ^P-[0-9]+$
    description: |
      Platform operators auditing tenant activity; need to see the last
      login timestamp for each user from the dashboard.

# REQUIRED — User stories (terse). One bullet per persona × intent pair.
# `bindsAcceptance[]` MUST reference acceptanceCriteria[].id.
userStories:
  diagramType: journey                        # Enum: journey | sequence | state | mindmap
  stories:
    - id: US-01                               # Pattern: ^US-[0-9]+$
      persona: P-01
      wants: "to see when each tenant user last logged in, in the dashboard user list"
      benefit: "so I can spot dormant accounts during compliance review"
      bindsAcceptance: [AC-01, AC-02]

# REQUIRED — At least 1 FR. Each FR is the unit generate-task groups tasks
# around. Every FR MUST be referenced by ≥1 acceptanceCriteria[].bindsTo.
functionalRequirements:
  - id: FR-01                                 # Pattern: ^FR-[0-9]+$
    text: |
      User schema carries a `lastLoginAt` timestamp updated on every
      successful authentication.
    priority: must                            # Enum: must | should | could

  - id: FR-02
    text: |
      Dashboard user list displays the `lastLoginAt` value as a relative
      time string (e.g. "2h ago") with the exact timestamp on hover.
    priority: must

# REQUIRED — At least 1 AC. Each AC MUST bindTo ≥1 FR and SHOULD carry a
# structured `verification:` block.
#
# verification.kind enum:
#   shell-runnable | http-probe | metric-query | browser-probe | manual | requires-cluster
# verification.requires[]: capability tags Phase 0 must have detected
# verification.commands[]: list of { run, expect, timeout }
# verification.failure-mode: pre-commit | post-merge
#
# Auto-revisão checklist before writing each AC:
#   - For grep-based ACs, exclude the file declaring the searched symbol.
#   - For build/lint/typecheck ACs, scope to changed files (not global baseline).
#   - For test-based ACs, cite the exact test file path.
acceptanceCriteria:
  - id: AC-01                                 # Pattern: ^AC-[0-9]+$
    text: |
      Given a user who logged in within the last hour, when the dashboard
      user list renders for that tenant, then their row shows a
      `lastLoginAt` value in the column.
    bindsTo: [FR-01, FR-02]                   # ≥1 FR-NN
    verification:
      kind: shell-runnable
      requires: [postgres]
      commands:
        - run: |
            psql -tAc "SELECT last_login_at FROM users WHERE id = '<test-user-id>';"
          expect: 'regex:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"'
          timeout: 10
      failure-mode: pre-commit

  - id: AC-02
    text: |
      Given AC-01's user, then the dashboard row's relative-time string
      matches `regex:"^[0-9]+[smhd] ago$"` and hovering shows the full
      ISO-8601 timestamp.
    bindsTo: [FR-02]
    verification:
      kind: browser-probe
      requires: [browser]
      commands:
        - run: |
            # Run via the operator's browser MCP / agent-browser; verify in DOM.
            echo "manual until MCP browser available"
          expect: contains:"ago"
          timeout: 30
      failure-mode: pre-commit

# OPTIONAL — Post-launch signals. Only fill when the probe surfaced a
# measurable signal (the single optional section retained at tier=standard).
# Not verified by feature-acceptance; informational for the operator's audit
# trail and for code-review's severity-promotion crossref.
successMetrics:
  - id: M-01                                  # Pattern: ^M-[0-9]+$
    metric: "% of tenants reading the dashboard column within 7 days of release"
    target: "≥ 40% of tenants visit the user-list page weekly"
    method: "Langfuse dashboard render trace; cohort = tenants active in last 30 days"
```

## Body convention

The markdown body below the frontmatter is for **narrative context only**.
All structured data lives in frontmatter. Downstream skills NEVER parse
the body.

`overview`, `Background`, `Open questions`, `Notes`, `Related` sections
are OPTIONAL at tier=standard and SHOULD be omitted unless the operator
explicitly needs them. The template below shows the minimal shape; copy
only what you need.

## Overview

(one paragraph; what + why + who benefits; no implementation detail)

## ID format quick reference

| Prefix | Refers to            | Pattern        | Min count |
|--------|----------------------|----------------|-----------|
| P-     | Persona              | `^P-[0-9]+$`   | ≥1        |
| US-    | User story           | `^US-[0-9]+$`  | ≥1        |
| FR-    | Functional reqt      | `^FR-[0-9]+$`  | ≥1        |
| AC-    | Acceptance criterion | `^AC-[0-9]+$`  | ≥1        |
| M-     | Success metric       | `^M-[0-9]+$`   | 0+        |

## Cross-reference invariants

The renderer + downstream consumers (`scope-feature`, `generate-task`,
`feature-acceptance`) validate these by convention:

1. Every `acceptanceCriteria[].bindsTo[]` references an existing `functionalRequirements[].id`.
2. Every `userStories.stories[].bindsAcceptance[]` references an existing `acceptanceCriteria[].id`.
3. Every `userStories.stories[].persona` references an existing `personas[].id`.
4. Every `personas[]` has at least one `userStories.stories[]` entry referencing it.
5. AC IDs and FR IDs are unique within their respective arrays.

A failure of any invariant is a contract violation; the agent MUST halt
and surface the mismatch rather than emit an invalid PRD.

## Compact vs full

If the operator passes `--tier=full` to the orchestrator, generate-prd
dispatches against `template.full.md` instead. The full template carries
6 OPTIONAL sections this compact one strips (uxCategory, overview,
objectives, inScope, outOfScope, deliverables, nonFunctionalRequirements,
risks, dependencies, assumptions) and gives PMs room to elaborate on
context, risks, and constraints — at the cost of 2–4× the line count.

The skill body reads `staging/CONFIG.md.tier` and picks the appropriate
template; the PM authors against ONE template per feat, never both.
