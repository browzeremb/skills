# Markdown-chain output contract

> **Applicability** — cross-skill. Every skill that writes execution receipts
> consumed by a downstream parser MUST emit the canonical block shapes below.
> The shapes are regex-strict by contract: no LLM-fallback parsing exists for
> them anywhere in the chain. Loose prose drifts within ≤3 skill versions and
> breaks consumers silently — do not invent variants.

This doc is the single source of truth for the 5 canonical execution-log
blocks emitted across the markdown chain:

| Block | Producer phase | Consumer phase(s) |
|---|---|---|
| `### Files modified` | execute-task, receiving-code-review | code-review, finalize-feature |
| `### Files created` | execute-task, receiving-code-review | code-review, finalize-feature |
| `### Symbols changed` | execute-task, receiving-code-review | code-review (qa lane butterfly), finalize-feature (Phase A doc-patching skip rule + discovery seed) |
| `### Tests added` | execute-task (coder subagent, inline per Lever C) | feature-acceptance, finalize-feature, code-review (regression-tester + qa lanes) |
| `### Docs patched` | finalize-feature (Phase A) | finalize-feature (Phase B README render) |

All five share three contract rules:

1. **Always emitted.** Empty case is a single literal `(none)` bullet — never
   a missing section. A missing section is a malformed-report signal.
2. **One bullet per item.** No prose, no compound bullets, no nested lists.
3. **Regex-strict.** Bullets that fail the regex below are dropped silently by
   the parser — the producing skill must validate shape before writing.

---

## Block 1 — `### Files modified`

For every existing file whose body was edited. New files go in Block 2 instead.

**Regex:**

```
^- (\S+) \(\+(\d+)/-(\d+)\)$
```

**Capture groups:** `path` · `added` · `removed`

<!-- host-example: paths are illustrative and language-agnostic -->
**Examples:**

```markdown
### Files modified
- src/server/main.<ext> (+23/-4)
- src/api/handler.<ext> (+8/-2)
- src/lib/auth.<ext> (+45/-12)
```

```markdown
### Files modified
- (none)
```

**Producer guarantees:**

- `path` is repo-relative POSIX (forward slashes, no leading `./`)
- `added` / `removed` are the line counts from `git diff --numstat` for this file scoped to this phase's work
- Generated files (`*.gen.*`, `*.schema.json`, etc.) are EXCLUDED — they re-derive deterministically and pollute the contract
- Order: ascending path

---

## Block 2 — `### Files created`

For every brand-new file. Files moved/renamed appear here with the destination path; the source path appears in Block 1 as `(+0/-N)`.

**Regex:**

```
^- (\S+) \(\+(\d+)\)$
```

**Capture groups:** `path` · `lineCount`

<!-- host-example: paths are illustrative and language-agnostic -->
**Examples:**

```markdown
### Files created
- src/cache/lru.<ext> (+87)
- src/components/banner.<ext> (+34)
```

```markdown
### Files created
- (none)
```

**Producer guarantees:**

- No `-` term (a new file has nothing to remove)
- `lineCount` is the post-write `wc -l` of the file body (no trailing-newline ambiguity)
- Order: ascending path

---

## Block 3 — `### Symbols changed`

Per-symbol diff at the API-surface granularity. Pure refactors that preserve
all observable behaviour emit `(none)` — silence means "no butterfly check
required".

**Regex:**

```
^- (exported|internal) (function|method|type|const|var|interface|class|struct|enum) (\S+)::(\S+) (added|removed|signature-changed|semantics-changed)$
```

**Capture groups:** `scope` · `kind` · `path` · `dottedName` · `change`

**Symbol-id schema:** `<repo-relative-path>::<dotted-name>` — language-agnostic
by design. Works for Go, TS/JS, Python, Rust, Java without per-language parsing.

- `dottedName` examples: `Run` (top-level), `Scorer.format` (method on type), `pkg.Foo.Bar` (nested)
- `scope == exported` → reviewer must scope butterfly-effect probe (`browzer mentions`)
- `scope == internal` → no external callers; skip global probe

**Change-kind semantics:**

| Value | Meaning |
|---|---|
| `added` | New symbol introduced. No prior callers, no butterfly. |
| `removed` | Symbol deleted. Callers MUST migrate; high butterfly risk. |
| `signature-changed` | Parameters / return / generics edited. Callers may need updates. |
| `semantics-changed` | Same signature, behaviour shifted (return-value invariant inverted, side-effect added, error contract narrowed). Callers should re-validate. |

