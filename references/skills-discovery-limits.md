# find-skills — discovery limits, cross-cutting tags, expected zero-match cases

`find-skills` (interactive and programmatic) queries the skills.sh
marketplace + locally-installed skills under `.claude/skills/`,
`.claude/plugins/`, and `~/.claude/skills/`. Some domains are
under-represented; expect zero matches and proceed without escalation.
Other matches are silently missed because the scoper queries only
**library / framework names** (e.g. "fastify", "neo4j") and never the
**cross-cutting concerns** the diff actually exercises (performance,
race conditions, hooks). This file codifies both.

## Language-and-subsystem tag mapping (probe before library queries)

The scoper's `find-skills` query set MUST start with **language and
subsystem tags derived from the changed file set**, not just
library/framework names. Library-name queries miss domain skills the
diff actually exercises (e.g. a Go CLI refactor surfaces zero hits
for `cobra` if the scoper only queries `browzer`). Probe these tags
before any library query.

| Changed file signal | Probe these tags (in order) |
|---|---|
| `**/*.go` files in scope | `go`, `golang`, `go-best-practices` |
| `**/*.py` files in scope | `python`, `py-best-practices` |
| `**/*.rs` files in scope | `rust`, `rust-best-practices` |
| `**/*.ts` / `**/*.tsx` files in scope | `typescript`, `ts-best-practices` |
| `**/*.jsx` / `**/*.tsx` files in scope | `react`, `react-performance`, `accessibility-a11y` |
| `apps/**/server.ts`, `apps/**/app.ts`, `*.fastify.ts` patterns | `fastify`, `nodejs-backend-patterns` |
| Cobra-shaped Go (`cmd/`, `RootCmd`, `cobra.Command`) | `cli`, `cobra`, `command-tree` |
| SQL or `db/queries/*.sql` | `sql`, `<engine>`, `query-builder` (engine via `package.json` / `go.mod`) |
| `monitoring/`, Grafana JSON dashboards | `grafana-dashboards`, `slo-panels`, `observability` |
| Hook files (`hooks/**/*.mjs`, `hooks.json`) | `claude-code-hooks` |
| Test files (`*.test.*`, `__tests__/`, `spec/`) | `test-strategy`, `mutation-testing`, `playwright-generate-test` |
| Migration files (`migrations/`, `*.sql.up`, `*.sql.down`) | `database-migrations`, `sql`, `<engine>` |
| Kubernetes / Helm (`*.yaml` under `k8s/`, `helm/`) | `kubernetes`, `helm`, `infra` |
| Dockerfile or `compose.yaml` | `docker-expert`, `containerization` |
| Auth code (`auth/`, `*.session.*`, `*.api-key.*`) | `auth-sec`, `email-and-password-best-practices`, `two-factor-authentication-best-practices`, `owasp-security-review` |

When the file extension or path pattern does not match any row above,
record the gap in `assumptions[]`. The mapping above is the agnostic
contract the plugin ships with; host projects may extend it via
`.browzer/skills.config.json#findSkills.tagMap` (host extension, never
mirrored back to the plugin tag library).

The dispatcher merges the tag-probe results with library-name results
and the cross-cutting concern tags (next section) before computing
`relevance`. A skill matched by ≥2 distinct probes (e.g. language tag +
concern tag) bumps to `relevance: high` automatically.

## Cross-cutting concern tags — query alongside library names

`scope-feature` MUST broaden its `find-skills` query set beyond
library/framework names. For each domain bucket, additionally probe
the **concern tags** below. Cross-cutting skills (`performance-hunter`,
`race-condition`, `simplify`, `claude-code-hooks`) get no signal from a
library-name query and silently fail discovery despite being highly
relevant.

