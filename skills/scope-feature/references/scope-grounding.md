# Browzer grounding — scope-feature

The grounding posture for scoping is **different from generate-prd**. generate-prd already established the WHAT (personas, FRs, ACs). scope-feature's job is to translate WHAT into WHERE (files, domain buckets, blast radius, installed skills). The cheapest command per question changes.

## Decision tree

| Question | Command |
|---|---|
| "Which files implement this FR's domain?" | `browzer explore` — semantic search over code |
| "What docs constrain this behavior?" | `browzer search` — vector search over markdown docs |
| "What does this file import?" | `browzer deps <path>` |
| "What imports this file?" (blast) | `browzer deps <path> --reverse` |
| "Are these two scattered files part of the same domain?" | `browzer ask` — only when explore returns ambiguous clusters |

## When NOT to use `ask`

Unlike generate-prd, `ask` synthesizes prose and is slow. Bad fit for file location — the answer is "which files," not "explain the architecture." Use `explore` first.

Reserve `ask` for true ambiguity: when explore returns scattered hits across multiple buckets and the FR text alone doesn't disambiguate. Cap at 2–3 `ask` calls per scope-feature run.

Good `ask` examples in scoping context:

- "Does the file that handles X belong to the API surface or the worker?"
- "Is this orchestration logic in the apps/api layer or in packages/core?"

Anti-patterns:

- "What does this file do?" → use `explore` and read the result
- "How should I scope this feature?" → that's the skill's whole job, not a grounding question

## How to query per FR

For every `functionalRequirements[].text`:

1. Extract the most concrete noun phrase (e.g. "upload PDF file", "browzer ask command", "Neo4j vector index"). Vague nouns ("the system", "data") return scattered hits — refine before querying.
2. Run `browzer explore "<noun>" --json --save /tmp/scope-explore-<slug>.json`.
3. Parse the result; group hits by path prefix (bucket inference, see below).
4. For each unique file across hits, run `browzer deps` forward + `--reverse`.

For multi-noun FRs ("Webhook calls API which writes to Postgres"), run one `explore` per noun. The clustered buckets are the expected outcome — a single FR can span 2–3 buckets.

## Filtering hits

`browzer explore` returns mixed result types. Filter during bucket assignment:

- **Keep** `type: code` hits with `score >= 0.5`.
- **Keep separately** test files (regex `__tests__|\.test\.|\.spec\.|_test\.go|_spec\.rb`). They live in blast radius as `reverse` entries, not in `likelyFiles[]` — unless an FR explicitly mentions tests.
- **Drop** `type: doc` from `likelyFiles[]` — docs are the `docs` bucket, not a code domain.
- **Drop** fixtures (`fixtures/**`, `*.fixture.*`), generated files (`*.gen.*`, `*.pb.go`), and vendor (`vendor/**`).

## Bucket assignment — longest-prefix match

A file belongs to exactly one bucket. Use longest-prefix path matching.

| File path | Bucket |
|---|---|
| `apps/api/src/foo.ts` | `apps/api` |
| `apps/web/src/components/Foo.tsx` | `apps/web` |
| `packages/core/src/bar.ts` | `packages/core` |
| `packages/cli/internal/commands/ask.go` | `packages/cli` |
| `packages/cli/scripts/sync.mjs` | `packages/cli` (script under cli — still cli bucket) |
| `docs/architecture/Foo.md` | `docs` |
| `monitoring/grafana/dashboards/billing.json` | `infra` |
| `Dockerfile` (repo root) | `infra` |
| `lefthook.yml` (repo root) | `infra` |

When a file matches no prefix, default to `infra`. A file in two buckets is a bug — recheck longest-prefix logic and consult `.browzer/sensitive-paths.json` for operator-defined buckets.

## Discipline summary

- Prefer `explore` for "where" questions; reserve `ask` for true ambiguity (≤ 3 calls).
- Save every query receipt to `/tmp/scope-*.json` — the append-receipts script aggregates them.
- Bucket by path prefix; don't invent custom buckets.
- A file in two buckets is always a bug.
- Stale hits (path doesn't exist on disk) are silently filtered — they indicate the index is stale and the preflight `assumptions[]` entry should have flagged it already.
