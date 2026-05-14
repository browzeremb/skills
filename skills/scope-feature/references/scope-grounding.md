# Browzer grounding — scope-feature

The grounding posture for scoping is **different from generate-prd**. generate-prd already established the WHAT (personas, FRs, ACs). scope-feature's job is to translate WHAT into WHERE (files, domain buckets, blast radius, installed skills). The cheapest command per question changes.

## Decision tree

| Question | Command |
|---|---|
| "Which files implement this FR's domain?" | `browzer explore` — semantic search over code |
| "What docs constrain this behavior?" | `browzer search` — vector search over markdown docs |
| "What does this file import?" | `browzer deps <path>` |
| "What imports this file?" (blast) | `browzer deps <path> --reverse` |

## Resolving ambiguous clusters

When `browzer explore` returns scattered hits across multiple buckets
and the FR text alone doesn't disambiguate, refine the query rather
than reach for a different command. Two cheap moves usually work:

1. **Narrow the noun.** Replace a generic term ("config") with the
   concrete surface implied by the FR ("api-key-auth config",
   "rate-limit config"). Re-run `browzer explore` with the sharper
   query.
2. **Anchor with a doc.** Run `browzer search "<topic>"` against the
   markdown index — an ADR or runbook usually names the canonical
   owning bucket, which collapses the ambiguity.

If both moves still leave the file's bucket genuinely ambiguous, list
the candidate buckets in `assumptions[]` and pick the longest-prefix
match per the rules below. Surfacing the ambiguity is better than
forcing a confident-looking guess.

## How to query per FR

For every `functionalRequirements[].text`:

1. Extract the most concrete noun phrase (e.g. "upload PDF file", "browzer explore command", "Neo4j vector index"). Vague nouns ("the system", "data") return scattered hits — refine before querying.
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

Examples below use placeholder names (`<api-app>`, `<api-pkg>`, etc.) —
the rule is path-prefix-based, so it applies to whatever layout the host
repo uses.

| File path | Bucket |
|---|---|
| `<api-app>/src/foo.ts` (under any `apps/<X>/`, `services/<X>/`, or top-level service folder) | `<api-app>` |
| `<web-app>/src/components/Foo.tsx` (UI framework files) | `<web-app>` |
| `<api-pkg>/src/bar.ts` (under any `packages/<X>/`, `libs/<X>/`, `modules/<X>/`, `crates/<X>/`) | `<api-pkg>` |
| `<cli-pkg>/cmd/explore/main.go` (binary entrypoint) | `<cli-pkg>` |
| `<cli-pkg>/scripts/sync.mjs` (script under the package — still that package's bucket) | `<cli-pkg>` |
| `docs/architecture/Foo.md` | `docs` |
| `monitoring/grafana/dashboards/billing.json` | `infra` |
| `Dockerfile` (repo root) | `infra` |
| `lefthook.yml` / `.github/workflows/ci.yml` (repo root) | `infra` |

When a file matches no prefix, default to `infra`. A file in two buckets
is a bug — recheck longest-prefix logic and consult
`.browzer/sensitive-paths.json` (or `.claude/sensitive-paths.json` in
plugin-distribution layout) for operator-defined buckets.

## Discipline summary

- Prefer `explore` for "where" questions; refine the query (narrower noun, doc anchor via `search`) when hits scatter across buckets.
- Save every query receipt to `/tmp/scope-*.json` — useful for debugging and operator audit; raw receipts stay in `/tmp/` (gitignored by the OS).
- Bucket by path prefix; don't invent custom buckets.
- A file in two buckets is always a bug.
- Stale hits (path doesn't exist on disk) are silently filtered — they indicate the index is stale and the preflight `assumptions[]` entry should have flagged it already.
