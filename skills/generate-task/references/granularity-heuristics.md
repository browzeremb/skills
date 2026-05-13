# Granularity heuristics — split / collapse / ok

generate-task's Reviewer flags each candidate task with a `granularityNote.verdict`. The flag is **advisory** — operator and execute-task may proceed even on flagged tasks — but it surfaces decomposition decisions for visibility.

## Verdict reference

| Verdict | When to use | What execute-task does |
|---|---|---|
| `ok` | Default. Task scope is well-shaped. | Proceeds normally. |
| `split` | Scope exceeds soft limits (>10 files OR >2 distinct conceptual surfaces). | Proceeds; operator may decide to re-decompose. |
| `collapse` | Scope is too small (<2 files) AND another similarly-shaped task exists. | Proceeds; operator may merge before dispatching. |
| `premature` | A signal suggests the task was somehow pre-completed (e.g. all files in scope already implement the AC). | Operator MUST verify before execute-task runs. |

The Reviewer always populates this field — even when `verdict: ok` — so downstream consumers don't have to handle a missing key.

## Heuristics

### Split (>10 files)

A single domain bucket with >10 likelyFiles often indicates either:

- The PRD's intent spans multiple sub-surfaces of one app (e.g. `apps/api` touches both `routes/` and `consumers/`). Split into two tasks with `dependsOn[]` if ordering matters.
- The bucket was over-collected by scope-feature (stale index hits, false positives). Filter unrelated files before deciding.
- The feature is genuinely large and should be split into smaller PRs. Surface to the operator via `granularityNote.rationale`.

Threshold guidance: prefer `verdict: split` when files cluster into ≥2 disjoint sub-trees AND the conceptual purpose differs (handlers vs migrations, vs both touching the same endpoint).

### Collapse (<2 files)

A single-file task is usually a sign of:

- A genuine micro-task (e.g. "update CHANGELOG") — leave as-is, mark `verdict: collapse, rationale: "intentional micro-scope"`.
- A bucket that scope-feature spuriously isolated. Check if another task touches an adjacent file; if so, suggest merge in the rationale.
- A boilerplate task that duplicates a canonical phase (write-tests, update-docs). Suppress instead — see `task-decomposition.md`.

When two adjacent tasks would both have `<2` files AND share a domain prefix, prefer collapsing at decomposition time rather than emitting both with `verdict: collapse`.

### Premature completion

Set `verdict: premature` when:

- Every file in `scope.files[]` already contains the implementation the AC describes (the diff would be no-op).
- The Reviewer detects that an earlier task (already emitted) covers the same surface.
- The PRD's AC is satisfied by existing code without modification (the PRD over-claimed scope).

`premature` is rare but important. It blocks accidental re-implementation and signals operator-level scope adjustment. Always include a verbose `rationale` with file references.

## Per-task field, not manifest-level

In the old (workflow.json) world, `granularityWarnings[]` lived on the TASKS_MANIFEST as a top-level array. In the markdown-chains world, each verdict lives on the task it concerns — per-task `granularityNote` in TASK_NN.md frontmatter.

Why:

- Per-task fields are easier to read alongside the rest of the task's data.
- No drift bait — the verdict travels with the task across moves/renames.
- The aggregate view (orchestrator inspection) is still cheap: glob TASK_*.md and read frontmatter.

When the orchestrator (or operator) wants a manifest view of all granularity flags, `render-task-graph.mjs` includes a summary table at the top of `TASK_GRAPH.md` body listing every non-`ok` verdict.

## Anti-patterns

- **`verdict: ok` with no rationale** when the task has obvious issues (>15 files, sensitive surface, etc.) — always rationalize non-trivial verdicts.
- **`verdict: split` without proposed split lines** — if you flag split, name the two surfaces you'd cut along, so the operator can act without re-deriving.
- **Cascading `collapse` across unrelated buckets** — never merge tasks across domain bucket boundaries to reach `2+ files`; the bucket boundary is the load-bearing invariant.
- **`verdict: premature` based on a single file** — verify across the whole scope before flagging; a single already-implemented file is normal and not premature.

## When to skip

If the Reviewer is confident the task is well-shaped, the simplest valid value is:

```yaml
granularityNote:
  verdict: ok
  rationale: "Domain bucket within typical range."
```

`granularityNote` MUST be present (even when ok). Downstream consumers expect the key.
