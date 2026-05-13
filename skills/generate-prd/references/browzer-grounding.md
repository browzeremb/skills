# Browzer grounding — when to use which command

Authoring a PRD requires grounding in actual repo context. Pick the cheapest command that answers the question.

## Decision tree

| Question kind | Command |
| --- | --- |
| "How does X work today in this repo?" | `browzer ask` |
| "What services/packages handle Y?" | `browzer ask` |
| "Is there an ADR or design doc about Z?" | `browzer search` |
| "Where is symbol `Foo` defined?" | `browzer explore` |
| "What does `bar.go` do?" | `browzer explore` |
| "What imports this file?" (blast radius) | not PRD scope (generate-task's job) |
| "Is the index fresh?" | `browzer workspace status` |

## `browzer ask` — high signal for PM work

`browzer ask` synthesizes a natural-language answer from the hybrid RAG (vector + graph + reranker). It is the highest-signal command for PM grounding because it returns **prose answers** instead of file dumps.

**Required minimum**: ≥2 `ask` calls before authoring the PRD. Cover two axes:

1. **Existing architecture** for the feature's domain — "how does X work today?"
2. **Scope/dependencies** of the feature — "which services would Y touch?"

Save each receipt:

```bash
browzer ask "..." --save /tmp/prd-ask-<slug>.json
```

Run 3–5 calls when the input touches multiple subsystems. Run more when the feature spans services you have low prior knowledge of.

### Good `ask` patterns

- "How does authentication flow through the gateway into the API?"
- "What packages depend on `@browzer/queue`?"
- "Is there existing tracing instrumentation for the search pipeline?"
- "Where does daily-spend reconciliation run today?"

### Anti-patterns

- "What files exist?" — too broad, returns nothing useful
- "Explain the codebase" — no PM-actionable signal
- "Is this feature good?" — `ask` is for facts, not opinions

## `browzer search` — for ADRs, runbooks, prose docs

Indexed by `browzer workspace docs`. Use to find:

- Architectural decisions (ADRs) that constrain the PRD
- Runbooks or operational docs that mention the domain
- Prior PRDs in `docs/browzer/` worth referencing or contrasting

Run for every domain noun in the input. Save:

```bash
browzer search "<noun>" --save /tmp/prd-search-<slug>.json
```

Search returns a ranked list of matched markdown chunks with paths and scores. Skim the top 3–5 hits; they reveal whether prior thinking already covers your scope.

## `browzer explore` — for symbol verification

Use when the input names a specific file, function, or package that needs to exist before claiming it as scope.

Example: input says "add caching to the search endpoint" — run `browzer explore "search endpoint"` to confirm the file path that defines it. Use the result to populate `inScope[]` with a concrete path instead of a vague capability name.

Don't run `explore` for every domain noun — `search` is usually enough. Use `explore` when:

- The input claims a specific file/symbol exists and you must verify
- The PRD's `inScope[]` should list exact file paths
- A `dependencies.internal[]` entry references a file that must be confirmed

Save:

```bash
browzer explore "<symbol or path>" --save /tmp/prd-explore-<slug>.json
```

## Preflight — workspace status

Run once at the start:

```bash
browzer workspace status --json --save /tmp/prd-status-<featureId>.json
```

If `staleness` is not `fresh`, append to `assumptions[]`:

> Browzer index may be stale; PRD reflects index snapshot from `<date>`.

A stale index means PRDs grounded in it may cite paths/symbols that no longer exist or miss surfaces that landed since the last sync. The assumption flags this for downstream skills and the operator.

## Discipline summary

- **Always** run `workspace status` preflight first.
- **Always** run ≥2 `browzer ask` calls before writing FR/AC.
- **Save** every query — receipts are aggregated into `RECEIPTS.md` for audit.
- **Prefer** `ask` for "how does X work" questions; **prefer** `search` for "is there a doc on X" questions; **prefer** `explore` for "does this specific symbol/file exist" questions.
- **Never** ground a PRD in training data when `browzer` can answer the question.
