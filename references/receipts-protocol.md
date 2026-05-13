# Receipts protocol — `RECEIPTS.md` append contract

> **Applicability** — cross-skill. Every phase-skill that records discovery
> queries, decisions, or dispatch outcomes for downstream auditing MUST
> follow this protocol. Eliminates per-skill drift across the multiple
> `append-receipts.mjs` copies and guarantees idempotent re-runs.

`docs/browzer/<feat>/RECEIPTS.md` is a single append-only ledger written by
every phase. Skills MUST NOT delete or rewrite prior phase sections. Skills
SHOULD re-run their own section idempotently (re-running produces exactly one
copy of the section, not duplicates).

---

## Canonical section shape

Every phase emits exactly one top-level `## <phase>` section, bounded by
sentinel HTML comments. The bounded body lives entirely inside.

```markdown
<!-- receipts:<phase>:BEGIN -->
## <phase>

- **Phase**: <phase-name>
- **Producer**: <skill-name>
- **Generated**: <RFC3339 timestamp>
- **Run id**: <short uuid or hash>

<phase-specific sub-sections>

<!-- receipts:<phase>:END -->
```

Where `<phase>` is the canonical phase name in lowercase-hyphenated form:
`brainstorming` · `generate-prd` · `scope-feature` · `generate-task` ·
`execute-task` · `code-review` · `receiving-code-review` · `write-tests` ·
`update-docs` · `feature-acceptance` · `finalize-feature` · `commit`.

**Sentinel regex (canonical):**

```
^<!-- receipts:([a-z][a-z0-9-]*):BEGIN -->$
^<!-- receipts:([a-z][a-z0-9-]*):END -->$
```

The matching `<phase>` MUST be identical on both sentinels of a pair.

---

## Idempotency contract

Re-running an `append-receipts.mjs` for a phase MUST produce **exactly one**
`receipts:<phase>:BEGIN`/`:END` pair after the run, regardless of how many
times it has run before. The algorithm:

```
1. Read RECEIPTS.md (treat missing as empty).
2. Compute regex `receipts:<phase>:BEGIN` … `receipts:<phase>:END` (multiline, dotall).
3. If the regex matches → splice it out, retaining text before + after.
4. Render the new section body.
5. Concatenate: <pre-section text> + <newline if needed> + <new section> + <post-section text>.
6. Write atomically (rename-from-tmp).
```

**Pitfall (avoided):** never use sentinel-less `## <Section>` headings to find
your section — those collide with sub-sections inside other phases and with
operator notes. Use the BEGIN/END HTML comment pair only.

---

## Sub-section shapes by phase

Each phase has a fixed set of allowed sub-sections. Producers MAY emit a subset
(empty sub-sections allowed; missing ones implicit-empty); consumers MUST NOT
fail on unexpected order. Consumers MAY warn on unknown sub-section names.

### `brainstorming`

| Sub-section | Shape |
|---|---|
| `### Research queries` | Markdown table: `tool` · `query` · `result-summary` |
| `### Clarifications asked` | Bulleted list of operator-facing questions |

### `generate-prd`

| Sub-section | Shape |
|---|---|
| `### Grounding queries` | Markdown table: `kind (ask\|search\|explore)` · `query` · `receipts-path` |
| `### Search-trigger proposals` | Bulleted list with vocabulary table reference |

### `scope-feature`

| Sub-section | Shape |
|---|---|
| `### Scope queries` | Markdown table: `tool` · `query` · `receipts-path` |
| `### Blast-radius receipts` | Markdown table: `file` · `forwardDeps-count` · `reverseDeps-count` · `receipts-path` |
| `### Skills found` | Markdown table: `domain` · `skill` · `relevance` · `discoveredFrom` |

### `generate-task`

| Sub-section | Shape |
|---|---|
| `### Decomposition queries` | Markdown table: `query` · `receipts-path` |
| `### Suppressed candidates` | Markdown table: `candidate-title` · `candidate-scope` · `reason` |
| `### Granularity flags` | Markdown table: `taskId` · `verdict (split\|merge\|ok)` · `rationale` |

### `execute-task`

| Sub-section | Shape |
|---|---|
| `### Task outcomes` | Markdown table: `taskId` · `status (completed\|failed)` · `subagent` · `model` · `effort` · `elapsedMin` |
| `### Failures` | Bulleted list: per `.failed.md`, one line `<taskId> — <truncated-reason>` |

### `code-review`

| Sub-section | Shape |
|---|---|
| `### Lane dispatches` | Markdown table: `lane` · `subagent` · `model` · `elapsedMin` · `findings-count` |
| `### Severity counts` | Inline list `high: N` · `medium: M` · `low: L` · `orphan: O` |
| `### Sensitive-path gate` | `matched: true\|false` · `matchedFiles[]` list |

### `receiving-code-review`

