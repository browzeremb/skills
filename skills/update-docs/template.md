# Update-docs template

Single artefact: `docs/browzer/<feat>/staging/DOC_PATCHES.md`. LLM-authored
aggregate, written in two passes:

- **Phase A** writes the frontmatter with `candidateDocs[]` (no body).
- **Phase B** appends the body with applied diffs and flips `candidateDocs[].applied` to true/false.

`update-docs` patches existing markdown docs only — NEVER creates new ones.

---

## Frontmatter (REQUIRED)

```yaml
---
featureId: feat-YYYYMMDD-<slug>
prdSha: <SHA mirrored from upstream>
generatedAt: <RFC3339>
phase: A | B                                # A = discovery only; B = patches applied
skipped: false                              # true when no exported-symbol changes — see Skip rule below
skipReason: "<rationale>"                   # REQUIRED when skipped == true
summary:
  candidatesConsidered: <int>
  patchesApplied: <int>
  enoentFixed: <int>
candidateDocs:                              # populated in Phase A; refined in Phase B
  - docPath: <repo-relative path>            # MUST be existing .md or .mdx
    discoveryReceipts:                       # /tmp/update-docs-*.json paths that surfaced this doc
      - /tmp/update-docs-<feat>-mentions-<slug>.json
    symbolsCited:                            # symbols from `### Symbols changed` blocks that this doc references
      - <path>::<dottedName>
    drift: signature | semantics | removed | mention-only
    applied: true | false                    # Phase A: false; Phase B: outcome
    appliedReason: <string>                  # when applied == false in Phase B: rationale
docsPatched:                                 # populated in Phase B; subset of candidateDocs where applied == true
  - docPath: <repo-relative path>
    linesAdded: <int>
    linesRemoved: <int>
    citationCount: <int>                     # count of symbol references updated
    enoentFixesApplied: <int>
enoentScan:                                  # populated in Phase B
  ran: true | false
  filesScanned: [<doc-paths>]
  brokenCommandsFound: <int>
  brokenCommandsFixed: <int>
---
```

---

## Body (REQUIRED in Phase B)

```markdown
# Documentation patches

## Patch log

### Docs patched
- (regex-strict per ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md Block 5)

## Patch summary

<one paragraph per patched doc: doc path, what changed in the doc to match
the changed symbols, optional before/after snippet>

## Skipped candidates

<sub-section when some candidateDocs entries have applied == false:
list with rationale (typically "doc cites the symbol but the cite is
generic, not signature-dependent">)

## ENOENT scan

<sub-section when enoentScan.brokenCommandsFound > 0:
list each broken command, its location, and the fix applied>

## Skipped (only when frontmatter.skipped == true)

<rationale: e.g. "no exported-symbol changes in upstream phases — no
public surface drift, no docs to patch">
```

---

## Skip rule

`update-docs` MAY exit cleanly without dispatching the discovery
subagent when:

1. Every upstream `### Symbols changed` block (across `TASK_*.completed.md` + `FIX_*.completed.md`) has either `scope == internal` OR is `(none)`.
2. No `### Files modified` / `### Files created` block touches a path under `docs/` (e.g. the host's own doc tree).

When both conditions hold, write DOC_PATCHES.md with:

- `phase: B` (terminal)
- `skipped: true`
- `skipReason: "no exported-symbol changes in upstream phases — no public surface drift"`
- empty `candidateDocs[]`, `docsPatched[]`
- `enoentScan: { ran: false, ... }`

This avoids the ~30s discovery dispatch cost for pure-refactor or
internal-only features.

---

## Cross-reference invariants

1. Every `candidateDocs[].docPath` MUST exist on disk before Phase B (Phase A discovery validates).
2. Every `docsPatched[]` entry MUST have a corresponding `candidateDocs[]` entry with `applied: true`.
3. `summary.candidatesConsidered == candidateDocs.length`.
4. `summary.patchesApplied == docsPatched.length`.
5. When `skipped == true`, candidateDocs[] and docsPatched[] MUST be empty; the `### Docs patched` body block MUST be `- (none)`.
6. `enoentScan.brokenCommandsFixed <= enoentScan.brokenCommandsFound`. Unfixed broken commands MUST appear in the body's ENOENT scan section with rationale.
