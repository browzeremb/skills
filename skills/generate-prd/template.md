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

  Example feature used below: "Add per-tenant rate limit to HTTP API".
  Paths in angle brackets (`<api-app>`, `<api-pkg>`, etc.) are PLACEHOLDERS —
  substitute your host repo's actual app/package name. The example assumes
  a typical TypeScript/Node monorepo but the shape is language-agnostic.
-->

# PRD template

## Frontmatter

```yaml
# REQUIRED — Stable feature identifier matching the parent folder name.
# Pattern: ^feat-[0-9]{8}-[a-z0-9-]+$
featureId: feat-20260512-api-rate-limit

# REQUIRED — Human-readable feature label. Minimum 3 chars.
title: "Add per-tenant rate limit to HTTP API"

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
  The HTTP API has no per-tenant throttling today, so a single abusive
  tenant can saturate the request loop and degrade latency for every
  other tenant. Add middleware that tracks request counts per tenant
  (resolved from the existing auth context) and rejects with 429 once a
  configured per-window cap is exceeded. Emit standard `X-RateLimit-*`
  headers on every response so downstream SDKs can back off proactively.

# REQUIRED — At least 1 persona. Personas MUST be real users of this repo,
# verified via `browzer search` or `browzer explore`. Inventing personas is
# a contract violation.
personas:
  - id: P-01                                  # Pattern: ^P-[0-9]+$
    description: |
      Platform operators who run the API service. They need a defensive
      throttle to keep one runaway tenant from starving the rest of the
      tenancy.

  - id: P-02
    description: |
      API consumers (downstream apps and SDKs). They need a predictable
      429 + `Retry-After` signal so their client libraries can back off
      gracefully instead of retry-storming.

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
  diagramTitle: "Per-tenant rate limit on HTTP API"

  # REQUIRED — At least 1 story.
  stories:
    - id: US-01                               # Pattern: ^US-[0-9]+$
      persona: P-01                           # Refs personas[].id
      wants: "the API to enforce a per-tenant request cap so one tenant cannot starve others"
      benefit: "so platform availability stays predictable under abusive load"
      bindsAcceptance: [AC-01, AC-03]         # Refs acceptanceCriteria[].id
      # OPTIONAL — Ordered journey steps. Used when diagramType=journey to
      # produce richer mermaid output. Ignored for other diagram types.
      journeySteps:
        - step: "Tenant T sends request #N+1 within the window"
          sentiment: 1                         # Integer 0–5; 0=friction, 5=delight
          actors: [Tenant, API]
        - step: "Middleware reads tenant id from auth context"
          sentiment: 5
          actors: [API]
        - step: "Counter exceeded → respond 429 with Retry-After"
          sentiment: 5
          actors: [API]

    - id: US-02
      persona: P-02
      wants: "a 429 response with `Retry-After` when throttled"
      benefit: "so my SDK can back off without hammering the API"
      bindsAcceptance: [AC-02]
      journeySteps:
        - step: "SDK sends request that exceeds tenant cap"
          sentiment: 2
          actors: [SDK, API]
        - step: "Receive 429 + Retry-After: 30"
          sentiment: 4
          actors: [SDK]
        - step: "Sleep and resume after Retry-After"
          sentiment: 5
          actors: [SDK]

# OPTIONAL — Outcome-level goals (1–5 bullets). Outcome, not output.
# Good: "Reduce p95 API latency under abusive tenants by 50%".
# Bad:  "Add rate-limit middleware" (that's a deliverable, not an objective).
objectives:
  - "Bound the latency impact one tenant can have on the rest of the tenancy"
  - "Surface throttling signals so SDKs can self-regulate"

# OPTIONAL — Concrete paths, capabilities, or surfaces touched.
# Prefer specific paths over vague descriptions. Angle-bracketed names are
# placeholders — substitute your host repo's actual app/package name.
inScope:
  - "<api-app>/src/middleware/rate-limit.ts — new middleware"
  - "<api-app>/src/server.ts — wire middleware into the request chain"
  - "<api-app>/README.md — document the rate-limit headers"

# OPTIONAL — Explicit non-goals. Prevents scope creep downstream.
outOfScope:
  - "Distributed rate-limit shared across API instances (Redis-backed) — separate feature"
  - "Per-endpoint sub-quotas"

# OPTIONAL — Tangible artifacts produced (distinct from inScope).
# inScope = areas touched. deliverables = outputs produced.
deliverables:
  - "New rate-limit middleware module"
  - "Rate-limit response headers documented in the API README"

# REQUIRED — At least 1 FR. Each FR is the unit generate-task groups tasks
# around. Every FR MUST be referenced by ≥1 acceptanceCriteria[].bindsTo.
functionalRequirements:
  - id: FR-01                                 # Pattern: ^FR-[0-9]+$
    text: |
      HTTP middleware enforces a per-tenant cap of N requests per window
      (tenant id resolved from the existing auth context).
    priority: must                            # Enum: must | should | could

  - id: FR-02
    text: |
      When a tenant exceeds its cap, the API returns HTTP 429 with a
      `Retry-After` header carrying the remaining seconds until the
      window resets.
    priority: must

  - id: FR-03
    text: |
      Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`
      headers reflecting the tenant's current state.
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
      Given an authenticated tenant T with cap N, when T sends N+1
      requests within the active window, then the (N+1)th response is
      HTTP 429.
    bindsTo: [FR-01, FR-02]                   # ≥1 FR-NN; refs functionalRequirements[].id
    verification:
      kind: http-probe
      requires: [http]
      commands:
        - run: |
            ./<scripts-dir>/probe-rate-limit.sh --tenant=T --cap=N
          expect: contains:"429"
          timeout: 30
      failure-mode: pre-commit

  - id: AC-02
    text: |
      Given AC-01's 429 response, then the response carries a
      `Retry-After` header whose value is a positive integer (seconds).
    bindsTo: [FR-02]
    verification:
      kind: http-probe
      requires: [http]
      commands:
        - run: |
            ./<scripts-dir>/probe-rate-limit.sh --tenant=T --cap=N --extract-header=Retry-After
          expect: 'regex:"^[1-9][0-9]*$"'
          timeout: 30
      failure-mode: pre-commit

  - id: AC-03
    text: |
      Given any authenticated request, then the response carries
      `X-RateLimit-Limit` AND `X-RateLimit-Remaining` headers, both
      non-negative integers.
    bindsTo: [FR-03]
    verification:
      kind: http-probe
      requires: [http]
      commands:
        - run: |
            ./<scripts-dir>/probe-rate-limit.sh --tenant=T --headers-only
          expect: contains:"X-RateLimit-Limit"
          timeout: 30
      failure-mode: pre-commit

