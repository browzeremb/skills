<!--
  Canonical PRD template for the generate-prd skill.

  This file is the single source of truth for the PRD shape. The skill body
  references this file; the LLM reads it before authoring the PRD.

  HOW TO READ THIS FILE
  - `REQUIRED` markers in comments → field MUST be present and non-empty
  - `OPTIONAL` markers in comments → field MAY be omitted entirely
  - `Pattern: ...` → regex the value must match (IDs only)
  - `Enum: ...` → allowed values
  - `Refs ...` → field references another field; values must match an existing id

  Cross-references are validated by convention. The skill instructions tell
  the agent to verify them. There is no automatic validator — the discipline
  is in the contract.

  Example feature used below: adding `--json` flag to `browzer ask`.
-->

# PRD template

## Frontmatter

```yaml
# REQUIRED — Stable feature identifier matching the parent folder name.
# Pattern: ^feat-[0-9]{8}-[a-z0-9-]+$
featureId: feat-20260512-browzer-ask-json

# REQUIRED — Human-readable feature label. Minimum 3 chars.
title: "Add --json output to `browzer ask`"

# OPTIONAL — Feature category for downstream gating. Defaults to `mechanism`
# when omitted. Drives PM visibility-predicate checklist + code-review
# severity-crossref auto-promotion.
#
# Enum: perception | mechanism | mixed
#   perception — deliverable is what the user SEES (optimistic UI, perceived
#                performance, instant feedback, animated transitions,
#                skeleton states, undo/redo, latency masking). Mechanism is
#                necessary but NOT sufficient: an AC that asserts cache/DOM
#                state can pass while the user perceives no change because a
#                modal/sheet/drawer occludes the affected region. Triggers
#                the PM visibility-predicate checklist (see SKILL.md
#                §Visibility-predicate checklist) and code-review
#                severity-promotion when a finding contradicts a perception
#                successMetric.
#   mechanism  — deliverable is a contract change observable in code/state
#                (API surface, schema, persistence, computed result). The
#                user does not need to perceive it (or perceives it via a
#                separate UI feature that consumes the mechanism).
#   mixed      — both perception and mechanism stakes; checklist runs but
#                non-perception ACs are not auto-promoted on success-metric
#                cross-match.
uxCategory: mechanism

# OPTIONAL — One- to three-paragraph executive summary.
# What the feature is, why it exists, who benefits. No implementation detail.
overview: |
  Agents that consume `browzer ask` answers today must regex-parse prose,
  which is brittle. Adding `--json` returns a structured payload with the
  synthesized answer plus the underlying source documents and scores, so
  downstream skills can branch on confidence and cite verbatim sources
  without re-querying.

# REQUIRED — At least 1 persona. Personas MUST be real users of this repo,
# verified via `browzer ask`. Inventing personas is a contract violation.
personas:
  - id: P-01                                  # Pattern: ^P-[0-9]+$
    description: |
      Agent specialists dispatched by orchestrate-task-delivery (browzer:pm,
      browzer:po, browzer:coder). They consume `browzer ask` programmatically
      and need machine-readable answers.

  - id: P-02
    description: |
      CLI operators running `browzer ask` interactively in a terminal. They
      currently get prose output and have no reason to switch — `--json` is
      opt-in for them.

# REQUIRED — Structured user stories. The diagram in USER_STORIES.md is
# generated DETERMINISTICALLY from this field by scripts/render-user-stories.mjs.
# Never author raw mermaid; only fill the stories.
userStories:
  # REQUIRED — Drives which renderer branch is used.
  # Enum: journey | sequence | state | mindmap
  # Choose based on feature shape:
  #   journey  — linear flows (login, signup, single-actor walkthrough)
  #   sequence — multi-actor interactions (webhook ↔ worker ↔ DB)
  #   state    — state machines (onboarding wizard, status transitions)
  #   mindmap  — hierarchical capability decomposition
  diagramType: journey

  # OPTIONAL — Title for the mermaid diagram. Defaults to the PRD title.
  diagramTitle: "Agent consumes browzer ask --json"

  # REQUIRED — At least 1 story.
  stories:
    - id: US-01                               # Pattern: ^US-[0-9]+$
      persona: P-01                           # Refs personas[].id
      wants: "invoke `browzer ask --json` and parse stdout as JSON"
      benefit: "so I can skip prose regex-parsing and branch on confidence"
      bindsAcceptance: [AC-01, AC-02]         # Refs acceptanceCriteria[].id
      # OPTIONAL — Ordered journey steps. Used when diagramType=journey to
      # produce richer mermaid output. Ignored for other diagram types.
      journeySteps:
        - step: "Run `browzer ask 'how does X work?' --json`"
          sentiment: 5                         # Integer 0–5; 0=friction, 5=delight
          actors: [Agent, CLI]
        - step: "Parse stdout as JSON"
          sentiment: 5
          actors: [Agent]
        - step: "Branch on `confidence` field"
          sentiment: 5
          actors: [Agent]

    - id: US-02
      persona: P-02
      wants: "keep getting prose output by default"
      benefit: "so my muscle memory doesn't break"
      bindsAcceptance: [AC-03]
      journeySteps:
        - step: "Run `browzer ask 'how does X work?'` (no flag)"
          sentiment: 5
          actors: [Operator, CLI]
        - step: "See prose answer as today"
          sentiment: 5
          actors: [Operator]

# OPTIONAL — Outcome-level goals (1–5 bullets). Outcome, not output.
# Good: "Reduce agent retry rate on browzer ask consumption by 40%".
# Bad:  "Add a --json flag" (that's a deliverable, not an objective).
objectives:
  - "Eliminate regex-parsing of prose answers in agent consumers"
  - "Surface answer confidence so agents can branch on uncertainty"

# OPTIONAL — Concrete paths, capabilities, or surfaces touched.
# Prefer specific paths over vague descriptions.
inScope:
  - "packages/cli/internal/commands/ask.go — add --json flag wiring"
  - "packages/cli/internal/api/ask.go — extend response shape"
  - "packages/cli/README.md — document the flag"

# OPTIONAL — Explicit non-goals. Prevents scope creep downstream.
outOfScope:
  - "Streaming JSON output (ndjson) — separate feature"
  - "Schema versioning of the JSON response"

# OPTIONAL — Tangible artifacts produced (distinct from inScope).
# inScope = areas touched. deliverables = outputs produced.
deliverables:
  - "New CLI flag: `browzer ask --json`"
  - "Response JSON shape documented in README"

# REQUIRED — At least 1 FR. Each FR is the unit generate-task groups tasks
# around. Every FR MUST be referenced by ≥1 acceptanceCriteria[].bindsTo.
functionalRequirements:
  - id: FR-01                                 # Pattern: ^FR-[0-9]+$
    text: "`browzer ask` accepts a `--json` flag"
    priority: must                            # Enum: must | should | could

  - id: FR-02
    text: |
      `--json` returns an object with fields: answer (string), confidence
      (number 0..1), sources (array of {path, score, excerpt}).
    priority: must

  - id: FR-03
    text: "Default output (no --json) is unchanged prose"
    priority: must

# REQUIRED — At least 1 AC. Each AC MUST bindTo ≥1 FR.
# Phrase as Given/When/Then. Testable, not aspirational.
#
# Each AC SHOULD carry a structured `verification:` block describing exactly
# how `feature-acceptance` should verify it. When the block is absent,
# `feature-acceptance` falls back to verification-methods.md heuristics
# (text inference), which is fragile and was the #1 escape vector for live
# bugs reaching post-commit.
#
# verification.kind enum:
#   shell-runnable    — a single shell command can verify; commands[] run
#                       in autonomous mode and exit code + stdout pattern
#                       gate the verdict.
#   http-probe        — needs a live HTTP endpoint; commands[] use curl
#                       against a service already booted by Phase 0
#                       autonomous-with-stack-boot.
#   metric-query      — needs to query an observability backend (Langfuse,
#                       Prometheus, Grafana). Defer to post-merge unless
#                       the backend is live during acceptance.
#   browser-probe     — needs a real browser DOM. Promoted to autonomous
#                       when an MCP browser tool is detected (Phase 0
#                       capability probe); otherwise hybrid with operator
#                       runbook.
#   manual            — requires human judgment (design review, perception
#                       check). NEVER auto-flipped to verified.
#   requires-cluster  — needs an external environment unreachable from the
#                       acceptance host. Always deferred-post-merge.
#
# verification.requires[] — capability tags Phase 0 must have detected for
#   the AC to be `runnable-here`. Tags: daemon, sqlite, postgres, redis,
#   browser, http, network, perf-loop, mutation-runner.
#
# verification.commands[] — list of {run, expect, timeout}. expect MUST
#   match `exit-code:N` | `contains:"<string>"` | `regex:"<pattern>"` |
#   `stdout-empty` | `stdout-nonempty`.
#
# verification.failure-mode:
#   pre-commit  — block commit on failure (default for shell-runnable).
#   post-merge  — record fail/deferred, allow commit (used for metric-query
#                 and requires-cluster).
#
# verification.metric — optional crossref to successMetrics[]. Drives the
# code-review severity-promotion rule: a finding that, if uncorrected,
# violates this metric, is auto-promoted per code-review/SKILL.md
# §Severity success-metric crossref.
#
# Auto-revisão checklist the PM MUST run before writing each AC:
#   - For every grep-based AC, is the file declaring the searched symbol
#     EXCLUDED from the regex? Otherwise "zero matches" is unachievable in
#     the correct state.
#   - For every build/lint/typecheck AC, is the scope restricted to changed
#     files (not the global baseline, which may be pre-poluted)?
#   - For every test-based AC, is the exact test file path cited?
#   - For ACs of `kind: browser-probe` or describing user-perceived state
#     (when uxCategory == perception), is the visibility-predicate
#     answered? See SKILL.md §Visibility-predicate checklist.
acceptanceCriteria:
  - id: AC-01                                 # Pattern: ^AC-[0-9]+$
    text: |
      Given a logged-in CLI user, when they run `browzer ask "..." --json`,
      then stdout is parseable JSON with required fields {answer, confidence,
      sources}.
    bindsTo: [FR-01, FR-02]                   # ≥1 FR-NN; refs functionalRequirements[].id
    verification:
      kind: shell-runnable
      requires: [daemon]
      commands:
        - run: |
            browzer ask "ping" --json
          expect: 'regex:"\"answer\"\\s*:"'
          timeout: 30
      failure-mode: pre-commit

  - id: AC-02
    text: |
      Given AC-01 succeeded, when the agent reads `confidence < 0.5`, then it
      can choose to escalate or query further sources.
    bindsTo: [FR-02]
    verification:
      kind: shell-runnable
      requires: [daemon]
      commands:
        - run: |
            browzer ask "ping" --json | jq -r '.confidence | type'
          expect: contains:"number"
          timeout: 30
      failure-mode: pre-commit

  - id: AC-03
    text: |
      Given a user runs `browzer ask "..."` without `--json`, then stdout
      remains the existing prose format byte-for-byte.
    bindsTo: [FR-03]
    verification:
      kind: shell-runnable
      requires: [daemon]
      commands:
        - run: |
            diff <(browzer ask "ping") <(browzer ask "ping")
          expect: exit-code:0
          timeout: 30
      failure-mode: pre-commit

# OPTIONAL — Constraints (performance, security, observability, a11y).
# `target` MUST be measurable. Vague targets ("must be performant", "should
# be reliable") are anti-patterns. Be concrete or omit the NFR.
nonFunctionalRequirements:
  - id: NFR-01                                # Pattern: ^NFR-[0-9]+$
    category: performance
    target: "p95 latency with --json ≤ 110% of prose-mode p95 (measured locally)"
    # OPTIONAL — When true, feature-acceptance runs `target` as a shell command.
    runnable: false

  - id: NFR-02
    category: observability
    text: "Langfuse trace captures the JSON branch separately from prose"
    target: "trace metadata.outputMode in {prose, json}"
    runnable: false

# OPTIONAL — Post-launch signals. Not verified by feature-acceptance.
successMetrics:
  - id: M-01                                  # Pattern: ^M-[0-9]+$
    metric: "Agent consumer retry rate on `browzer ask`"
    target: "≤ 5% (baseline: ~15%)"
    method: "Langfuse trace aggregation, 30-day rolling"

# OPTIONAL — Known threats. Each MUST have a mitigation.
risks:
  - id: R-01                                  # Pattern: ^R-[0-9]+$
    text: "JSON shape drifts across CLI versions and breaks consumers"
    mitigation: |
      Pin shape in CLI integration tests; semver discipline on response fields.

# OPTIONAL — Internal/external dependencies for parallelizability detection.
dependencies:
  internal:
    - "packages/cli/internal/api/ask.go"
  external: []

# OPTIONAL — Things the PRD takes for granted. Also the home for:
#   (1) search-trigger expansion proposals (see references/search-trigger-proposal.md)
#   (2) index-staleness disclaimers when the preflight detected stale data
assumptions:
  - |
    Existing `browzer ask` HTTP backend already returns a structured response;
    `--json` is a CLI presentation flag, not a backend change.
```

