# Finding shape — structured `findings[]` discipline

`findings[]` entries are the load-bearing data structure crossing the
boundary from `code-review` to `receiving-code-review`. Every field below
has a precise contract.

---

## Schema (frontmatter)

```yaml
findings:
  - id: F-001                          # CANONICAL: F-NNN zero-padded; per-lane files use LANE_PREFIX-N (no padding)
    mergedFrom: ["SR-3", "QA-1"]        # OPTIONAL in lane files; REQUIRED in aggregate when ≥2 lanes raised the same concern
    severity: high                       # REQUIRED — high | medium | low
    lane: senior-engineer                # REQUIRED in aggregate; auto-derived from mergedFrom[0] when not specified
    file: <repo-relative path>           # REQUIRED — POSIX, no leading ./
    line: 42                             # OPTIONAL — 1-based int; OMIT (don't set null) for file-level findings
    ruleId: n-plus-one                   # REQUIRED — short kebab-case tag
    title: "<one-line summary>"          # REQUIRED — ≤80 chars
    description: |                       # REQUIRED — multi-line, cites CLAUDE.md or browzer evidence
      ...
    pinsTask: [TASK_03]                   # OPTIONAL — IDs of TASK_NN.completed.md that introduced this surface
    pinsAcs: [AC-02]                      # OPTIONAL — PRD AC IDs this finding affects (forwards to feature-acceptance)
    pinsFiles: ["<repo-relative path>"]   # REQUIRED — at least the `file` itself; more entries when the fix spans files
    fix: "<one-line concrete suggestion>" # REQUIRED — actionable, ≤120 chars
    assignedSkill: <skill-name|null>      # OPTIONAL — canonical fix skill (e.g. "fastify-best-practices"); null when no matcher
```

---

## Aliases (aggregator-tolerated drift)

`aggregate-findings.mjs` normalizes a handful of alias keys onto the
canonical shape before computing merge keys. Lane authors should still
emit the canonical keys — these aliases exist to repair hand-authored
drift, not to license a parallel contract.

| Canonical key  | Accepted aliases                            | Normalization rule |
|----------------|---------------------------------------------|--------------------|
| `description`  | `summary`                                   | Take the first non-empty value of `description` ∥ `summary`. |
| `pinsFiles[]`  | `pin.path` (when `pin` is an object) · `pinsFile` (singular) | Promote a single string to a one-element array; union with explicit `pinsFiles[]`; always include `file` itself. |
| `line`         | `pin.startLine` (when `pin.line` absent)    | Use `pin.startLine` only when top-level `line` is undefined. |
| `ruleId`       | (missing entirely)                          | Default to `"general"` and log a warning naming the lane + finding id. |
| `fix`          | (missing entirely)                          | Empty string; log a warning naming the lane + finding id. |

**Warnings, not errors**: a finding that lands with an alias-only shape
(or with no `description`/`fix`) is still merged into the aggregate —
the aggregator's job is to preserve every finding, not to gatekeep on
shape. Warnings surface to stderr so the dispatcher (or the
regression-tester lane) sees the contract drift and can patch the lane
file or the lane's persona block.

A finding whose `description` is empty after alias normalization is
emitted in the aggregate with `description: ""` and the warning
`finding <id> has no description` — the next phase
(`receiving-code-review`) treats the empty `description` as a contract
violation and refuses to dispatch a fixer for that finding until the
operator triages.

---

## ID conventions

- **Per-lane file IDs** use the lane prefix UNPADDED: `SR-1`, `SR-10`, `ARCH-1`, `QA-1`, `REG-1`. Specialists use the first 4 alphanumerics uppercased (`FAST-1` for `fastify-best-practices`, `REAC-1` for `react-performance`, `GEN` when no alphanumerics exist).
- **Aggregate (CODE_REVIEW.md) IDs** use canonical `F-NNN` zero-padded to 3 digits: `F-001`, `F-002`, `F-010`. Assignment is stable and sequential across all merged findings.
- **Cross-reference traceability** — when `aggregate-findings.mjs` merges two lane findings on the same `(file, line, ruleId)` triple, both prefix IDs appear in `mergedFrom[]` and the aggregate gets a single canonical `F-NNN`.

---

## Preserve-all merge algorithm

`aggregate-findings.mjs` implements the following — no dedup, no severity
rollup that drops items:

1. **Collect** every `findings[]` from every `CODE_REVIEW.<lane>.md`.
2. **Build merge key** = `(normalize(file), line ?? 0, ruleId)` per finding.
3. **Group** findings by merge key. Within a group:
   - `mergedFrom[]` = ascending list of all per-lane IDs in the group
   - `severity` = max severity in the group (high > medium > low)
   - `lane` = the lane of the first (alphabetically) per-lane ID
   - `description` = concatenated descriptions with `\n\n---\n\n` separator
   - `fix` = first non-empty `fix` value in the group
   - `pinsTask[]`, `pinsAcs[]`, `pinsFiles[]` = unioned across the group
   - `assignedSkill` = first non-null value, or null if all null
4. **Assign global ID** sequentially: `F-001`, `F-002`, … in stable order
   (by lowest `mergedFrom[]` ID lexicographically, then by file path, then
   by line).
5. **Populate `severityCounts`** from the merged list.
6. **Never drop** a finding. A lane's finding may only be omitted if its
   per-lane source file is absent (record in the aggregator's notes
   field) or if the lane explicitly marked `status: wontfix` (which the
   schema currently does NOT support — out of scope until a future
   contract revision).

---

## Pin discipline — closure intra-file

The `pinsTask[]`, `pinsAcs[]`, `pinsFiles[]` arrays are **structured ID
arrays only**. They MUST NOT carry narrative pins ("see the AC-02
discussion in TASK_03") — only IDs that downstream consumers
(`receiving-code-review`, `write-tests`, `feature-acceptance`) can look
up programmatically.

### Why this matters

`receiving-code-review` dispatches one fix-agent per finding. The fix
agent's prompt is composed from the finding's frontmatter — without
structured `pinsFiles[]`, the dispatcher would have to re-derive which
files to edit from narrative `description` prose. Same for write-tests
mapping findings back to test specs via `pinsAcs[]`.

### Invariants enforced by the aggregator

- Every `pinsTask[]` entry MUST reference a `TASK_NN.completed.md` that
  exists on disk in the same feat folder. The aggregator drops invalid
  entries with a logged warning.
- Every `pinsAcs[]` entry MUST match `^AC-\d+$` or `^FR-\d+$`. The
  aggregator does NOT validate that the AC/FR actually exists in PRD.md
  (closure cross-file — code-review never reads PRD.md). That validation
  is `feature-acceptance`'s job.
- Every `pinsFiles[]` entry MUST be a POSIX repo-relative path. At least
  one entry is required (typically `file` itself). The aggregator drops
  duplicates.

---

## Orphan findings

A finding with `pinsTask[] == []` is "orphan" — it surfaced from the
dep-graph traversal or domain-specialist audit but cannot be attributed
to a specific task in this feature. The aggregator lists orphan findings
in a separate sub-section of `CODE_REVIEW.md`'s body so the operator can
triage:

- Accept and route to `receiving-code-review` (typically when severity
  is high)
- Defer to a follow-up feature (typically when severity is low and the
  finding pre-existed the current feature)
- Mark as won't-fix (operator decision, not a code-review verdict)