# OPTIONAL — Constraints (performance, security, observability, a11y).
# `target` MUST be measurable. Vague targets ("must be performant", "should
# be reliable") are anti-patterns. Be concrete or omit the NFR.
nonFunctionalRequirements:
  - id: NFR-01                                # Pattern: ^NFR-[0-9]+$
    category: performance
    target: "Middleware p95 overhead ≤ 2ms vs. baseline request latency"
    # OPTIONAL — When true, feature-acceptance runs `target` as a shell command.
    runnable: false

  - id: NFR-02
    category: observability
    text: "Counter emitted for accept/reject decisions"
    target: "metric `api_rate_limit_decisions_total{outcome=allow|deny}` increments per request"
    runnable: false

# OPTIONAL — Post-launch signals. Not verified by feature-acceptance.
successMetrics:
  - id: M-01                                  # Pattern: ^M-[0-9]+$
    metric: "p95 API latency under a synthetic abusive-tenant load"
    target: "≤ 110% of baseline (vs. ≥ 300% without rate limiting)"
    method: "Load test in CI, 7-day rolling"

# OPTIONAL — Known threats. Each MUST have a mitigation.
risks:
  - id: R-01                                  # Pattern: ^R-[0-9]+$
    text: "Misconfigured cap throttles legitimate tenants"
    mitigation: |
      Ship with a generous default cap and a per-tenant override. Emit a
      counter for denials so operators can tune the cap by tenant.

# OPTIONAL — Internal/external dependencies for parallelizability detection.
dependencies:
  internal:
    - "<api-app>/src/auth/context.ts"
  external: []

# OPTIONAL — Things the PRD takes for granted. Also the home for:
#   (1) search-trigger expansion proposals (see references/search-trigger-proposal.md)
#   (2) index-staleness disclaimers when the preflight detected stale data
assumptions:
  - |
    Tenant id is already available on the request via the existing auth
    middleware; this feature consumes it, does not introduce it.
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
| `featureId` | `^feat-[0-9]{8}-[a-z0-9-]+$` | `feat-20260512-api-rate-limit` |
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