| Tag | When to probe | Skills typically surfaced |
|---|---|---|
| `performance` | bucket touches hot-path code, loops over collections, fan-out / fan-in I/O, or N+1 query suspects | `performance-hunter`, `react-performance`, `vercel-react-best-practices` |
| `race-condition` | bucket touches concurrent code: parallel agent dispatch, BullMQ consumers, pub/sub, transactions, locks | `race-condition`, `redis-specialist`, `bullmq-specialist` |
| `hooks` | bucket touches Claude Code lifecycle hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`, `SubagentStop`) | `claude-code-hooks` |
| `accessibility` | bucket touches UI (any `.tsx`, `.jsx`, `.svelte`, `.vue` under an app frontend) | `accessibility-a11y` |
| `security` | bucket touches auth, credentials, secrets, RBAC, sensitive paths | `auth-sec`, `owasp-security-review`, `better-auth-security-best-practices`, `business-logic-vulnerabilities` |
| `prompt-engineering` | bucket touches LLM call-sites, prompts, agent dispatch, MCP servers | `claude-prompt-engineering`, `claude-api`, `claude-code-guide` |
| `simplification` | bucket touches code marked for refactor or cleanup, or PR scope >10 files | `simplify`, `vercel-composition-patterns` |
| `test-strategy` | bucket touches test files, fixtures, mocks, snapshots, mutation testing setup | `testing-strategies`, `playwright-generate-test` |

**Tag-query protocol** — for each tag whose criterion matches the
bucket, run `find-skills <tag>` in programmatic mode and merge the
result into `domains[].skillsFound[]`. The resulting `installed[]`
entries get `relevance: medium` by default (cross-cutting skills rarely
align as tightly as library matches); the scoper may bump to `high`
when the bucket's diff explicitly exercises the concern (e.g.
`race-condition` for a file containing `Promise.all`, `Lock`, `Mutex`,
`pubsub`, `transaction`).

## Known under-represented domains (zero-match is acceptable)

| Domain | Common queries that miss | Recommended fallback |
|---|---|---|
| Infrastructure metrics | `prometheus`, `prom`, `metrics-counter`, `observability` | `browzer search "<query>"` + Read `metrics.ts` / dashboard JSON |
| Custom Grafana dashboards | `grafana-dashboards`, `slo-panels` | Treat as plain JSON edits; manual review of panel shape |
| Internal RAG operations | `rag-quota`, `vector-cache-invalidation` | `browzer search` + repo CLAUDE.md |
| Per-org workflow primitives | `outbox-pattern`, `usage-debit-atomic` | `browzer explore` for prior art |
| Niche language toolchains | `cue-schemas`, `goyacc`, `gomut` | Direct Read of the schema or generator |

## When a zero-match is a contract violation

`find-skills` should still surface common ecosystem skills. A zero-match
result for any of these is a bug worth filing:

- `fastify-best-practices` for any Fastify route work
- `react-performance`, `nextjs-app-router`, `react-query` for any
  Next.js / React work
- `neo4j-cypher` for any Cypher / graph traversal work
- `claude-prompt-engineering`, `claude-api` for any Anthropic SDK work
- `accessibility-a11y` for any UI work
- `claude-code-hooks` for any hook-file work (see tag-query protocol
  above)

If one of these returns zero, the marketplace state is degraded; record
the gap in the feature's `assumptions[]` rather than the
skills-discovery-limits taxonomy.

## Programmatic-mode contract (mandatory for scope-feature)

`scope-feature` invokes `find-skills` in programmatic mode for every
domain bucket AND every applicable concern tag. The contract:

- The output JSON's top-level key for installed skills is **`installed`**
  — never `matched_installed_skills`, `skills`, `results`, or any other
  variant. Skills that read a different key silently see an empty list
  and degrade to zero-skill dispatch.
- The scoper writes `findSkillsRan: true` to `EXPLORATION.md`
  frontmatter on every invocation (even when zero results came back),
  so downstream consumers can distinguish *"find-skills returned zero"*
  from *"find-skills was never called"*. The latter is a bug; the
  former is a valid signal.
- For every entry returned, verify `installedAt` exists on disk before
  keeping it in `skillsFound[]`. Stale marketplace entries that no
  longer resolve locally are dropped + recorded in `assumptions[]`.

## Reference

Programmatic mode of `find-skills` is described in
`${CLAUDE_PLUGIN_ROOT}/skills/find-skills/SKILL.md §0`. The canonical
list of installed skills lives under `~/.claude/skills/` and
`.claude/plugins/cache/<org>/<plugin>/<version>/skills/`.