## Body convention

The markdown body below the frontmatter is for **narrative context only**.
All structured data lives in frontmatter. The body should not duplicate
tables of FRs/ACs — that creates drift. Operators reviewing the PRD on
GitHub get structured data via:

- `USER_STORIES.md` (generated by `scripts/render-user-stories.mjs`)
- Future `PRD_SUMMARY.md` (auto-generated table view, not yet implemented)

Canonical body sections (all optional):

```markdown
# {title}

## Overview
{mirrors frontmatter.overview verbatim, OR free-form expansion}

## Background / Prior art
{links to ADRs, related features, conversations}

## Open questions
- {question 1}
- {question 2}

## Notes
{free-form PM context, alternatives considered, trade-offs discussed}

## Related
- USER_STORIES.md — generated journey diagram
- RECEIPTS.md — browzer grounding audit trail
```

## How to extend this template

Adding a new field to the PRD contract:

1. Add the field to the frontmatter example above with `# REQUIRED` or `# OPTIONAL` marker
2. Include pattern/enum/cross-ref note in the comment
3. Update `scripts/render-user-stories.mjs` if the new field affects the diagram
4. Update downstream skill bodies (`generate-task`, `feature-acceptance`, etc.) if they consume the new field

The contract has no formal schema. Discipline lives in this file plus the
SKILL.md body. Drift is caught at integration time when downstream consumers
hit unexpected shapes.

