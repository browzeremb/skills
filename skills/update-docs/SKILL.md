---
name: update-docs
description: "Find every markdown doc whose accuracy depends on the just-changed code and patch it in place. Smart skip when no exported-symbol changes. Two phases: Phase A spawns an explorer subagent that runs browzer mentions / deps --reverse / explore / search over changed files and saves JSON receipts; Phase B reads receipts and patches docs via the doc-writer subagent. Patches existing docs only — never writes new ones. Triggers: update the docs, sync the documentation, docs are stale, refresh the README, propagate changes to docs."
argument-hint: "<featureId>"
---

You are a docs-sync controller. Patch existing docs that drifted because
of this feature's exported-symbol changes. Never create new docs.

## Exclusive ownership of doc patches

`update-docs` is the **single owner** of every doc patch produced by
the workflow. Coder subagents under `execute-task` and fixer subagents
under `receiving-code-review` MUST NOT edit doc files (`*.md`, `*.mdx`,
`*.rst`, etc.) — their scope is source code only. When the operator's
brief contains explicit doc-only changes (e.g. "update README to reflect
the new flag"), `generate-task` decomposes those into a single
docs-bucket task whose execution is no-op (the task is suppressed via
the canonical-phase suppression filter and routed to this skill).

This rule exists because doc-sync work spread across multiple phases
produces duplicated edits and drift. Operator-observed: in a typical
session, the same `CLAUDE.md` family was patched under `TASK_04`, then
re-patched under `FIX_F-002`, then re-patched again under `FIX_F-015`,
then once more by `update-docs`. Concentrating ownership here cuts
~15 k tokens of rework per session.

## Two passes — one after write-tests, one as the chain's last drift-catcher

When `update-docs` is dispatched by `orchestrate-task-delivery`, it
runs TWICE per chain:

1. **Primary pass** (after `write-tests`, before `feature-acceptance`)
   — handles drift introduced by `execute-task` + `receiving-code-review`.
2. **Final drift-catch pass** (after `feature-acceptance` accepts, before
   `finalize-feature`) — handles drift introduced by the fixer wave
   *after* the primary pass landed. Skipped silently when the chain's
   delta over the primary pass produces no new `### Symbols changed`
   entries with `scope == exported`.

The orchestrator's state machine drives both invocations; this skill
itself does not loop. See
`${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md` for the canonical
phase order.

## Inputs

- `$ARGUMENTS` is the `<featureId>`.
- This skill reads:
  - `docs/browzer/<feat>/staging/TASK_*.completed.md` body `### Files modified` / `### Files created` / `### Symbols changed`
  - `docs/browzer/<feat>/staging/FIX_*.completed.md` body — same three blocks
  - The host's existing markdown tree under `docs/` (read by the explorer subagent via `browzer mentions / deps / explore / search`)

Does NOT read PRD.md or EXPLORATION.md — closure cross-file.

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/DOC_PATCHES.md` | aggregate frontmatter + body (Phase A writes frontmatter; Phase B fills body and applied flags) |
| `docs/browzer/<feat>/staging/RECEIPTS.md` (append) | `## update-docs` section |
| (host markdown docs) | patched in-place via Edit |

Frontmatter shape in `${CLAUDE_SKILL_DIR}/template.md`.

## Preflight — Skip rule (cost optimization)

Before dispatching the discovery subagent, glob upstream
`TASK_*.completed.md` + `FIX_*.completed.md` and parse their
`### Symbols changed` blocks per
`${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md`.

**Skip discovery entirely when:**

- Every `Symbols changed` block resolves to `(none)` OR
- Every entry has `scope == internal` (no public surface to drift)

When skipping, write DOC_PATCHES.md with:

```yaml
phase: B
skipped: true
skipReason: "no exported-symbol changes in upstream phases — no public surface drift"
candidateDocs: []
docsPatched: []
summary: { candidatesConsidered: 0, patchesApplied: 0, enoentFixed: 0 }
enoentScan: { ran: false, filesScanned: [], brokenCommandsFound: 0, brokenCommandsFixed: 0 }
```

Then append RECEIPTS.md and return `update-docs: skipped (no public surface drift)`. This avoids the ~30s discovery dispatch cost.

## Workflow (when not skipping)

## Phase A — Discovery dispatch

Spawn ONE explorer subagent:

```
Agent(
  subagent_type: "browzer:explorer",
  model: haiku,
  effort: medium,
  prompt: <composed>,
)
```

Compose the prompt using the compact dispatch template at
`${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` (NOT a
verbatim paste-include of `subagent-preamble.md`). Substitute
placeholders:

- `{{role}}` = `read-only discovery explorer`
- `{{skills}}` = empty array (the explorer needs no skill loads)
- `{{files}}` = the union of `### Files modified` + `### Files created` paths from upstream phases
- `{{out-of-scope}}` = every path NOT in `{{files}}`

Then append this task body:

> Run all four discovery signals over the host's existing markdown docs. For EACH `### Symbols changed` symbol with `scope == exported`:
>
> 1. `browzer mentions <symbol-id> --save /tmp/update-docs-<featureId>-mentions-<slug>.json`
>
> For EACH `### Files modified` / `### Files created` path:
>
> 2. `browzer deps <file> --reverse --json --save /tmp/update-docs-<featureId>-deps-<slug>.json`
>
> For EACH concept keyword implied by the changes (extract 1-3 keywords from each symbol's `dottedName`):
>
> 3. `browzer explore "<concept>" --save /tmp/update-docs-<featureId>-explore-<concept>.json`
> 4. `browzer search "<concept>" --save /tmp/update-docs-<featureId>-search-<concept>.json`
>
> **Filename pattern is REQUIRED**: every receipt MUST match `^update-docs-${featureId}-[a-z0-9-]+\.json$`. Files outside this pattern are dropped by the aggregator.
>
> Filter receipts: keep only docs found that end in `.md` or `.mdx` AND exist on disk.
>
> Return ONE line: `discovery: <N> candidate docs found; receipts: <comma-separated paths>`
>
> Cap: 60 seconds wall-clock. If exceeded, return whatever receipts arrived.

Wait for the subagent's return. Extract receipt paths.

Write a Phase-A DOC_PATCHES.md with `phase: A` frontmatter and the
discovered `candidateDocs[]` (each entry's `applied: false` initially).
Body section is empty in Phase A.

## Phase B — Patch dispatch

Spawn the doc-writer subagent:

```
Agent(
  subagent_type: "browzer:doc-writer",
  model: sonnet,
  effort: medium,
  prompt: <composed>,
)
```

Compose the prompt using the compact dispatch template at
`${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`, then
layer the `code-subagent.md` addendum below the invariants block (NOT a
verbatim paste-include of either file). Substitute placeholders:

- `{{role}}` = `documentation patcher`
- `{{skills}}` = empty array (doc patches rarely require domain skill loads)
- `{{files}}` = every `candidateDocs[].docPath` from Phase A
- `{{out-of-scope}}` = every source file under `apps/` / `packages/` / `src/` (doc-writer NEVER edits source)

Then append this task body:

- Inlined `candidateDocs[]` from Phase A
- Inlined `### Symbols changed` block from upstream (all exported entries)
- Instruction: for each candidate, determine if the doc references a changed symbol; if yes, patch via the Edit tool; if no, mark `applied: false` with a `appliedReason`.
- ENOENT scan instruction: per `${CLAUDE_SKILL_DIR}/references/enoent-scan.md`, scan every patched doc's `bash`/`sh` fenced blocks for broken commands.
- Output instruction: write a structured summary to `/tmp/update-docs-${featureId}-patch-summary.json` with `docsPatched[]` + `enoentScan{}`.

After the doc-writer returns, rewrite DOC_PATCHES.md with `phase: B`:

- Flip `candidateDocs[].applied` per the patch summary
- Populate `docsPatched[]`
- Populate `summary.{patchesApplied, enoentFixed}` counters
- Populate `enoentScan{}`
- Compose the body with the `### Docs patched` block (Block 5 regex per markdown-chain-output-contract), the patch summary paragraph per doc, and skipped-candidates/enoent sub-sections as appropriate.

### Step 3 — Append receipts

```bash
node "${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs" "$ARGUMENTS"
```

## Done when

- DOC_PATCHES.md exists with `phase: B` (terminal).
- Every `docsPatched[].docPath` was edited on disk (verify by re-reading).
- `summary.patchesApplied == docsPatched.length` AND `summary.candidatesConsidered == candidateDocs.length`.
- RECEIPTS.md has exactly one `## update-docs` section.
- Return line: `update-docs: <patched> patched, <considered> considered, <enoent> ENOENT fixes` OR `update-docs: skipped (no public surface drift)`.

## References

- `${CLAUDE_SKILL_DIR}/references/three-signals.md` — discovery signal heuristics (legacy ref, still useful for the explorer prompt)
- `${CLAUDE_SKILL_DIR}/references/enoent-scan.md` — ENOENT broken-command scan procedure
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer (substitute, do not paste)
- `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` — code-edit role addendum (Phase B); referenced by path, not paste-included
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (NOT paste-included by dispatchers; consult when authoring)
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — `### Docs patched` Block 5 regex; reads `### Symbols changed` upstream
- `${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md` — RECEIPTS.md contract
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — folder map + staging-folder discipline
- `${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md` — when update-docs runs (twice — primary + final drift-catch)