| Sub-section | Shape |
|---|---|
| `### Fix outcomes` | Markdown table: `findingId` · `status (fixed\|tech_debt)` · `ladder-steps-used` · `model-at-success` · `elapsedMin` |
| `### Tech-debt findings` | Bulleted list: per `.tech_debt.md`, one line `<findingId> [<severity>] — <truncated-rationale>` |

### `write-tests`

| Sub-section | Shape |
|---|---|
| `### Test outcomes` | Markdown table: `testSpecId` · `testId` · `file` · `intent` · `mutation-kill-rate` |
| `### Coverage gaps` | Bulleted list: per coverage gap, one line `<file>::<symbol> — <reason>` |

### `update-docs`

| Sub-section | Shape |
|---|---|
| `### Discovery queries` | Markdown table: `tool` · `query` · `receipts-path` |
| `### Patch outcomes` | Markdown table: `doc-path` · `lines-added` · `lines-removed` · `citation-count` · `applied (true\|false)` |
| `### Skipped (no public surface)` | Inline line: `(no exported-symbol changes — skipped)` OR omit when patches applied |

### `feature-acceptance`

| Sub-section | Shape |
|---|---|
| `### Verdict` | Inline line: `verdict: accepted\|rejected\|partial` · `mode: <chosen-mode>` |
| `### AC verdicts` | Markdown table: `acId` · `pass\|fail\|deferred` · `evidence-path-or-(manual)` |
| `### NFR verdicts` | Markdown table: `nfrId` · `target` · `observed` · `pass\|fail\|deferred` |
| `### Metric baselines` | Markdown table: `metricId` · `baseline` · `observed` · `delta` |
| `### Commands run` | Bulleted list of host commands invoked (with truncated stdout digest) |

### `finalize-feature`

| Sub-section | Shape |
|---|---|
| `### Inputs read` | Bulleted list of `docs/browzer/<feat>/*` paths consumed |
| `### Sections rendered` | Bulleted list of README.md headings produced |

### `commit`

| Sub-section | Shape |
|---|---|
| `### Commit` | Inline line: `sha: <sha>` · `branch: <name>` · `trailer: on-behalf-of: @<org>` |
| `### Files committed` | Bulleted list of paths staged into the commit |
| `### Veto checks` | Markdown table: `gate` · `pass\|fail` · `evidence` |

---

## Dual-tmpdir scan rule

Producer scripts that aggregate `/tmp/<phase>-*.json` discovery receipts MUST
scan **both** `os.tmpdir()` AND `/tmp` (the literal path). macOS sets
`$TMPDIR` to `/var/folders/<...>/T/`, which differs from `/tmp` — a Bash
snippet that writes to `/tmp/foo.json` is invisible to a Node script that
reads `os.tmpdir()` alone (and vice versa). The accepted pattern:

```js
import { tmpdir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCAN_ROOTS = [tmpdir(), '/tmp'];
const seen = new Set();
const receipts = [];

for (const root of SCAN_ROOTS) {
  let entries;
  try { entries = readdirSync(root); } catch { continue; }
  for (const e of entries) {
    if (!/^<phase>-[a-z0-9-]+\.json$/.test(e)) continue;
    const full = join(root, e);
    if (seen.has(e)) continue; // de-dup by basename across roots
    seen.add(e);
    try { receipts.push({ path: full, mtime: statSync(full).mtimeMs }); }
    catch {}
  }
}
```

**De-dup rule**: basename collision wins the first-found-by-mtime tie. This
matters when an operator re-runs a phase: the newer `/tmp/<phase>-foo.json`
shadows the stale `os.tmpdir()` copy.

---

## Atomic write contract

`RECEIPTS.md` writes use rename-from-tmp on the same filesystem to guarantee
crash safety:

```js
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, basename } from 'node:path';

function atomicWrite(path, content) {
  const dir = dirname(path);
  const base = basename(path);
  const tmp = join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
```

Producer scripts MUST use this pattern, not a direct `writeFileSync(path,
content)`. A SIGKILL between `writeFileSync` truncation and refill leaves
RECEIPTS.md zero-bytes; rename-from-tmp avoids that window.

---

## Recommended script entrypoint

Every phase's `scripts/append-receipts.mjs` exposes the same CLI:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs <featureId>
```

With exit codes:

| Code | Meaning |
|---|---|
| 0 | Section appended / replaced successfully |
| 1 | Generic failure (write error, fs error) |
| 2 | `docs/browzer/<featureId>/` not found |
| 3 | RECEIPTS.md exists but is malformed (sentinel pair mismatch) |

`--dry-run` flag prints the rendered section to stdout without writing.
`--json` flag prints `{ phase, featureId, action: "appended"|"replaced", bytes: N }`.

---

## Receipts shape stability

This contract is at v1 as of 2026-05-12. Adding a NEW sub-section name to a
phase is non-breaking. Renaming or removing an existing sub-section is
breaking and MUST coordinate with consumers (`finalize-feature` and the
`judge-skill-runs` skill are the primary downstream readers).
