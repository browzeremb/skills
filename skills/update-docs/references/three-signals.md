# three-signals — the three mandatory doc-discovery passes

`update-docs` runs **all three signals on every invocation**. There is no per-run search budget.
Collapsing any signal to anchor-doc-only (i.e. `twoPassRun: { directRef: false, conceptLevel: false,
skipReason: "session budget" }`) is a contract violation. See Phase 0.4 enforcement.

---

## Phase 1a — Mentions pass (graph-level reverse traversal)

`browzer mentions <file>` returns indexed documents whose chunks mention the file via
`File ← RELEVANT_TO ← Entity ← MENTIONS ← Chunk ← HAS_CHUNK ← Document`.

```bash
browzer mentions "$FILE" --json --save "/tmp/mentions-$(basename "$FILE").json"
```

### JSON shape (authoritative)

```jsonc
{
  "mentions": [
    { "documentName": "<path>", "chunkCount": <int>, "score": <float>, ... }
  ],
  "meta": { "fileIndexed": <bool>, "commitsBehind": <int>, ... }
}
```

The top-level key is **`.mentions`** — NOT `.entries`. `entries` is the `browzer search` /
`browzer explore` output shape; `browzer mentions` returns its own envelope. Mixing the two is
a recurring failure mode (dogfood report friction §browzer mentions): a `jq '.entries[]'` call
against a mentions response evaluates to `null`, jq prints `Cannot iterate over null`, and the
agent silently falls back to grep while still claiming `mentionsPass: true`.

### Canonical jq projections

```bash
# Whole list
jq '.mentions[]'                "$MENTIONS_JSON"

# High-confidence pool (chunkCount-driven, threshold 0.5 against the per-file max)
jq '
  (.mentions // []) as $m
  | ([$m[].chunkCount // 0] | max // 0) as $maxCC
  | $m[]
  | select($maxCC > 0 and (.chunkCount / $maxCC) >= 0.5)
' "$MENTIONS_JSON"

# Index-lag detection (drives the decision matrix below)
jq '{ fileIndexed: .meta.fileIndexed, commitsBehind: .meta.commitsBehind, count: (.mentions | length) }' "$MENTIONS_JSON"
```

Decision matrix (apply per file BEFORE falling back to grep):

| `meta.fileIndexed` | `meta.commitsBehind` | `.mentions`     | Freshly edited? | Action |
| ------------------ | -------------------- | --------------- | --------------- | ------ |
| `false`            | any                  | always `null`   | n/a             | File outside indexed snapshot. Skip graph signal; fall back to grep silently. |
| `true`             | `> 0`                | `null` or `[]`  | n/a             | Index lag. Record warning + fall back to grep WITHOUT prompting operator. |
| `true`             | `0`                  | `null` or `[]`  | **yes**         | Index fresh but file has uncommitted edits. Fall back to grep silently. |
| `true`             | `0`                  | `null` or `[]`  | no              | Definitive: no doc references this file. Skip propagation; do NOT grep. |
| `true`             | any                  | non-empty array | n/a             | Use as high-confidence signal pool for Phase 3 classification. |

"Freshly edited" = `git diff --name-only HEAD -- <file>` shows uncommitted changes OR the file is
in the orchestrator-aggregated changed-file list.

Fallback grep:

```bash
grep -rln --include='*.md' "$(basename "$FILE")" docs apps/*/CLAUDE.md packages/*/CLAUDE.md CLAUDE.md README.md 2>/dev/null
```

Each grep hit → `mentionedBy` entry with `confidence: 0.5`. Surface the fallback warning in chat
only when index lag was detected (not on every null — the always-warn path produces noise).

---

## Phase 1 — Direct-ref pass

For EVERY changed file, find markdown that literally names it. Do not stop early — every changed file
gets both queries:

```bash
browzer search "<full-path>" --json --save /tmp/update-docs-direct-1.json
browzer search "<basename>"  --json --save /tmp/update-docs-direct-2.json
```

Deduplicate by `documentName`. Drop hits inside the feat folder. Drop hits under historical/archived
subtrees (`retrospectives/`, `archive/`, `history/`, `old/`, `status: archived` frontmatter).

---

## Phase 2 — Concept-level pass

Docs describe areas, not just file names. This pass catches concept-level references.

### 2.1 — Extract concepts

- Nearest `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` walking up from each changed file.
- Consumers from `browzer deps --reverse` for each changed file.
- Symbol-level hits from `browzer explore "<symbol>"` when the changed file exports a named symbol.
- Package/app name (strip path to package/feature segment).
- Module/layer (`src/middleware/...` → "middleware", `src/routes/...` → "routes").
- Purpose inferred from filename (`auth.ts` → "authentication", `rbac.ts` → "authorization").

Dedupe the concept list.

### 2.2 — Search concepts + anchor docs

For each distinct concept:

```bash
browzer search "<concept>" --json --save /tmp/update-docs-concept-<slug>.json
```

Always include (no search cost, known paths):

- Every `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` walking up from each changed file's directory.
- Every `CLAUDE.md` / `AGENTS.md` / `README.md` next to a direct importer from `browzer deps --reverse`.
- `TECHNICAL_DEBTS.md`, `DEBTS.md`, `ROADMAP.md`, `CHANGELOG.md` at the repo root — if the change
  closes an item tracked there.