<!-- host-example: paths are illustrative and language-agnostic -->
**Examples:**

```markdown
### Symbols changed
- exported function src/server/main.<ext>::Run signature-changed
- exported method src/api/handler.<ext>::Server.HandleRequest semantics-changed
- internal type src/cache/lru.<ext>::Entry added
- exported function src/lib/auth.<ext>::validateToken removed
```

```markdown
### Symbols changed
- (none)
```

**Producer guarantees:**

- Every `path` prefix (substring before `::`) appears in Block 1 OR Block 2
  of the same execution log. A symbol-without-file is a contract violation
  the downstream parser surfaces.
- Order: ascending `path::dottedName`

**Consumer guarantees:**

- code-review qa lane filters this block by `scope == exported AND change IN (signature-changed, semantics-changed, removed)` for its butterfly probe (`browzer mentions <symbol-id>`). `added` is excluded (no prior callers); `internal` is excluded (no external callers).

---

## Block 4 — `### Tests added`

Tests authored by `execute-task`'s coder subagent inline alongside the
implementation (Lever C — tests live in the host codebase, not in a
separate phase artefact). One bullet per test file. The shape was
simplified when mutation testing was removed from the workflow — the
historical `killedMutants/totalMutants` suffix is now optional and
defaults to `0/0` for back-compat parsers.

**Regex (current):**

```
^- (T-\d+) (\S+)::(\S+) (green|red|chaos)(?: (\d+)/(\d+))?$
```

**Capture groups:** `testId` · `file` · `symbolUnderTest` · `intent` · `killedMutants?` · `totalMutants?`

<!-- host-example: paths are illustrative and language-agnostic -->
**Examples:**

```markdown
### Tests added
- T-1 src/api/handler.test.<ext>::TestServer_HandleRequest_OK green 5/6
- T-2 src/api/handler.test.<ext>::TestServer_HandleRequest_RejectsInvalid red 4/4
- T-3 src/cache/lru.test.<ext>::TestLRU_Eviction green 8/8
```

```markdown
### Tests added
- (none)
```

**Intent semantics:**

| Value | Meaning |
|---|---|
| `green` | Happy path. Asserts intended behaviour. |
| `red` | Negative case. Asserts error / rejection / panic. |
| `chaos` | Adversarial / fault injection. Asserts graceful degradation. |

**Producer guarantees:**

- `file` is the test file path (must end in `_test.go`, `.test.ts`, `_test.py`, etc. per runner convention)
- `symbolUnderTest` is the source symbol the test covers (NOT the test function name) — uses the same dotted-name schema as Block 3
- `killedMutants / totalMutants` is **optional** and retained for back-compat with archived TASK_*.completed.md files. New tests authored under Lever C emit `0/0` or omit the suffix entirely. Mutation testing is removed from the workflow per Lever C (Stryker/mutmut/go-mutesting signal-to-noise dropped below the operational bar).
- Order: ascending `testId`

**Consumer guarantees:**

- `code-review`'s `regression-tester` lane reads this block to verify every `task.testSpecs[]` has a matching `### Tests added` bullet — gaps become normal HIGH findings flowing through the receiving-code-review ladder.
- `feature-acceptance` records `testsAdded[]` counts in the verdict body. No kill-rate threshold (mutation testing removed).

---

## Block 5 — `### Docs patched`

Existing markdown docs edited by `finalize-feature` Phase A. Net-new docs are
forbidden by contract — Phase A MAY patch only, never create.

**Regex:**

```
^- (\S+) \(\+(\d+)/-(\d+)\) cites:(\d+)$
```

**Capture groups:** `docPath` · `added` · `removed` · `citationCount`

<!-- host-example: paths are illustrative and language-agnostic -->
**Examples:**

```markdown
### Docs patched
- docs/api/handlers.md (+12/-4) cites:3
- docs/architecture/cache.md (+5/-0) cites:1
```

```markdown
### Docs patched
- (none)
```

**Producer guarantees:**

- `docPath` is repo-relative, must end in `.md` or `.mdx`
- `citationCount` is the number of distinct symbol-ids from Block 3 of the
  upstream execution logs that the patch updated references to
