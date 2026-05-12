---
name: code-review
description: "Post-implementation team review of a feature's diff. Spawns 4 mandatory agents in parallel — senior-engineer (cyclomatic complexity, DRY, clean code, best practices), software-architect (system design, race conditions, clean architecture, caching, performance), qa (regressions, edge cases, butterfly-effect breakage), regression-tester (runs scoped tests over modified files + their browzer deps) — plus domain specialists discovered via /find-skills. Every agent gets the diff + browzer deps (forward + reverse) + browzer mentions and may run browzer explore to detect prior art / duplication. Read-only — `receiving-code-review` applies fixes next. Triggers: code review, review this feature, audit my changes, review the diff, post-implementation review, team review, peer review, find issues in this PR."
argument-hint: "<featureId>"
---

You are a code-review fan-out controller. Spawn 4 mandatory agents in parallel, then aggregate.

## Read context

```
!`browzer get-step CODE_REVIEW --id $ARGUMENTS || { rc=$?; [ "$rc" = "2" ] && echo "(no prior CODE_REVIEW step — first run)" || exit "$rc"; }`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob includes the diff base, every modified file, forward + reverse deps via `browzer deps`, and `browzer mentions` reverse traversal. Pass the blob verbatim to each member as their prompt body.

## Pre-review — shared diff + dep snapshot (FR-8)

Before spawning any reviewer lanes, run the following once and persist results to `staging/REVIEW_CONTEXT.json`. This pre-computation is shared across all 4 reviewer lanes — do NOT let each lane run its own `git diff` or `browzer deps` independently, as that produces N redundant calls with potentially diverging results.

```bash
# 1. Resolve the merge-base once — this is the correct diff base for multi-commit branches
DIFF_BASE=$(git merge-base HEAD <main-branch>)

# 2. Capture the diff stat against the merge-base
git diff "${DIFF_BASE}"..HEAD --stat > /tmp/review-diff-stat.txt

# 3. Capture reverse deps for all changed files (NUL-separated to handle spaces in paths)
git diff --name-only -z "${DIFF_BASE}"..HEAD | while IFS= read -r -d '' F; do
  SANITIZED=$(echo "$F" | tr '/' '_')
  browzer deps "$F" --reverse --json --save "/tmp/rdeps-${SANITIZED}.json" 2>/dev/null || true
done
```

Write `docs/browzer/<feat>/staging/REVIEW_CONTEXT.json` with the shape:

```json
{
  "diffBase": "<resolved merge-base SHA from $DIFF_BASE>",
  "diffStat": "<contents of /tmp/review-diff-stat.txt>",
  "changedFiles": ["<file1>", "<file2>"],
  "reverseDepReceipts": {
    "<file1>": "/tmp/rdeps-<sanitized-file1>.json",
    "<file2>": "/tmp/rdeps-<sanitized-file2>.json"
  }
}
```

Pass the path `docs/browzer/<feat>/staging/REVIEW_CONTEXT.json` to each reviewer in their dispatch prompt so they read the pre-computed context instead of re-running `git diff` or `browzer deps`. Include this directive verbatim in every reviewer dispatch prompt:

> **Snapshot invariant**: the diff and dep receipts were pre-computed from the merge-base `<diffBase SHA>` and stored in `REVIEW_CONTEXT.json`. Do NOT re-run `git diff` or `browzer deps` independently — use the snapshot. Re-running produces redundant calls and may return diverging results if the branch advances.

## Pre-review — render blast radius (required)

Before classifying the diff, generate a Mermaid blast-radius diagram for every file touched in this diff. This step is **required**: the outcome (success or failure) MUST be recorded in `REVIEW_CONTEXT.json` before proceeding — do not skip silently.

The blast-radius dep graph is produced by an explorer subagent. Spawn it with `subagent_type: browzer:explorer` before running `render-dep-graph.mjs`:

```
browzer deps <changed files, one per line> --reverse --json
```

Pass the explorer's receipt paths to each reviewer in their dispatch prompt.

Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/skills/code-review/scripts/render-dep-graph.mjs" \
  --files "$(git diff --name-only $(git merge-base HEAD <main-branch>) HEAD | paste -sd, -)" \
  --out docs/browzer/$ARGUMENTS/staging/DEP_GRAPH.mmd
```

