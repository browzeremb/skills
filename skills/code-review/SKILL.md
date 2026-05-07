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

## Pre-review — render blast radius

Before classifying the diff, generate a Mermaid blast-radius diagram for every file touched in this diff. This step is **best-effort**: if the script fails for any reason, continue to the next section — do not block the review.

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/skills/code-review/scripts/render-dep-graph.mjs" \
  --files "$(git diff --name-only $(git merge-base HEAD <main-branch>) HEAD | paste -sd, -)" \
  --out docs/browzer/$ARGUMENTS/staging/DEP_GRAPH.mmd
```

(`$CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin's installed root directory; falling back to `.` keeps the command runnable when invoking the script during local plugin development.)

On success, the diagram is written to `docs/browzer/<feat>/staging/DEP_GRAPH.mmd`. Pass this path to each of the 4 reviewers in their dispatch prompt so they can read the visual blast radius without re-running `browzer deps`. Example addition to each reviewer brief:

> Blast-radius diagram available at `docs/browzer/<feat>/staging/DEP_GRAPH.mmd` — read it for a Mermaid `graph LR` of reverse importers for all changed files.

If the script exits non-zero or the output file does not exist, omit the reference from reviewer briefs and proceed normally.

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

Record the predicate decision in the aggregated `CODE_REVIEW.json` under a `sensitivePathGate` field: `{ "matched": true|false, "matchedFiles": [...], "reason": "<predicate-rule-that-fired>" | "<eval-error-detail>" }`.

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

The regression-tester lane is **non-collapsible** — it must always run, cannot be skipped, and its output cannot be merged into another lane (it is the only lane producing independent empirical evidence). Plus: discover domain specialists via `find-skills` and add them as parallel members (e.g. `fastify-best-practices` for Fastify routes).

## Per-member output (parallel writes, no contention)

Each member writes its own file:

```
docs/browzer/<feat>/staging/CODE_REVIEW.<member-name>.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

`assignedSkill` is the canonical skill identifier responsible for fixing the finding (e.g. `fastify-best-practices`). Set to `null` when no matcher applies or the assignment is ambiguous. It is consumed downstream by `receiving-code-review` (to pick the fix dispatch skill) and by reporting/notification surfaces; reviewers may override an automated assignment.

Severity rule: `high` blocks the pipeline; `medium` requires recorded rationale to defer; `low` is informational.

## Aggregator (final step)

After all members return, merge into the canonical file:

```
docs/browzer/<feat>/staging/CODE_REVIEW.json
```

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body. Any field not present in `template.md` is dropped on save.

The autosave hook (PostToolUse Write hook on `docs/browzer/<feat>/staging/`) validates `CODE_REVIEW.json` against the workflow schema and persists it into `workflow.json`. Per-member files are scratch and ignored by the hook.

## Persistence

The autosave hook persists `staging/CODE_REVIEW.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — CODE_REVIEW is load-bearing: `receiving-code-review` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- Every mandatory member produced its `CODE_REVIEW.<member>.json`.
- The aggregated `CODE_REVIEW.json` exists.
- The regression-tester evidence block is populated (even if the gate is empty, record `gate: "<no-op reason>"`). Angle brackets are placeholders, not literal — the value is a free-form string explaining why no gate ran. Prefer one of these canonical reasons when applicable: `"no tests available"`, `"language not supported"`, `"manual skip"`. Custom reasons are acceptable when none fits (e.g. `"all changed files are markdown"`).

Return one line on stdout as the final line of the run: `code-review: <H> high, <M> medium, <L> low findings; gate=<exitCode>`. This is consumed by the orchestrator/parser to determine pass/fail and is emitted in addition to the structured JSON output (the JSON is unchanged). Implementations MAY also write the same line to a status file when `SKILL_STATUS_PATH` is set.
