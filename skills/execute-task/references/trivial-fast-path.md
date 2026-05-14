# Trivial fast-path — when `execute-task` skips subagent dispatch

The fast-path lets `execute-task` perform the edits inline in its own thread
instead of dispatching `browzer:coder`. It saves the subagent-spawn overhead
and the model handoff for micro-tasks where the subagent's added discipline
brings no marginal value.

## Gate — AND of four signals

All four MUST hold for the same task. ANY single failure forces the full
subagent dispatch.

| # | Signal | Why it gates |
|---|---|---|
| 1 | `task.trivial: true` | Reviewer's explicit opt-in. Without it, no fast-path even if the rest qualifies. |
| 2 | `task.scope.files[].length ≤ 2` | Two files is the empirical ceiling where inline editing stays auditable. |
| 3 | `task.invariants[]` is empty, OR every entry carries the `INVARIANT_RATIONALE:` sentinel prefix. | This is the **closure-safe proxy** for "no sensitive scope touched". execute-task cannot read EXPLORATION.md (closure principle), so it cannot consult `sensitiveScopeHits[]` directly. `generate-task` is contractually required to populate non-empty `invariants[]` (real or `INVARIANT_RATIONALE:` sentinel) for every task whose scope intersects a sensitive hit; the absence of real invariants is therefore the in-file evidence that no sensitive surface applies. |
| 4 | `task.skillsFound[]` is empty AND every `task.scope.files[].blastRadius.reverse[]` is empty | No domain expertise needed AND no external callers to break. |

`execute-task` computes all four programmatically from `TASK_NN.md`
frontmatter — no LLM judgement. The Reviewer's only job upstream is to set
`task.trivial: true` accurately AND populate `invariants[]` correctly when
sensitive scope applies; the other gates are derived. If `generate-task`
upstream forgot to populate invariants on a sensitive task, the fast-path
would incorrectly fire — that is a `generate-task` bug, not an execute-task
one, and should be surfaced as a `granularityNote` regression at the
planning phase.

## What the fast-path does

```
1. Stamp Started.
2. Edit each file in task.scope.files[] using the Edit / Write tool inline.
3. For every task.invariants[] rule:
     - If it carries the INVARIANT_RATIONALE: sentinel prefix, record SKIPPED-SENTINEL.
     - Otherwise re-read the affected scope.files and verify the rule still holds.
4. Stamp Completed.
5. mv TASK_NN.md → TASK_NN.completed.md, append `## Execution log` body section
   with an `## Inline execution` block (NOT a `## Subagent report` block).
```

The execution-log shape is identical to the dispatched path — the consumer
(`code-review`, `feature-acceptance`, `finalize-feature` Phase A) cannot tell them apart by
reading the log. The only structural difference is which sub-section appears
under `## Execution log`:

| Path | Sub-section name | Captures |
|---|---|---|
| Dispatched | `### Subagent report` | Verbatim report from `browzer:coder` |
| Inline (fast-path) | `### Inline execution` | Files modified, invariants checked, optional one-paragraph rationale |

## Anti-patterns

The fast-path is conservative by construction. If you find yourself wishing
the gate were laxer, the answer is almost always to dispatch the subagent —
not to widen the gate. Specifically:

- **"It's only 3 files but they're tiny"** — gate #2 is empirical, not file-size
  weighted. Three files = dispatch.
- **"`invariants[]` is non-empty but all entries are `INVARIANT_RATIONALE:`
  sentinels"** — gate #3 holds (sentinels do not count as real invariants).
  If gates 1, 2, and 4 also hold, the fast-path fires. The sentinel record
  is preserved in the execution log under `### Invariants checked`.
- **"`blastRadius.reverse[]` has one entry, just a test file"** — gate #4 is
  binary. One reverse importer = dispatch. The fast-path cannot reason about
  whether breaking that importer is acceptable.

## Retry semantics for `.failed.md`

When a task ends in `TASK_NN.failed.md`, the next `/execute-task <featureId>
<taskId>` invocation does NOT rename the file back to `TASK_NN.md`. Instead:

1. The existing `.failed.md` body is read.
2. The next attempt runs (dispatched or fast-path per the same gate).
3. On failure: append a `## Retry attempt N` section to the existing
   `.failed.md` body and exit. The frontmatter is untouched.
4. On success: `mv TASK_NN.failed.md → TASK_NN.completed.md`, then append the
   final `## Execution log` section. The prior `## Retry attempt N` blocks
   travel with the rename, preserving the history of failed attempts.

`N` is computed by counting existing `## Retry attempt` headings in the body
PLUS TWO. The `+2` (not `+1`) is intentional: the initial failure is
implicitly attempt 1 — it lives under the file's `## Execution log` section,
not under a `## Retry attempt 1` heading. So the first re-run writes
`## Retry attempt 2` (count was 0); the second writes `## Retry attempt 3`
(count was 1).

## Examples

> Examples below use placeholder names (`<api-app>`, `<auth-app>`, etc.)
> — substitute your host repo's actual app/package layout. The rules
> are layout-agnostic.

### Example 1 — fast-path qualifying task

```yaml
taskId: TASK_03
title: "Update README rate-limit section"
trivial: true
scope:
  files:
    - path: <api-app>/README.md
      blastRadius:
        forward: [...]
        reverse: []         # no reverse importers
        reverseCount: 0
invariants: []
skillsFound: []             # no domain expertise needed
```

All four gates hold → inline execution.

### Example 2 — disqualified by gate #4

```yaml
taskId: TASK_05
title: "Tweak rate-limit config defaults"
trivial: true
scope:
  files:
    - path: <api-app>/src/middleware/rate-limit-config.ts
      blastRadius:
        forward: [...]
        reverse: [{source: "<api-app>/src/middleware/rate-limit.ts", ...}]
        reverseCount: 1
invariants: []
skillsFound: []
```

Gate #4 fails — `reverse[]` non-empty (the middleware imports the config). Dispatch.

### Example 3 — disqualified by gate #3

```yaml
taskId: TASK_07
title: "Update auth middleware comment block"
trivial: true
scope:
  files:
    - path: <auth-app>/src/middleware/api-key-auth.ts
invariants:
  - rule: "API-key audit log writes go directly, not via the async outbox"
    source: "<auth-app>/CLAUDE.md (host-repo convention)"
skillsFound: []
```

`invariants[]` carries a real rule (no `INVARIANT_RATIONALE:` prefix). Gate
#3 fails → dispatch. The non-empty real invariants are the in-file evidence
that the upstream `generate-task` Reviewer saw a sensitive intersection and
enforced the FR-3 gate. The preamble-driven discipline (skill loading +
invariant verification by the dispatched coder) is the point.
