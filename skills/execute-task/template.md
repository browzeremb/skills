<!--
  Canonical template for the execute-task skill.

  This file replaces the previous auto-generated template (CUE-derived) that
  was retired in the markdown-chains refactor. execute-task does NOT produce
  a structured staging payload — it mutates source code in place and persists
  per-task state by renaming TASK_NN.md to TASK_NN.completed.md (success) or
  TASK_NN.failed.md (failure), appending a `## Execution log` section.

  STATUS VIA FILENAME SUFFIX
  ──────────────────────────
  This skill introduces the convention. There is no `status:` frontmatter
  field, no JSON, no save-step. The only state transitions are:

    TASK_NN.md            (pending — written by generate-task)
       │
       ├──> TASK_NN.completed.md   (success — atomic mv)
       │
       └──> TASK_NN.failed.md      (failure — atomic mv)
                  │
                  └──> TASK_NN.completed.md   (eventual success on retry —
                                               atomic mv, retry log preserved)

  Implementations MUST use `git mv` when the file is tracked, `mv` otherwise.
  The `## Execution log` is appended AFTER the rename so the renamed body
  carries every datum reviewers and downstream skills need.

  CLOSURE PRINCIPLE
  ─────────────────
  execute-task READS only `TASK_NN.md` and the cross-skill preamble at
  `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md`. It never reads
  `PRD.md`, `EXPLORATION.md`, or any other phase artefact. The dispatch
  prompt is the verbatim paste-include of those two files. If TASK_NN.md
  is missing a datum the subagent needs, the fault is upstream
  (generate-task) — never paper over it inside execute-task.

  PATHS USED IN THIS TEMPLATE
  ───────────────────────────
  This skill is a Claude Code plugin and MUST stay host-agnostic. Use:
    - `${CLAUDE_PLUGIN_ROOT}` — installed plugin root
    - `${CLAUDE_SKILL_DIR}`   — this skill's installed directory
  No monorepo paths (no `packages/skills/...`, `apps/<app>/...`, etc.) in
  prose outside fenced examples explicitly marked `<!-- host-example -->`.

  INTRA-FILE CLOSURE
  ──────────────────
  When the execution log surfaces a cross-reference into the source
  TASK_NN.md (an invariant rule, a scope-files path, an AC binding), inline
  the verbatim string OR cite it by structured ID — never write narrative
  pins like "see invariants[2]" or "the second AC". The principle mirrors
  generate-task's `testSpecs[].pinsAcs[]` / `pinsFrs[]` pattern: structured
  IDs over prose. Downstream consumers (code-review, feature-acceptance)
  must be able to grep the log without ambiguity.
-->

# execute-task templates

This template is the canonical contract for TWO artefacts execute-task
produces:

1. The **dispatch prompt** sent to `browzer:coder` (or executed inline on
   the trivial fast-path).
2. The **`## Execution log`** section appended to the renamed `.completed.md`
   / `.failed.md` body.

The structured contract from `TASK_NN.md` lives in `generate-task/template.md`
— execute-task only consumes that. Nothing here re-describes the TASK shape.

---

## A — Dispatch prompt shape

The dispatch prompt is composed at runtime as the concatenation of three
verbatim parts. Do NOT paraphrase, summarise, or transform any part — the
subagent's preamble + closed-prompt contract is broken by even small edits.

```text
You are a <task.role> specialist. Implement <taskId> for feature <featureId>
under the contract below. Stop after writing the structured report.

<verbatim contents of ${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md>

---

<verbatim contents of docs/browzer/<featureId>/staging/tasks/<taskId>.md>

---

When you are done, return a structured report in this exact shape. Downstream
skills (`code-review`, `feature-acceptance`, `finalize-feature` Phase A) parse this block
with regex — keep each bullet on a single line and respect the literal
suffix formats. When a section has no entries, emit exactly one `(none)`
bullet; do not drop the section.

## Subagent report
- Started: <RFC3339 timestamp when you began work>
- Completed: <RFC3339 timestamp when you finished>
- Files modified:
    - <repo-relative-path> (+<added-lines>/-<removed-lines>)
    - … or one literal `(none)` bullet when zero files were modified
- Files created:
    - <repo-relative-path> (+<line-count>)
    - … or one literal `(none)` bullet when zero files were created
- Symbols changed:
    - <scope> <kind> <symbol-id> <change>
    - … or one literal `(none)` bullet when no symbol-level surface changed
- Skills loaded:
    - <skill-name>
    - … or one literal `(none)` bullet when task.skillsFound[] was empty
- Invariants checked:
    - <verbatim invariant rule> → PASS | FAIL | SKIPPED-SENTINEL
    - … or one literal `(none)` bullet when task.invariants[] was empty or absent
- Notes: <free text — assumptions, scope deviations, blockers — or "(none)">
```

### Symbol-id schema (language-agnostic)