(`$CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin's installed root directory; falling back to `.` keeps the command runnable when invoking the script during local plugin development.)

**On success**: the diagram is written to `docs/browzer/<feat>/staging/DEP_GRAPH.mmd`. Update `REVIEW_CONTEXT.json` to include `"depGraph": "docs/browzer/<feat>/staging/DEP_GRAPH.mmd"`. Pass this path to each of the 4 reviewers in their dispatch prompt so they can read the visual blast radius without re-running `browzer deps`. Include the following directive **only when `DEP_GRAPH.mmd` exists**:

> Blast-radius diagram available at `docs/browzer/<feat>/staging/DEP_GRAPH.mmd` — read it for a Mermaid `graph LR` of reverse importers for all changed files.

**On failure** (script exits non-zero, output file does not exist, or `browzer deps` errors): record the failure in `REVIEW_CONTEXT.json` as:

```json
"depGraphError": "<reason: e.g. render-dep-graph.mjs exited 1, browzer deps returned exit 4, file not written>"
```

Omit the `DEP_GRAPH.mmd` reference from all reviewer dispatch prompts when the file is absent. Do NOT omit the `depGraphError` field — it is required when the step fails. Proceed to diff classification regardless of outcome.

## Diff classification

Before spawning reviewers, classify the diff with:

```sh
git diff $(git merge-base HEAD <main-branch>)..HEAD
```

### Sensitive-path override (FR-1)

**Order of evaluation: this predicate runs BEFORE any size or markdown-only heuristic.**

> Evaluate the predicate at `../../references/sensitive-paths.md` against the changed-files list (path globs) AND the diff content (token-introduction rules). The reference is the single source of truth — do not re-encode its rules here.

- **Predicate match ⇒ all 4 mandatory parallel reviewers (`senior-engineer`, `software-architect`, `qa`, `regression-tester`) dispatch in parallel.** These four lanes are NON-COLLAPSIBLE under this gate: they cannot be merged into a consolidator, cannot be skipped, and the markdown-only fast lane MUST NOT apply, regardless of diff size or file extension distribution.
- **Predicate no-match ⇒ existing fast-lane decision applies** (markdown-only fast lane below, otherwise standard lane).
- **Missing optional allowlist file**: `.browzer/sensitive-paths.json` is OPTIONAL. If the file does not exist, proceed with the built-in predicate only (no operator extension) — this is NOT an evaluation error and MUST NOT trigger fail-closed.
- **Fail-closed on evaluation error**: if the predicate cannot be evaluated for any reason (e.g. `.browzer/sensitive-paths.json` exists but is malformed/unreadable/parse-errors; `git diff --name-only` fails; reference file unavailable), default to running all 4 mandatory reviewers in parallel. Never silently fall through to the fast lane on predicate failure.

Record the predicate decision in the aggregated `CODE_REVIEW.json` under a `sensitivePathGate` field: `{ "matched": true|false, "matchedFiles": [...] }`. The `matched` flag and `matchedFiles` list are the canonical CUE contract; use prose notes in the enclosing section rather than a `reason` key (the schema does not carry a `reason` field on `sensitivePathGate`).

### Lane selection (only when sensitive-path predicate did NOT match)

**Markdown-only fast lane**: when 100% of changed files match `*.md` or `*.mdx` AND the total LOC delta is ≤50, route to a single-reviewer lane — one consolidator handling both senior-engineer and qa lenses. The regression-tester lane MAY be skipped when no `*.{ts,tsx,go,mjs,js,py}` change exists in the diff; when skipped, record `gate: "all changed files are markdown"` in `regressionEvidence`. The software-architect lane is also skipped. Return line: `code-review: <H> high, <M> medium, <L> low findings; gate=skipped`.

**Standard lane**: any diff that is not 100% markdown-only OR exceeds 50 LOC delta falls into the existing 4-reviewer fan-out (all mandatory members below). The regression-tester lane is **non-collapsible** for any standard-lane run — it must always run, cannot be skipped, and its output cannot be merged into another lane (it is the only lane producing independent empirical evidence).

## Mandatory members (all four every run)

| Agent | Lens |
| ----- | ---- |
| `senior-engineer` | cyclomatic complexity, DRY, clean code, naming, error paths |
| `software-architect` | system design, race conditions, clean architecture, caching, perf |
| `qa` | regressions, edge cases, butterfly-effect breakage |
| `regression-tester` | runs the scoped pre-push gate over modified files + their `browzer deps` |

Spawn each member with `subagent_type: browzer:code-reviewer`, `model: opus`, `effort: high`. Pass the assigned lens (senior-engineer / software-architect / qa / regression-tester) in the dispatch prompt prefix.

The regression-tester lane is **non-collapsible** — it must always run, cannot be skipped, and its output cannot be merged into another lane (it is the only lane producing independent empirical evidence). Plus: discover domain specialists via `find-skills` and add them as parallel members (e.g. `fastify-best-practices` for Fastify routes).

## Per-member output (parallel writes, no contention)

Each member writes its own file:

```
docs/browzer/<feat>/staging/CODE_REVIEW.<member-name>.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

`assignedSkill` is the canonical skill identifier responsible for fixing the finding (e.g. `fastify-best-practices`). Set to `null` when no matcher applies or the assignment is ambiguous. It is consumed downstream by `receiving-code-review` (to pick the fix dispatch skill) and by reporting/notification surfaces; reviewers may override an automated assignment.

Severity rule: `high` blocks the pipeline; `medium` requires recorded rationale to defer; `low` is informational.

## Reviewer brief — per-lane dispatch contract

Before spawning each reviewer lane, construct a deterministic **reviewer brief** and pass it verbatim as the dispatch prompt prefix. The brief MUST include all of the following fields — omitting any field is a contract violation:

```
REVIEWER BRIEF
  feature-id : <feat>
  lane        : <senior-engineer | software-architect | qa | regression-tester | <specialist>>
  diff-range  : <diffBase SHA>..<HEAD SHA>
  changed-files:
    - <file1>
    - <file2>
  browzer-deps-forward:
    - <files imported by changed files, from REVIEW_CONTEXT.json receipts>
  browzer-deps-reverse:
    - <files that import changed files (blast radius), from REVIEW_CONTEXT.json receipts>
  browzer-mentions:
    - <symbol/path cross-refs from `browzer mentions <changed-file>`, one entry per file>
  blast-radius-diagram: <path to DEP_GRAPH.mmd, or "unavailable — see depGraphError">
  scoped-invariants:
    - <invariant text from CLAUDE.md or project invariants that applies to at least one changed file>
  snapshot-path: <path to docs/browzer/<feat>/staging/REVIEW_CONTEXT.json>
```

**Snapshot invariant directive** (append verbatim to every brief):

> Snapshot invariant: the diff and dep receipts were pre-computed from the merge-base `<diffBase SHA>` and stored in `REVIEW_CONTEXT.json`. Do NOT re-run `git diff` or `browzer deps` independently — use the snapshot. Re-running produces redundant calls and may return diverging results if the branch advances.

The brief is constructed once from `REVIEW_CONTEXT.json` (written in the pre-review phase) and stamped into each parallel dispatch. Domain specialists discovered via `find-skills` receive the same brief shape with their skill name in the `lane` field.

## Aggregator (final step)

After all members return, merge into the canonical file:

```
docs/browzer/<feat>/staging/CODE_REVIEW.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body. Any field not present in `template.md` is dropped on save.

### Preserve-all integrity algorithm

The aggregator MUST implement the following algorithm exactly — no dedup, no severity rollup that drops items:

1. **Collect** every `findings[]` array from every `CODE_REVIEW.<member>.json` (mandatory lanes: `senior-engineer`, `software-architect`, `qa`, `regression-tester`; plus any domain-specialist files).
2. **Assign stable IDs** to each finding using the member prefix:
   - `senior-engineer` findings → `SR-1`, `SR-2`, …
   - `software-architect` findings → `ARCH-1`, `ARCH-2`, …
   - `qa` findings → `QA-1`, `QA-2`, …
   - `regression-tester` findings → `REG-1`, `REG-2`, …
   - Specialist findings → `F-1`, `F-2`, … (continuing from the highest `F-N` already assigned)
3. **Merge** all findings into a single `findings[]` array in the consolidated `CODE_REVIEW.json`. Reassign each finding a global sequential id (`F-1`, `F-2`, …) for the consolidated file.
4. **Cross-reference duplicates** — when two or more reviewers raise findings on the same file+line, keep ALL of them. Record cross-references in `findings[].mergedFrom[]` using the per-member ids from step 2 (e.g. `["SR-3", "QA-1"]`). The `mergedFrom` field is additive: it marks that multiple lanes raised the same concern, not that any finding was dropped.
5. **Never drop**: a finding may ONLY be omitted if the per-member source file is absent (record the missing file in the aggregated step's `notes` field) or explicitly marked `status: "wontfix"` by the reviewer. Severity rollup (e.g. keeping only the highest-severity duplicate) is forbidden — severity is informational, not a dedup key.
6. **Populate `severityCounts`** from the merged list after all findings are collected.
7. **Preserve `regressionRun`** from the `regression-tester` per-member file verbatim — do not merge or average it with other lanes.

This algorithm is implemented by `browzer codereview aggregate --feat <feat-id>`. Invoke it after all member files are written; the CLI handles dedup, ID assignment, and severityCounts.

The autosave hook (PostToolUse Write hook on `docs/browzer/<feat>/staging/`) validates `CODE_REVIEW.json` against the workflow schema and persists it into `workflow.json`. Per-member files are scratch and ignored by the hook.

## Persistence

The autosave hook persists `staging/CODE_REVIEW.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — CODE_REVIEW is load-bearing: `receiving-code-review` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- Every mandatory member produced its `CODE_REVIEW.<member>.json`.
- The aggregated `CODE_REVIEW.json` exists.
- `CODE_REVIEW.json` contains a top-level `sensitivePathGate` field with shape `{ "matched": boolean, "matchedFiles": string[] }` (CUE: `#SensitivePathGate`). The phase FAILS if this field is absent. Preserve fail-closed behavior: when the predicate cannot be evaluated for any reason, set `matched: true` and populate `matchedFiles` with all changed files — never leave the field absent on evaluation error. Record the rule that fired or the evaluation error as prose in an adjacent notes field or in the structured `notes` top-level field of the step.
- Optional `gate` and `exitCode` fields: after consolidation, set `codeReview.gate` to one of `"fail-on-high" | "fail-on-medium-or-high" | "advisory-only"` (or omit / `null` if no automated gate policy applies) and set `codeReview.exitCode` to the integer exit code of the gate check (or `null` if not yet run). These fields drive automated merge/block logic in `receiving-code-review`.
- The regression-tester evidence block is populated (even if the gate is empty, record `gate: "<no-op reason>"`). Angle brackets are placeholders, not literal — the value is a free-form string explaining why no gate ran. Prefer one of these canonical reasons when applicable: `"no tests available"`, `"language not supported"`, `"manual skip"`. Custom reasons are acceptable when none fits (e.g. `"all changed files are markdown"`).

Return one line on stdout as the final line of the run: `code-review: <H> high, <M> medium, <L> low findings; gate=<exitCode>`. This is consumed by the orchestrator/parser to determine pass/fail and is emitted in addition to the structured JSON output (the JSON is unchanged). Implementations MAY also write the same line to a status file when `SKILL_STATUS_PATH` is set.

Your turn is incomplete until `docs/browzer/<feat>/staging/CODE_REVIEW.json` exists on disk. Do not stop to summarize or investigate further after writing it.