- Order: ascending `docPath`

---

## Empty-section invariant

The literal `(none)` bullet is the only permitted empty signal. The four
patterns the parser MUST distinguish:

| Pattern observed | Parser interpretation |
|---|---|
| Section heading present, single `- (none)` bullet | Empty by design — no action. **Legitimate signal**, never confuse with error. |
| Section heading present, valid bullets | Normal case — process bullets. |
| Section heading present, no bullets at all | **Contract violation** — producer skill must surface. |
| Section heading absent | **Malformed-report signal** — outcome `failure` with `Reason: malformed-subagent-report`. |

---

## Cross-block closure invariant

For any execution log carrying both Block 1 (or 2) and Block 3:

> Every `### Symbols changed` `path` prefix (substring before `::`) MUST
> appear in `### Files modified` OR `### Files created` of the same log.

A symbol-touched-without-file-edit cannot exist by construction. Producers
that emit such a bullet introduce a contract violation; consumers MAY drop
the orphan symbol with a logged warning.

---

## Where each block lives in the chain

Concrete contracts per skill:

### execute-task

```
docs/browzer/<feat>/staging/tasks/TASK_NN.completed.md
  └─ ## Execution log
      ├─ ### Files modified    ← Block 1
      ├─ ### Files created     ← Block 2
      └─ ### Symbols changed   ← Block 3
```

### receiving-code-review

```
docs/browzer/<feat>/staging/fixes/F-NNN.completed.md
  └─ ## Fix log
      ├─ ### Files modified    ← Block 1
      ├─ ### Files created     ← Block 2 (rare — fixes usually edit, not create)
      └─ ### Symbols changed   ← Block 3
```

### execute-task (Lever C — tests authored inline alongside implementation)

```
docs/browzer/<feat>/staging/tasks/TASK_NN.completed.md
  └─ ## Execution log
      ├─ ### Files modified    ← Block 1
      ├─ ### Files created     ← Block 2
      ├─ ### Symbols changed   ← Block 3
      └─ ### Tests added       ← Block 4 (one bullet per test file authored)
```

(The historical `TESTS.md` aggregate written by the legacy `write-tests`
phase no longer exists — `write-tests` was removed in Lever C. The
`testsAdded[]` array in `TASK_NN.completed.md.frontmatter` mirrors the
`### Tests added` block for structured consumers.)

### finalize-feature (Phase A — doc-patching)

```
docs/browzer/<feat>/staging/acceptance/DOC_PATCHES.md
  └─ ## Patch log
      └─ ### Docs patched      ← Block 5
```

---

## Implementation notes for parsers

Reference regex set (Node ESM, ESLint-safe):

```js
export const BLOCK_REGEX = {
  filesModified:  /^- (\S+) \(\+(\d+)\/-(\d+)\)$/,
  filesCreated:   /^- (\S+) \(\+(\d+)\)$/,
  symbolsChanged: /^- (exported|internal) (function|method|type|const|var|interface|class|struct|enum) (\S+)::(\S+) (added|removed|signature-changed|semantics-changed)$/,
  testsAdded:     /^- (T-\d+) (\S+)::(\S+) (green|red|chaos) (\d+)\/(\d+)$/,
  docsPatched:    /^- (\S+) \(\+(\d+)\/-(\d+)\) cites:(\d+)$/,
  emptySentinel:  /^- \(none\)$/,
};
```

Parser semantics:

```
1. Find heading match (e.g. /^### Files modified$/m)
2. Read consecutive bullet lines until blank line or next heading
3. For each bullet:
   - If matches emptySentinel and is the only bullet → record empty
   - Else apply the block-specific regex
   - Bullets that fail BOTH the block regex and emptySentinel are dropped with a warning
4. If no heading found in expected section → emit malformed-report signal
```

---

## Versioning

This contract is at v1 as of 2026-05-12. Any future shape change MUST:

1. Bump the contract version in this header
2. Provide a migration path for in-flight features
3. Update every producer's `template.md` invariants block AND every consumer's parser regex set in the same PR
4. Add a regression test fixture in the plugin maintainer's regression suite (dev-only step — applies to @browzer/skills maintainers, not to plugin consumers)

Adding a NEW block is non-breaking; changing an existing block is breaking.