The `Symbols changed` block exists so the downstream `code-review` qa lane
can probe blast radius at symbol granularity via `browzer mentions` without
re-deriving symbol identity from the diff. Each bullet has four fields,
separated by single spaces:

```text
<scope> <kind> <symbol-id> <change>
```

| Field       | Values                                                                                   |
|-------------|------------------------------------------------------------------------------------------|
| `scope`     | `exported` \| `internal`                                                                  |
| `kind`      | `function` \| `method` \| `type` \| `const` \| `var` \| `interface` \| `class` \| `struct` \| `enum` |
| `symbol-id` | `<repo-relative-path>::<dotted-name>` (e.g. `cmd/myapp/main.go::Run`, `src/api/score.ts::Scorer.format`) |
| `change`    | `added` \| `removed` \| `signature-changed` \| `semantics-changed`                       |

`signature-changed` covers parameter / return-type / generics edits.
`semantics-changed` covers same-signature edits whose observable behaviour
shifted in a way that callers should re-validate against (e.g. return-value
semantics inverted, side-effect added, error contract narrowed). Pure
refactors that preserve behaviour need not appear at all — when in doubt,
omit; the qa lane reads silence as "no butterfly check required".

Only emit symbols that you actually touched in this task. Discovered but
unedited symbols belong in `Notes`, not in this block.

### Resolution table

| Parameter | Source | Default |
|---|---|---|
| `subagent_type` | constant | `browzer:coder` |
| `model` | `task.suggestedModel` | `sonnet` |
| `effort` | derived from `task.scope.files[].length` | `medium` (1 file) / `high` (2–5) / `xhigh` (6–15) / `max` (16+) |

Full dispatch protocol details (preamble paste, qualified skill names,
out-of-scope handling) live in `${CLAUDE_SKILL_DIR}/references/dispatch-protocol.md`.

---

## B — Execution log shape (appended to the renamed body)

After the `mv`, append the following section to the body of the renamed
file (`TASK_NN.completed.md` or `TASK_NN.failed.md`). The section is the
ONLY thing execute-task writes into that file — frontmatter is preserved
byte-for-byte from the source `TASK_NN.md`.

```markdown
## Execution log

- **Started**: 2026-05-12T17:30:00Z
- **Completed**: 2026-05-12T17:42:15Z
- **Mode**: dispatched | inline-fast-path | failed
- **Model**: claude-sonnet-4-6 (subagent: browzer:coder)
- **Effort**: high
- **Skills invoked**: golang-best-practices, fastify-best-practices

### Files modified
- cmd/myapp/main.go (+12/-3)
- internal/api/handler.go (+45/-8)

<!-- Schema: `- <repo-relative-path> (+<added-lines>/-<removed-lines>)`.
     Each modified file on its own bullet. When zero files were modified,
     emit exactly one `(none)` bullet instead of dropping the section. -->

### Files created
- internal/api/handler_test.go (+96)

<!-- Schema: `- <repo-relative-path> (+<line-count>)` (no `-<removed>` term,
     a new file has nothing to remove). When zero files were created, emit
     one `(none)` bullet. -->

### Symbols changed
- exported function cmd/myapp/main.go::Run signature-changed
- internal function internal/api/handler.go::validateLimit added
- exported type internal/api/handler.go::Handler semantics-changed

<!-- Schema (one bullet per touched symbol):
       `- <scope> <kind> <symbol-id> <change>`

       scope     : exported | internal
       kind      : function | method | type | const | var | interface | class | struct | enum
       symbol-id : <repo-relative-path>::<dotted-name>
       change    : added | removed | signature-changed | semantics-changed

     This block exists to feed code-review's qa lane butterfly-effect
     analysis via `browzer mentions <symbol-id>` without re-deriving
     symbol identity from the diff. Pure refactors that preserve all
     observable behaviour need not appear here.

     Empty case is common and meaningful (silence = "no butterfly check
     required"). When the subagent reports `Symbols changed: (none)`,
     emit the section with a single `(none)` bullet — never drop it. -->

### Invariants checked
- "Compare bearer tokens via timingSafeEqual from node:crypto — never `===`" → PASS (verified at internal/api/handler.go:42)
- "INVARIANT_RATIONALE: no project convention exists for default flag values" → SKIPPED-SENTINEL

<!-- When task.invariants[] is empty (or the key was omitted by generate-task),
     emit the section with a single literal `(none)` bullet so consumers see
     an explicit signal rather than guessing whether the section was skipped:

     ### Invariants checked
     - (none)
-->

### Subagent report
{Verbatim paste of the subagent's `## Subagent report` block. Indented by
two spaces if you want a clean visual delineation; not required.}

### Scope adjustments
(none — or one bullet per out-of-scope file the subagent surfaced under `Notes`)
```

### Failure variant

When the task fails (subagent reported a blocker, gate #1 failed, or the rename
target is `.failed.md`), the section adds a `### Failure` block instead of —
or in addition to — `### Subagent report`:

```markdown
### Failure
- **Reason**: out-of-scope edits | gate failure | subagent blocker | rename conflict
- **Detail**: One-paragraph rationale the operator can act on.
- **Operator action**: Concrete next step (re-run /scope-feature, fix the
  invariant rule, approve the deviation manually, …).
```

### Inline-fast-path variant

When the trivial fast-path was taken, the section uses `### Inline execution`
instead of `### Subagent report`:

```markdown
### Inline execution
- **Rationale**: One-paragraph explanation of why all four gates held.
- **Tool-use**: Read=N, Edit=N, Write=N, Bash=N
```

The decision tree for the fast-path is in `${CLAUDE_SKILL_DIR}/references/trivial-fast-path.md`.

### Retry variant (only on `.failed.md`)

Re-running execute-task against a `TASK_NN.failed.md` task appends a new
`## Retry attempt N` section to the existing body — frontmatter unchanged,
prior failure log preserved verbatim:

```markdown
## Retry attempt 2

- **Started**: 2026-05-13T09:14:00Z
- **Completed**: 2026-05-13T09:22:08Z
- **Mode**: dispatched
- **Model**: claude-opus-4-7 (escalated from sonnet)
- **Effort**: high

### Subagent report
{verbatim}

### Outcome
- **Verdict**: success | fail-again
- **On success**: `mv TASK_NN.failed.md → TASK_NN.completed.md` after writing this section.
- **On fail-again**: keep `.failed.md`; the next attempt becomes `## Retry attempt 3`.
```

`N` is `count(existing "## Retry attempt" headings) + 2`. The `+2` (not `+1`)
is intentional: the initial failure is implicitly attempt 1 — recorded as the
file's `## Execution log` section, not as a `## Retry attempt 1` heading. So
the first re-run writes `## Retry attempt 2` (count was 0); the second writes
`## Retry attempt 3` (count was 1); and so on.

---

## ID format quick reference

| Field | Pattern | Example |
|---|---|---|
| `taskId` | `^TASK_[0-9]{2}$` | `TASK_07` |
| `featureId` | `^feat-[0-9]{8}-[a-z0-9-]+$` | `feat-20260512-search-limit` |
| `Started` / `Completed` | RFC3339 | `2026-05-12T17:30:00Z` |
| `Mode` | enum | `dispatched`, `inline-fast-path`, `failed` |

---

## How to extend this template

Adding a field to the execution-log shape:

1. Add the field to Section B above with an example.
2. Update downstream consumers (`code-review`, `feature-acceptance`,
   `finalize-feature`) if they need to parse the new field. Each
   consumer skill explicitly names which sub-sections of
   `## Execution log` it reads — keep those in sync.

The contract has no formal schema. Discipline lives in this file plus the
SKILL.md body. Drift is caught at integration time when downstream consumers
hit unexpected shapes.

---

## Cross-reference invariants

By convention (verified by the agent during execution, not by a script):

1. The renamed file's frontmatter equals the source `TASK_NN.md`'s frontmatter
   byte-for-byte.
2. Every `Files modified` and `Files created` path is `task.scope.files[].path`
   or surfaced explicitly under `Scope adjustments`.
3. Every `Invariants checked` line corresponds 1:1 to a `task.invariants[]`
   entry from the source frontmatter — same count, same order. When the
   source `task.invariants[]` is empty (or the key is omitted), the section
   is still present with a single `(none)` bullet — never silently dropped.
4. `Mode` is one of `dispatched`, `inline-fast-path`, `failed`. No other
   values appear.
5. `Started` ≤ `Completed`. RFC3339 strict — never an empty string.
6. When `Mode: failed`, the section MUST include a `### Failure` block with
   non-empty `Reason`, `Detail`, and `Operator action`.
7. `.failed.md → .completed.md` renames preserve every prior
   `## Retry attempt N` section verbatim.
8. Every `### Files modified` bullet matches the regex
   `^- [^ ]+ \(\+\d+/-\d+\)$`; every `### Files created` bullet matches
   `^- [^ ]+ \(\+\d+\)$`. The literal `(none)` bullet is the only
   permitted empty signal — neither section is silently dropped.
9. Every `### Symbols changed` bullet matches
   `^- (exported|internal) (function|method|type|const|var|interface|class|struct|enum) \S+::\S+ (added|removed|signature-changed|semantics-changed)$`.
   The section is always emitted; pure refactors that preserve all
   observable behaviour use a single `(none)` bullet.
10. Each `### Symbols changed` bullet's `symbol-id` path prefix
    (the substring before `::`) appears in either `### Files modified`
    or `### Files created`. A symbol touched without a corresponding
    file edit is a contract violation — the subagent surfaced a
    derivation error and the operator should review.
