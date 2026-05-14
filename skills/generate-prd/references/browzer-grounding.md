# Browzer grounding — when to use which command

Authoring a PRD requires grounding in actual repo context. The two
mandatory grounding surfaces are `browzer search` (vector search over
indexed markdown — ADRs, runbooks, prior PRDs) and `browzer explore`
(hybrid graph + vector search over indexed code — files, symbols,
snippets). Pick the cheapest command that answers the question.

## Decision tree

| Question kind | Command |
| --- | --- |
| "Is there an ADR or design doc about Z?" | `browzer search` |
| "What patterns / conventions does this repo follow for Y?" | `browzer search` |
| "How does X work today in this repo?" | `browzer search` for the docs + `browzer explore` for the code |
| "What services/packages handle Y?" | `browzer explore` |
| "Where is symbol `Foo` defined?" | `browzer explore` |
| "What does `bar.go` do?" | `browzer explore` |
| "What imports this file?" (blast radius) | not PRD scope (generate-task's job, via `browzer deps --reverse`) |
| "Is the index fresh?" | `browzer workspace status` |

## Required minimum

Before authoring any FR or AC, run **≥1 `browzer search` AND ≥1 `browzer
explore` call** covering two distinct axes:

1. **Existing architecture** for the feature's domain — search for ADRs
   / design docs / prior PRDs that describe how the area works today;
   explore for the entry-point files and symbols you'd cite as scope.
2. **Scope and dependencies** — explore for the concrete files the
   feature would touch; search for runbooks or constraints that gate
   the change (security, billing, tenancy invariants).

Run 3–5 search calls and 3–5 explore calls when the input touches
multiple subsystems. Run more when the feature spans services you have
low prior knowledge of.

## `browzer search` — for ADRs, runbooks, prose docs

Indexed by `browzer workspace docs`. Use to find:

- Architectural decisions (ADRs) that constrain the PRD
- Runbooks or operational docs that mention the domain
- Prior PRDs in `docs/browzer/` worth referencing or contrasting
- Convention/pattern guides that limit how the feature can be built

Save:

```bash
browzer search "<topic or noun>" --json --save /tmp/prd-search-<slug>.json
```

Search returns a ranked list of matched markdown chunks with paths and
scores. Skim the top 3–5 hits; they reveal whether prior thinking
already covers your scope.

### Good `search` patterns

- "tenant scoping invariants for graph store"
- "Langfuse tracing on the search pipeline"
- "daily-spend reconciliation runbook"
- "device-flow approval design"

### Anti-patterns

- "What files exist?" — search is for docs, not file enumeration. Use
  `explore` to enumerate code.
- "Explain the codebase" — too broad; no usable signal for FR/AC.

## `browzer explore` — for code surfaces and symbols

Hybrid graph + vector search over indexed source. Use to:

- Verify a specific file, function, or package exists before claiming
  it as scope
- Resolve a vague domain noun ("the search endpoint") into a concrete
  repo-relative path (e.g. `<api-app>/src/routes/search.ts` —
  substitute your host's actual app folder)
- Find which files implement a behavior the PRD wants to extend

Save:

```bash
browzer explore "<symbol or capability>" --json --save /tmp/prd-explore-<slug>.json
```

Use `explore` proactively — it is the cheapest way to populate
`inScope[]` with real paths instead of vague capabilities.

### Good `explore` patterns

- "JWT verification middleware"
- "outbox consumer"
- "rerank ranker invocation site"
- "device approval handler"

### Anti-patterns

- "Should this feature exist?" — `explore` is for facts about code, not
  opinions.
- "What's the best way to add Y?" — design questions belong in the PRD
  authoring step, not the grounding step.

## Preflight — workspace status

Run once at the start:

```bash
browzer workspace status --json --save /tmp/prd-status-<featureId>.json
```

If `staleness` is not `fresh`, append to `assumptions[]`:

> Browzer index may be stale; PRD reflects index snapshot from `<date>`.

A stale index means PRDs grounded in it may cite paths/symbols that no
longer exist or miss surfaces that landed since the last sync. The
assumption flags this for downstream skills and the operator.

## Discipline summary

- **Always** run `workspace status` preflight first.
- **Always** run ≥1 `browzer search` AND ≥1 `browzer explore` before
  writing FR/AC. Together they cover both the doc-level "what
  constrains this?" and the code-level "where does it live?".
- **Save** every query — receipts feed `prdReceipts[]` in PRD
  frontmatter so `scope-feature` can skip already-covered surfaces.
  Raw JSON stays in `/tmp/` (gitignored by the OS) for operator audit.
- **Prefer** `search` for "is there a doc / ADR / runbook about X" and
  "what patterns does this repo follow"; **prefer** `explore` for
  "where is X implemented", "what calls Y", "does this specific symbol
  exist".
- **Never** ground a PRD in training data when `browzer` can answer the
  question.
