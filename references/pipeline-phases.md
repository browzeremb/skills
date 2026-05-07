# Pipeline phases — operator reference

> Cross-skill reference for the `orchestrate-task-delivery` pipeline.
> Linked from skill bodies via `references/pipeline-phases.md`.

The 13 canonical phases are defined in
`packages/skills/skills/orchestrate-task-delivery/SKILL.md` (Phase
table). This document covers cross-cutting heuristics that apply to
every phase rather than re-stating the per-phase contracts.

## §1 — Phase ↔ skill map

| Phase | Step name | Skill |
|---|---|---|
| 1 | BRAINSTORMING | `brainstorming` |
| 2 | PRD | `generate-prd` |
| 3 | TASK_PLAN | `generate-task` |
| 4 | TASK_NN (per task) | `execute-task` |
| 5 | WRITE_TESTS | `write-tests` |
| 6 | CODE_REVIEW | `code-review` |
| 7 | RECEIVING_CODE_REVIEW | `receiving-code-review` |
| 8 | UPDATE_DOCS | `update-docs` |
| 8.5 | PRE_PUSH_GATE (sim) | `orchestrate-task-delivery` (inline) |
| 9 | FEATURE_ACCEPTANCE | `feature-acceptance` |
| 10 | COMMIT | `commit` |
| 11 | SYNC_WORKSPACE | `sync-workspace` |
| 12+ | PAUSED_PENDING_OPERATOR / RESUME | manual |

## §2 — async-vs-await

`browzer workflow {append-step,patch,set-config,set-status,set-current-step,complete-step}` accepts `--await` (default, blocks
until durable fsync, ~50–120ms via daemon, ~500ms via standalone) and
`--async` (returns immediately, daemon completes durably in the
background). Uniform `--await` adds ~40–80ms × N writes when the
next reader is several writes downstream — measurable cost on any
multi-write phase.

### Heuristics — when to prefer `--async`

| Situation | Use | Rationale |
|---|---|---|
| Chain of intermediate writes (`seed-step → set-current-step → set-status`) where next read is after ≥ 2 more writes | `--async` for intermediates, `--await` on the final | Daemon serializes per-key; durable order preserved. Pays for one fsync, not N. |
| Single mutation with no follow-up read | `--async` | Loop terminates without depending on durability; daemon flushes within 1s. |
| Mutation immediately followed by `query` / `get-step` | `--await` | Read-after-write ordering required across daemon ↔ caller boundary. |
| `complete-step` (terminal write of a phase) | `--await` always | The next loop iteration in `orchestrate-task-delivery/SKILL.md §Step 3` assumes the step is durably committed. |
| Any write inside a Skill that another Skill reads | `--await` always | Cross-skill rendezvous — durability boundary. |
| Bulk-seed at orchestrator entry (3+ steps in a row) | `--async` for first N-1, `--await` for the Nth | Saves N-1 fsyncs; final await is a fence. |

### Anti-patterns

- `--async` immediately before `set-current-step <stepId>` with the
  same `<stepId>` from the just-async'd `append-step` — race against
  the daemon. Use `--await` on the `append-step` instead.
- `--async` in a loop with `|| break` semantics — you can't
  distinguish daemon-accepted-but-rejected-async from real failure
  without an `--await` fence.
- `--async` from a background process whose lifetime is shorter than
  the daemon flush window — daemon may still be writing when the
  caller exits.

### The 3-async + 1-await fence (TE2-T4.2)

The dominant async-friendly shape: N independent mutations followed by
ONE durability checkpoint. Writing it explicitly avoids cargo-culted
`--await` spam:

```bash
browzer workflow update-step "$STEP_ID" --async --payload <(...) "$WORKFLOW"
browzer workflow append-dispatch "$STEP_ID" --async --prompt-file "$A"
browzer workflow append-dispatch "$STEP_ID" --async --prompt-file "$B"
browzer workflow set-status   "$STEP_ID" RUNNING --await   # fence
```

The trailing `--await` blocks until the entire daemon FIFO is fsynced
— one parent-dir fsync covers all four writes. Concrete saving:
~120 ms → ~35 ms wall-clock per phase emit. The `--await` also acts
as the read-after-write fence; any subsequent `query`/`get-step` of
`$STEP_ID` sees the consolidated state.

**Fence-wrong case**: if step N+1 reads what step N just wrote, move
the `--await` forward to the read-feeding write. The fence relaxes
durability across independent emits, never across dependencies.

### Default

When in doubt, `--await` is correct. The expected savings only show
up when there are multiple chains of 3+ intermediate writes per
phase; isolated calls don't benefit.

## §3 — Schema discovery cache

`grep -nA N "^### #X"` against `references/workflow-schema.md` is the
naive way to look up a step-type payload shape. Running this 10+
times in one session is a smell — schemas are immutable per session.
`browzer workflow describe-step-type <NAME> --json --save /tmp/<name>-schema.json`
caches the schema response per phase; subsequent reads are local file
reads (zero daemon round-trip). One discovery per step-type per
session is enough.

## §4 — Multi-tool-call batching

A pipeline with 13 steps × 4 reviewer dispatches × 1 fix dispatch ×
~50 Bash calls collapses to ~5 multi-call response blocks if every
independent tool call is batched. Wall-clock improvement on the order
of 30-40%.

Heuristics for batching independent tool calls in a single response:

- **Independent reads** (multiple `Bash`, `Read`, `Grep` with no
  shared state) — always batch.
- **Independent writes** (multiple `Edit`/`Write` to different
  files) — batch when the changes are part of the same logical
  iteration.
- **Sequential dependencies** (read → decide → write) — never batch.
- **Subagent dispatches** with disjoint scopes — always batch
  (the 4 mandatory code-review reviewers are the canonical example).