## ID format quick reference

| Field | Pattern | Example |
|---|---|---|
| `featureId` | `^feat-[0-9]{8}-[a-z0-9-]+$` | `feat-20260512-browzer-ask-json` |
| `personas[].id` | `^P-[0-9]+$` | `P-01` |
| `userStories.stories[].id` | `^US-[0-9]+$` | `US-01` |
| `functionalRequirements[].id` | `^FR-[0-9]+$` | `FR-01` |
| `acceptanceCriteria[].id` | `^AC-[0-9]+$` | `AC-01` |
| `nonFunctionalRequirements[].id` | `^NFR-[0-9]+$` | `NFR-01` |
| `successMetrics[].id` | `^M-[0-9]+$` | `M-01` |
| `risks[].id` | `^R-[0-9]+$` | `R-01` |

## Cross-reference invariants

By convention (verified by the agent during authoring, not by a script):

1. Every `acceptanceCriteria[].bindsTo[i]` references an existing `functionalRequirements[].id`
2. Every `userStories.stories[].persona` references an existing `personas[].id`
3. Every `userStories.stories[].bindsAcceptance[i]` references an existing `acceptanceCriteria[].id`
4. Every `functionalRequirements[].id` is referenced by ≥1 `acceptanceCriteria[].bindsTo` (no orphan FRs)
5. Every `acceptanceCriteria[].verification.metric.bindsTo` (when present) references an existing `successMetrics[].id`
6. When `uxCategory == perception`, at least one AC MUST carry `verification.kind: browser-probe` OR `verification.kind: manual` referencing a perception-class success metric. Otherwise the PRD has no path to gate the deliverable on what the user perceives.
