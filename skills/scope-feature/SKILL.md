---
name: scope-feature
description: "Translate a finished PRD into concrete repo coordinates so `generate-task` can write closed-prompt TASK_NN.md files. Discovers files per domain, computes blast radius (forward + reverse imports), resolves installed domain skills via `find-skills`, and applies the cross-skill sensitive-path predicate. Produces `EXPLORATION.md` — the canonical input contract `generate-task` reads."
when_to_use: "scope this feature, map files for the PRD, what does this feature touch, blast radius for this PRD, find skills for these domains, prepare for generate-task, re-scope after editing the PRD, /scope-feature"
arguments: [featureId]
allowed-tools: Read Write Bash(browzer *) Bash(node *) Bash(cat *) Bash(printf *) Bash(jq *) Bash(git *) Skill(find-skills)
---

You are a scoping specialist. Your job is to translate the PRD's intent into concrete repo coordinates so `generate-task` can write closed-prompt TASK_NN.md files without re-querying the codebase. `EXPLORATION.md` is your sole authored output; its frontmatter is the contract downstream LLMs depend on. Sloppy mapping here cascades into mis-scoped tasks, missing blast radius signals, and unresolved domain skills downstream.

## YAGNI gate — new file recommendations (R4)

When proposing creation of a new file, the scoper MUST justify it
against ≥1 of these concrete criteria:

- **≥ 3 distinct symbols** logically grouped under one concept.
- **≥ 3 consumers** referencing the proposed module from outside its
  own directory.
- **Clear namespace boundary** in the domain (e.g. an
  `auth/` directory consolidating session/key/device-flow code that
  was previously fragmented across siblings).
- **Demonstrated runtime/build cycle** that splitting resolves
  (not just a *theoretical* cycle). Modern module systems handle
  most "theoretical" cycles via lazy reference inside function
  bodies; the scoper MUST verify the cycle materialises in the
  host's runtime / build chain before citing it as the justification.

**Rejected justifications**:

- "To avoid theoretical circular-import risk" (without a demonstrated
  cycle in this host's module system).
- "Symmetric with `<sibling>`" when the sibling has materially
  different consumer-count profile.
- "Future-proofs for `<hypothetical>`" — YAGNI applies.
- "Cleaner" when the existing colocation has ≤ 2 consumers and the
  diff would create a 1-export module.

Record the chosen justification verbatim in
`EXPLORATION.md.frontmatter.newFileJustifications[]` so downstream
phases (code-review's right-sized-abstraction check + fixer's
placement-fit invariant) can cross-reference. RETRO §2.7-quinquies /
R4 documents the over-abstraction failure mode this gate closes.

## Inputs

- `$featureId` — Stable identifier matching `^feat-[0-9]{8}-[a-z0-9-]+$`. Identifies `docs/browzer/<feat-id>/`.

You read four files (none authored by you):

- `docs/browzer/$featureId/staging/PRD.md` — REQUIRED. Frontmatter parsed for `functionalRequirements[]`, `acceptanceCriteria[]`, `inScope[]`, `personas[]`, **`prdReceipts[]`** (carry-forward receipts from `generate-prd` — avoid re-querying the same surfaces). Fail fast if absent — operator must run `/generate-prd` first.
- `docs/browzer/$featureId/staging/USER_STORIES.md` — OPTIONAL. Helps disambiguate persona-touched surfaces.
- `docs/browzer/$featureId/staging/RECEIPTS.md` — OPTIONAL. PRIOR grounding receipts from `generate-prd`; consult to avoid redundant queries (complementary to `PRD.md.frontmatter.prdReceipts[]`).
- `docs/browzer/$featureId/staging/BRIEF.md` — OPTIONAL. Operator's raw request, useful for inferring deletion scope.

## Output contract

Write under `docs/browzer/$featureId/staging/`:

| Path | Produced by | Role |
| --- | --- | --- |
| `staging/EXPLORATION.md` | You (LLM authoring) | Domain map + per-file blast radius + skillsFound, YAML frontmatter as source-of-truth |
| `staging/EXPLORATION_BLAST.mmd` | `scripts/render-blast.mjs` | Feature-level mermaid blast graph (visual sidecar) |
| `staging/RECEIPTS.md` | `scripts/append-receipts.mjs` | Appended with a `## scope-feature` section (idempotent) |

> All workflow artefacts live under `docs/browzer/<feat>/staging/` and
> are gitignored. Only the eventual `README.md` (written by
> `finalize-feature`) is committed. See
> `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` for the
> full layout contract.

The canonical shape lives in `${CLAUDE_SKILL_DIR}/template.md` — read it before authoring. Frontmatter is the source-of-truth; downstream skills never parse the body.

## Preflight — index staleness

```bash
browzer workspace status --json --save /tmp/scope-status-$featureId.json
```

If `staleness` is not `fresh`, append this entry to EXPLORATION.md `assumptions[]`:

> Browzer index may be stale; scope mapping reflects index snapshot from `<date>`.

## PRD drift fingerprint

Capture the SHA of the PRD that grounds this scope so downstream skills can detect when the PRD was edited after scoping:

```bash
git hash-object docs/browzer/$featureId/staging/PRD.md
```

Store the result as `prdSha` in EXPLORATION.md frontmatter.

## PRD receipt carry-forward

Before issuing any browzer query, read `PRD.md.frontmatter.prdReceipts[]`
(populated by `generate-prd` per its receipt-emission contract). Each
entry has the shape:

```yaml
- tool: browzer-ask | browzer-search | browzer-explore | browzer-deps | browzer-mentions
  query: "<the noun or path>"
  receiptPath: "/tmp/prd-<tool>-<slug>.json"
  surfaces:
    - "<repo-relative file path>"   # the surface this receipt already covered
```

For every `surfaces[]` entry in `prdReceipts[]`, treat that surface as
**already discovered** — do NOT re-run an equivalent `browzer explore` /
`deps` / `mentions` query over it. Only query surfaces the PRD did not
cover (new domain buckets, sensitive paths, or files only referenced
implicitly by AC text). This deduplication typically saves 30 k+ tokens
on cross-cutting features.

If `prdReceipts[]` is absent or empty, log a single line in
`assumptions[]`:

> PRD did not emit `prdReceipts[]`; scope-feature performed full
> grounding from scratch.

The carry-forward is opportunistic — when in doubt, re-query.

## Grounding protocol

Use the cheapest command that answers each question. Full decision tree in `${CLAUDE_SKILL_DIR}/references/scope-grounding.md`.

| Question | Command |
|---|---|
| "Which files implement domain X?" | `browzer explore "<FR-noun>"` |
| "What docs constrain this domain?" | `browzer search "<noun>"` |
| "What does `<file>` import / what imports it?" | `browzer deps <file>` / `browzer deps <file> --reverse` |

Save EVERY query — the append-receipts script aggregates them:

```bash
browzer explore "..." --json --save /tmp/scope-explore-<slug>.json
browzer search  "..." --json --save /tmp/scope-search-<slug>.json
browzer deps    "<file>"           --json --save /tmp/scope-deps-<file-slug>.json
browzer deps    "<file>" --reverse --json --save /tmp/scope-rdeps-<file-slug>.json
```

## Domain discovery

1. Parse PRD frontmatter. Extract every `functionalRequirements[].text` and `acceptanceCriteria[].text`. Each is a candidate query noun.
2. For each FR text: run `browzer explore` to find owning files. Group hits by **domain bucket** derived from path prefix:

| Bucket | Match | Role |
| --- | --- | --- |
| `apps/<app>` | files under `apps/<app>/**` | App-specific engineer (one bucket per app) |
| `packages/<pkg>` | files under `packages/<pkg>/**` | Package engineer (one bucket per package) |
| `infra` | Dockerfiles, compose, `monitoring/`, hook configs | DevOps |
| `docs` | `docs/**` (excluding `docs/browzer/`) | Tech writer |

Files belong to exactly one bucket. A file matching two prefixes goes to the more specific one (`packages/cli/scripts/x` → `packages/cli`, not `infra`).

3. For each bucket: populate `domains[].likelyFiles[]` with `path` + `score`, then INLINE the FR text (not just IDs) into `domains[].relatedFRs[]`. The closure principle for downstream consumers depends on full-text inlining — `generate-task` and `execute-task` must never have to back-reference PRD.md.

## Blast radius collection

For each `likelyFiles[].path`, run BOTH directions and persist the structured form per file. The mermaid sidecar is rendered later by the bundled script — never author mermaid by hand.

```bash
browzer deps    "$path"           --json --save /tmp/scope-deps-${slug}.json
browzer deps    "$path" --reverse --json --save /tmp/scope-rdeps-${slug}.json
```

Populate per-file:

```yaml
blastRadius:
  forward:   [ ... top-K (cap 15) ]
  reverse:   [ ... top-K (cap 15) ]
  reverseCount: <pre-truncation count>
  truncatedAt:  15        # only when reverseCount > 15
```

**Filter rules** (applied before truncation):

- Exclude `reverse` entries that are themselves in `likelyFiles[]` — those are co-changing, not external blast.
- Always KEEP test files in `reverse` (signal for `write-tests` later).
- Drop generated files (`*.gen.*`, `*.pb.go`, `vendor/**`).

Aggregate the union of all `likelyFiles[].blastRadius.reverse[]` (minus the self-set of `likelyFiles[]`) into `featureBlastRadius` at the top level. This is the surface `feature-acceptance` and `code-review` compare against the actual diff.

Full protocol details: `${CLAUDE_SKILL_DIR}/references/blast-radius-protocol.md`.

## Skill discovery — `find-skills` programmatic (NON-OPTIONAL)

For each unique domain bucket, dispatch `Skill(browzer:find-skills)` in
programmatic mode to enumerate installed domain skills. Then, for each
applicable **cross-cutting concern tag** from
`${CLAUDE_PLUGIN_ROOT}/references/skills-discovery-limits.md`
(`performance`, `race-condition`, `hooks`, `accessibility`, `security`,
`prompt-engineering`, `simplification`, `test-strategy`), run a second
`find-skills` query keyed on the tag. Cross-cutting skills get zero
signal from library-name queries — without the tag pass, skills like
`claude-code-hooks`, `performance-hunter`, `simplify`, and
`race-condition` silently fail discovery.

Use the FULLY QUALIFIED name `browzer:find-skills` — a marketplace
`find-skills` skill commonly shadows the unqualified name and lacks the
programmatic mode, which silently produces unhelpful results. The
expected output key is `installed[]` — never `matched_installed_skills[]`,
`skills[]`, `results[]`, or other variants.

**`findSkillsRan` audit field — REQUIRED.** Write
`findSkillsRan: true` to `EXPLORATION.md` frontmatter on every
invocation, even when zero results came back. Downstream consumers
(`generate-task`, `code-review`, `update-docs`) distinguish *"find-skills
returned zero"* (valid signal) from *"find-skills was never called"*
(bug) via this field. Skipping the field is a contract violation.

**Tag-applicability heuristic** — apply a tag query when the bucket's
file set matches the criteria below:

| Tag | Bucket criterion |
|---|---|
| `performance` | bucket touches hot-path code, loops, fan-out I/O, N+1 suspects |
| `race-condition` | bucket touches concurrent code (`Promise.all`, locks, pub/sub, transactions, BullMQ consumers) |
| `hooks` | bucket touches Claude Code lifecycle hooks (any `hooks/**/*.mjs` or hook config) |
| `accessibility` | bucket touches UI source (`.tsx`, `.jsx`, `.svelte`, `.vue` under a frontend app) |
| `security` | bucket touches auth, credentials, secrets, RBAC, sensitive paths |
| `prompt-engineering` | bucket touches LLM call-sites, agent dispatch, MCP servers |
| `simplification` | bucket is marked refactor/cleanup OR scope >10 files |
| `test-strategy` | bucket touches test files, fixtures, mocks, mutation testing setup |

Verify each returned `installedAt` path exists on disk before keeping
the entry. Never invent skill names. Three result shapes worth handling:

- **Direct match** (e.g. a `golang-best-practices` skill for a Go bucket): keep with `relevance: high`.
- **Tangential match** (e.g. a `doc-coauthoring` skill returned for a README-update bucket): the skill helps but is not the canonical fit. Keep with `relevance: medium` and add a one-line entry to `assumptions[]` naming the gap.
- **Cross-cutting match** (e.g. a `performance-hunter` skill returned via the `performance` tag): keep with `relevance: medium` by default; bump to `high` only when the diff explicitly exercises the concern.
- **Empty result**: leave `skillsFound: []` for the bucket and add an `assumptions[]` entry so the operator can decide whether to install a relevant skill before tasks are decomposed.

The invocation rule (when subagents actually call these skills) is
owned by `execute-task` via the compact dispatch template at
`${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` —
`scope-feature` only DISCOVERS and PERSISTS the data.

## Deletion-aware blast radius (whole-repo)

The per-file `browzer deps --reverse` probe is necessary but not
sufficient when the feature **deletes files or removes exported
symbols**. `deps` only follows import-graph edges; consumers that
reference the deleted surface through indirect mechanisms (cobra
command dispatch, CI YAML invocations, lefthook entries, script-side
greps, dynamic require strings, doc bodies) escape the import graph.

For every file in `inScope[]` that the operator's brief flags as
**slated for deletion** AND for every exported symbol marked for
removal in `PRD.frontmatter.removedSymbols[]` (when populated), the
scoper runs the deletion-blast probe:

```bash
# 1. Whole-repo path-reference grep — catches CI YAML, lefthook,
#    Makefiles, shell scripts, doc bodies that name the file directly.
for F in $FILES_SLATED_FOR_DELETION; do
  BASENAME="$(basename "$F")"
  rg --files-with-matches --fixed-strings "$BASENAME" \
    --glob '!**/staging/**' --glob '!**/node_modules/**' \
    --json | tee "/tmp/scope-delete-pathref-$(echo "$F" | tr '/' '_').json"
done

# 2. Symbol mentions via the Browzer graph — catches every direct caller
#    of every exported symbol slated for removal, including non-import
#    references (dynamic dispatch, test pins, doc citations).
for S in $REMOVED_SYMBOLS; do
  browzer mentions "$S" --json --save "/tmp/scope-mentions-${S}.json"
done

# 3. CI / hook / lefthook audit — every file matching common CI
#    locations gets path-referenced against the file basenames.
for F in $FILES_SLATED_FOR_DELETION; do
  BASENAME="$(basename "$F")"
  rg --files-with-matches --fixed-strings "$BASENAME" \
    .github/workflows lefthook.yml .lefthook .lefthook.yml \
    Makefile makefile package.json \
    --json 2>/dev/null \
    | tee "/tmp/scope-ci-audit-$(echo "$F" | tr '/' '_').json"
done
```

For every match the probe surfaces, add an entry to the bucket's
`likelyFiles[]` with `discoveredVia: deletion-blast-probe` so
downstream consumers know the file entered scope via an indirect
reference rather than a direct AC.

When any probe returns a hit OUTSIDE the originally declared
`inScope[]`, surface a one-line `assumptions[]` entry: the operator
needs to know the deletion sweep is wider than the brief implied.
Three production-observed failure modes this prevents:

- A retired CLI verb is still dispatched by a cobra command registration in `commands/`.
- A retired script is still invoked by a CI workflow YAML or `lefthook.yml` entry.
- A retired exported symbol is still consumed by a doc body or audit script outside the original task scope.

If the operator brief contains no deletion signal (no "remove",
"retire", "drop", "delete", "cleanup", or symbol-removal phrasing
detectable via simple keyword match against
`BRIEF.md.body` + `PRD.md.frontmatter.outOfScope[]`), skip this section
entirely.

## Sensitive-scope detection

Apply the UNION of two predicate files — BOTH passes (path-glob AND content-grep for new mutation tokens):

- `../../references/sensitive-paths.md` — cross-skill base (RBAC SSOT modules, translation catalogues, content-based mutation tokens, operator extensions).
- `${CLAUDE_SKILL_DIR}/references/sensitive-paths-extended.md` — extended pattern set (auth/billing/middleware/migrations/secrets/credentials/.env/authz/queue/jobs).

For each match, append to `sensitiveScopeHits[]`:

```yaml
- path:    <matched-path>
  pattern: <matched-glob-or-content-rule>
  reason:  <one-line gloss — auth, billing, RBAC, migrations, ...>
  invariantSources:
    - <files-that-document-the-invariant>
```

`generate-task` reads `sensitiveScopeHits[]` to know which tasks must declare non-empty `invariants[]`. An empty array is valid (no sensitive surfaces touched) — do not fabricate hits.

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/template.md` — canonical EXPLORATION.md shape.
2. Run preflight: `browzer workspace status --json`.
3. Compute `prdSha`: `git hash-object docs/browzer/$featureId/staging/PRD.md`.
4. Read PRD.md frontmatter; extract FRs, ACs, personas, `inScope[]`, `prdReceipts[]`.
5. Apply the PRD receipt carry-forward: skip any browzer query whose surface is already covered by `prdReceipts[].surfaces[]`.
6. For each FR/AC noun NOT covered by carry-forward: run `browzer explore`; bucket hits by path prefix.
7. For each `likelyFiles[].path`: run `browzer deps` forward + `--reverse`; truncate per top-K rule.
8. Apply the deletion-aware blast probe (whole-repo path-grep + `browzer mentions` + CI/hook audit) when the brief contains deletion signals OR `PRD.removedSymbols[]` is populated.
9. For each domain bucket AND each applicable cross-cutting concern tag: dispatch `Skill(browzer:find-skills)` in programmatic mode; verify `installedAt` paths on disk. Set `findSkillsRan: true` in frontmatter regardless of outcome.
10. Apply sensitive-path predicate over all `likelyFiles[].path`; populate `sensitiveScopeHits[]`.
11. Write `docs/browzer/$featureId/staging/EXPLORATION.md` matching the template shape.
12. Generate the mermaid blast graph:
    ```bash
    node ${CLAUDE_SKILL_DIR}/scripts/render-blast.mjs docs/browzer/$featureId/staging/EXPLORATION.md --scope feature
    ```
13. Append receipts:
    ```bash
    node ${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs $featureId
    ```
14. Audit `skillsFound[]` matrix (empty-everywhere defence, R5):
    ```bash
    node ${CLAUDE_SKILL_DIR}/scripts/audit-skills-found.mjs $featureId
    ```
    The audit exits 1 when EVERY domain reports `skillsFound: []` while
    `findSkillsRan: true` — a strong signal that `find-skills` parsing
    or marketplace lookup degraded. On non-zero exit, the scoper MUST
    apply the two-step fallback from `agents/scoper.md §Empty-everywhere
    defence` (direct `ls` over `~/.claude/skills/` + `.claude/plugins/`,
    keyword filter per domain, record fallback resolution in
    `assumptions[]`) and re-run the audit to green.

## Done when

- `docs/browzer/$featureId/staging/EXPLORATION.md` exists with valid YAML frontmatter and a non-empty `prdSha`.
- `EXPLORATION.md.frontmatter.findSkillsRan == true` (audit field, always present).
- `node scripts/audit-skills-found.mjs $featureId` exits 0 — either ≥1 domain carries a non-empty `skillsFound[]`, OR the operator has accepted the all-empty matrix and recorded the rationale in `assumptions[]` (the audit re-runs green once entries are added).
- Every PRD `functionalRequirements[].id` is referenced by ≥1 `domains[].relatedFRs[]` (no orphan FRs in scope).
- Every `likelyFiles[].path` has a `blastRadius` block (empty arrays valid for brand-new files; `reverseCount` MUST be present).
- Every `domains[].skillsFound[].installedAt` path exists on disk.
- When the brief contains deletion signals, every match from the deletion-blast probe is either in `likelyFiles[]` (with `discoveredVia: deletion-blast-probe`) or surfaced under `assumptions[]`.
- `docs/browzer/$featureId/staging/EXPLORATION_BLAST.mmd` exists.
- `docs/browzer/$featureId/staging/RECEIPTS.md` contains a `## scope-feature` section.

Return one line:

> `scope-feature: <D> domains, <F> files, <S> skills resolved, <H> sensitive hits.`

Your turn is incomplete until EXPLORATION.md, EXPLORATION_BLAST.mmd, and the appended RECEIPTS.md exist on disk. Do not stop to summarize after writing them.