- Any `README.md` along the change's directory path — if the change alters something user-visible
  (public API, CLI flag, env var, port, command).

Run a `browzer search` for every distinct concept — no per-pass cap.

### 2.3 — Merge candidate pools

Dedupe across Phase 1a (mentions), Phase 1 (direct-ref), Phase 2 (concept-level). A doc in two
pools is still one candidate; prefer the higher-confidence signal when classifying.

**Batch three-signal dispatch (budget optimization):** instead of three sequential browzer calls per
file, batch all three queries for all files into ONE multi-search dispatch when session token pressure
is detected. The batch MUST still run all three signals — it is a performance optimization, not a
signal-reduction strategy.

```bash
# Batch example — one jq invocation collects all three signal outputs:
for F in $FILES; do
  SLUG=$(echo "$F" | tr '/' '_')
  browzer mentions "$F"    --json --save "/tmp/ud-mentions-$SLUG.json" &
  browzer search "$F"      --json --save "/tmp/ud-direct-$SLUG.json"  &
  browzer search "$(basename "$F")" --json --save "/tmp/ud-base-$SLUG.json" &
done
wait
```

---

## Anchor-doc audit (mandatory)

Without an explicit audit, anchor-pool docs (e.g. repo-root `CHANGELOG.md`) can be silently skipped
when their always-include condition evaluates false.

Emit on every run:

```jsonc
"anchorDocsAlwaysIncluded": [
  { "doc": "CLAUDE.md", "source": "walk-up", "disposition": "deduped-vs-direct-ref" },
  { "doc": "docs/CHANGELOG.md", "source": "repo-root-changelog", "disposition": "auto-included-fresh" },
  { "doc": "docs/TECHNICAL_DEBTS.md", "source": "repo-root-debts", "disposition": "auto-included-fresh" },
  { "doc": "apps/web/README.md", "source": "user-visible-change", "disposition": "skipped-no-user-visible-change" }
]
```

Disposition values:
- `auto-included-fresh` — anchor doc added from always-include set; not in any other pool.
- `deduped-vs-direct-ref` / `deduped-vs-mentions` / `deduped-vs-concept` — appeared in both pools; counted once.
- `skipped-no-user-visible-change` — condition evaluated false.
- `skipped-historical-archived` — anchor doc lives under a historical/archived subtree.

Emit even when empty (`[]`).

---

## Citation policy (Phase 4.1)

**Banned citation targets** in any patched doc:

- Feature working directories: `docs/<feat-folder>/*`, `<feat>/workflow.json`, `<feat>/PRD.md`, etc.
- Markdown docs by mutable file path (doc trees reorganise; links break).
- PR descriptions, issue comments, branch names.
- Internal tracker IDs unless the surrounding doc already cites them.

**Allowed citation forms:**

1. **Commit hash** — `(see commit \`abc1234\`)`.
2. **CHANGELOG entry** — `(see CHANGELOG entry "<short title>")`.
3. **Same-doc anchor** — `(see §Phase 3)`.

---

## Phase 0.4 — Three-signal contract enforcement

**Before Phase 5's final write**, validate that ALL THREE signals ran. The triple is
`mentionsPass + directRef + conceptLevel` — `mentionsPass` was missing from the original gate
(dogfood report friction §update-docs mentions API drift) which let runs silently fall back to
grep while still claiming a clean three-signal pass.

```bash
TWO_PASS=$(echo "$UPDATE_DOCS_PAYLOAD" | jq '{
  mentionsPass: .twoPassRun.mentionsPass,
  directRef:    .twoPassRun.directRef,
  conceptLevel: .twoPassRun.conceptLevel
}')
MENTIONS=$(echo "$TWO_PASS" | jq -r '.mentionsPass')
DIRECT=$(echo "$TWO_PASS"   | jq -r '.directRef')
CONCEPT=$(echo "$TWO_PASS"  | jq -r '.conceptLevel')

if [ "$MENTIONS" != "true" ] || [ "$DIRECT" != "true" ] || [ "$CONCEPT" != "true" ]; then
  echo "update-docs: stopped — three-signal contract violated"
  echo "hint: twoPassRun.mentionsPass=$MENTIONS directRef=$DIRECT conceptLevel=$CONCEPT — run all three signals or batch them; never silently downgrade"
  echo "hint: if browzer mentions returned null, check the JSON shape — the key is .mentions (NOT .entries; see §Phase 1a JSON shape)"
  exit 1
fi
```

`mentionsPass: true` requires that `browzer mentions` actually returned a usable response
(see the §Phase 1a decision matrix). When the matrix legitimately falls back to grep
(uncommitted edits, index lag, file outside snapshot), `mentionsPass: true` is still valid as
long as the grep fallback was actually executed and recorded — record the rationale in
`twoPassRun.mentionsFallback: "<reason>"` so the audit trail can distinguish "grep ran"
from "skipped silently".

This check is non-optional. If session-budget pressure caused a signal to be skipped, the correct
fix is to batch the three queries (see §2.3 above), NOT to downgrade silently and record
`skipReason: "session budget"`.
