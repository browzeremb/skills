---
name: execute-task
description: "Implement a single closed-prompt TASK_NN.md by dispatching a domain-specialist subagent (or executing inline on the trivial fast-path). Reads ONLY TASK_NN.md plus the cross-skill invocation preamble — never PRD.md or EXPLORATION.md. Persists per-task state by atomic-renaming the file: TASK_NN.md → TASK_NN.completed.md on success, TASK_NN.failed.md on failure. Appends an `## Execution log` section to the renamed body capturing the subagent report. No workflow.json, no save-step, no CUE."
when_to_use: "execute TASK_03, run task 02, implement task NN, ship this task, run all tasks, build the feature from the plan, /execute-task"
arguments: [featureId, taskId]
allowed-tools: Read Write Edit Bash(git *) Bash(node *) Bash(mv *) Bash(cat *) Bash(printf *) Bash(grep *) Bash(awk *) Bash(ls *)
---

You are a fan-out controller. Your only inputs are a single closed-prompt
`TASK_NN.md` and the cross-skill subagent preamble. Your only outputs are
the modified source code (written by the dispatched subagent OR by you
inline on the trivial fast-path) and the atomic rename of `TASK_NN.md` to
`TASK_NN.completed.md` (success) or `TASK_NN.failed.md` (failure) with an
`## Execution log` section appended to the renamed body.

You NEVER read the BODY of `PRD.md`, `EXPLORATION.md`, `TASK_GRAPH.md`,
or any other phase artefact. The single exception is a
`git hash-object docs/browzer/$featureId/staging/PRD.md` invocation during
Preflight 2 — that is a metadata/fingerprint read for drift detection,
NOT a content read, so the closure principle still holds (no PRD field
travels into the dispatch prompt or the execution log). Every datum the
executor needs is inlined verbatim in `TASK_NN.md` by `generate-task`. If
something is missing, that is a `generate-task` bug — halt and surface it;
never paper over it.

## Inputs

- `$featureId` — REQUIRED. Stable id matching `^feat-[0-9]{8}-[a-z0-9-]+$`. Identifies `docs/browzer/<feat-id>/`.
- `$taskId`    — OPTIONAL. Pattern `^TASK_[0-9]{2}$`. When omitted, the orchestrator is expected to call `/execute-task <featureId> <taskId>` once per pending task; this skill is single-task semantics. See "On invocation without taskId" below.

You read at most THREE files per invocation:

1. `docs/browzer/$featureId/staging/TASK_$taskId.md` — the closed prompt.
2. `docs/browzer/$featureId/staging/TASK_$taskId.failed.md` — only when the prior attempt failed and a retry is starting (mutually exclusive with #1).
3. `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — the compact dispatch composer (substituted into the dispatch prompt with task-specific placeholders, NOT paste-included verbatim).
4. `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` — code-edit role addendum, referenced by path; the dispatcher layers it below the compact invariants block.

`$CLAUDE_PLUGIN_ROOT` is set by Claude Code at runtime to the plugin's
installed root. This skill is a plugin — never hard-code monorepo paths
into the dispatch prompt.

## Output contract

| Path | Produced by | Role |
| --- | --- | --- |
| `docs/browzer/$featureId/staging/TASK_$taskId.completed.md` | atomic mv + body append | success terminal state |
| `docs/browzer/$featureId/staging/TASK_$taskId.failed.md` | atomic mv + body append | failure (non-terminal — retries append `## Retry attempt N`) |
| Source files in `task.scope.files[].path` | `browzer:coder` subagent OR inline fast-path | the actual feature implementation |

The canonical execution-log shape lives in `${CLAUDE_SKILL_DIR}/template.md` —
read it before writing the appended section. Frontmatter is preserved
byte-for-byte from the source TASK file.

## Preflight 1 — locate the task file

```bash
TASK_FILE="docs/browzer/$featureId/staging/TASK_$taskId.md"
FAILED_FILE="docs/browzer/$featureId/staging/TASK_$taskId.failed.md"

if [ -f "$TASK_FILE" ]; then
  SOURCE="$TASK_FILE"; RETRY=0
elif [ -f "$FAILED_FILE" ]; then
  SOURCE="$FAILED_FILE"; RETRY=1
else
  echo "execute-task: neither $TASK_FILE nor $FAILED_FILE exists." >&2
  exit 1
fi
```

If `$TASK_$taskId.completed.md` exists, the task is already done — fail fast
with `execute-task: $taskId already completed; nothing to do`. Re-running a
completed task requires the operator to manually rename it back first.

## Preflight 2 — PRD drift check

`TASK_NN.md` carries `prdSha:` from the PRD it was decomposed against.
Compare against the current PRD.md SHA before dispatching. Drift means
the inlined AC/FR text in TASK_NN.md is stale.

```bash
TASK_SHA=$(grep -E '^prdSha:' "$SOURCE" | awk '{print $2}')
NOW_SHA=$(git hash-object "docs/browzer/$featureId/staging/PRD.md")
if [ "$TASK_SHA" != "$NOW_SHA" ]; then
  echo "execute-task: PRD has drifted since this task was decomposed." >&2
  echo "  task.prdSha = $TASK_SHA" >&2
  echo "  PRD.md SHA  = $NOW_SHA" >&2
  echo "  Re-run /scope-feature $featureId then /generate-task $featureId, then retry." >&2
  exit 1
fi
```

A standalone audit helper is at `${CLAUDE_SKILL_DIR}/scripts/check-prd-drift.mjs`
for operator-facing CI gates.

## Preflight 2.5 — slim → legacy frontmatter expansion

TASK_NN.md frontmatter MAY ship slim: `acceptanceCriteria[].bindsTo[]`
entries carry only `{acId, frId}` pointers, omitting the verbatim
`acText` / `frText`. Before parsing the frontmatter in Preflight 3,
expand the slim form back into self-contained text by piping the source
through `expand-task-acs`:

```bash
EXPANDED=$(node "${CLAUDE_SKILL_DIR}/scripts/expand-task-acs.mjs" "$SOURCE")
```

The script:

- Legacy task (any `bindsTo[].acText` non-empty) → echoes the file
  unchanged. Closed-prompt invariant preserved.
- Slim task → resolves each `acId` / `frId` from
  `docs/browzer/$featureId/staging/PRD.md` and emits the expanded
  frontmatter on stdout. `execute-task` still never reads PRD.md
  itself — the helper does, on its behalf, only to materialise the
  closed-prompt body.
- Missing PRD.md → non-zero exit with `PRD_NOT_FOUND` on stderr. Halt
  with the standard `re-run /scope-feature → /generate-task` message;
  the slim contract requires PRD.md to be present.

Pass the expanded body to the downstream Preflight 3 parser and the
dispatched subagent prompt; never re-read `$SOURCE` after expansion.

## Preflight 3 — frontmatter is well-formed

Parse the YAML frontmatter of `$SOURCE`. The fields execute-task reads:

- `task.scope.files[].path` (required, ≥1)
- `task.scope.files[].blastRadius.reverse[]` (may be empty, may be absent on brand-new files)
- `task.suggestedModel` (default `sonnet`)
- `task.trivial` (default `false`)
- `task.invariants[]` (may be empty OR the key may be omitted entirely — treat the absent case as `[]` for gate-3 computation and for the execution log; `generate-task` is permitted to omit the key when no invariants apply)
- `task.skillsFound[]` (may be empty)
- `task.role` (free-form; flavours the dispatch lead line only)
- `task.acceptanceCriteria[]` (read-only — passed through to the subagent unmodified)
- `prdSha` (already validated above)

Any required field missing → halt with `execute-task: TASK_$taskId frontmatter missing required field: <field>`.
Do NOT default-fill; the contract is closed-prompt.

## Decide: dispatch vs trivial fast-path

Compute the AND of the four gates from `${CLAUDE_SKILL_DIR}/references/trivial-fast-path.md`:

| # | Signal |
|---|---|
| 1 | `task.trivial: true` |
| 2 | `task.scope.files[].length ≤ 2` |
| 3 | No `task.scope.files[].path` was flagged sensitive at scope-feature time. The TASK_NN.md frontmatter does NOT carry sensitive-scope hits directly (those live in EXPLORATION.md, which execute-task cannot read). The proxy here is `task.invariants[]` length: when sensitive-scope hit, `generate-task` is required to populate non-empty invariants. So gate #3 reads as: `task.invariants[].length == 0` (or every entry carries the `INVARIANT_RATIONALE:` sentinel — i.e. no real invariants apply). |
| 4 | `task.skillsFound[].length == 0` AND every `task.scope.files[].blastRadius.reverse[].length == 0` |

All four hold → `MODE=inline-fast-path`. Any single failure → `MODE=dispatched`.

## Dispatch path

When `MODE=dispatched`:

1. **Resolve dispatch parameters**:
   - `model` ← `task.suggestedModel` (default `sonnet`)
   - `effort` ← derived from `task.scope.files[].length`: 1→`medium`, 2–5→`high`, 6–15→`xhigh`, 16+→`max`
   - `subagent_type` ← always `browzer:coder`

2. **Build the dispatch prompt** by composing the five blocks of
   `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`
   (full protocol in `${CLAUDE_SKILL_DIR}/references/dispatch-protocol.md`):

   - **Block 1 — role lead line**: `You are a <task.role> implementation specialist. Implement TASK_$taskId for feature $featureId per the closed prompt below.`
   - **Block 2 — compact invariants**: substitute the seven-invariant template, filling `{{skills}}` from `task.skillsFound[]`, `{{files}}` from `task.scope.files[]`, `{{out-of-scope}}` from `task.scope.doNotTouch[]` (empty array when absent).
   - **Block 3 — code-subagent addendum** (path reference only): one line directing the subagent to the layered addendum at `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md`. Do NOT paste-include the file.
   - **Block 4 — TASK body**: verbatim contents of `$SOURCE` (frontmatter + body).
   - **Block 5 — return-shape footer**: the coder return-shape line from the compact template.

   The total assembled prompt should be ≈30 lines of invariants + the
   TASK body. Anything longer than 50 lines of invariants signals a
   regression to the legacy paste-include path — abort and fix the
   composer before dispatching.

3. **Stamp `Started`** (RFC3339 from `date -u +%Y-%m-%dT%H:%M:%SZ`).

4. **Spawn** `Agent(subagent_type: "browzer:coder", model: <resolved>, effort: <resolved>, prompt: <prompt>)`.

5. **Await** the subagent's structured `## Subagent report` block. Capture verbatim.

6. **Decide outcome**:
   - **Success**: subagent reported at least one non-`(none)` bullet across `Files modified` or `Files created` AND no blocker text in `Notes`. A `Symbols changed: (none)` block on its own is NOT a failure signal — pure refactors legitimately produce zero symbol changes.
   - **Failure**: empty edits across both files sections, blocker in `Notes`, out-of-scope edits without operator approval, malformed subagent report (missing `Files modified` block entirely, see "Things to flag"), or agent crash.

7. **Persist** per the "Atomic state transition" section below.

## Trivial fast-path

When `MODE=inline-fast-path`:

1. **Stamp `Started`**.
2. For each `task.scope.files[].path`: open the file, perform the edit yourself using `Edit` / `Write`. Do NOT load `Skill(...)` (gate #4 guarantees `skillsFound[]` is empty).
3. For each `task.invariants[]` entry:
   - If the rule starts with `INVARIANT_RATIONALE:` → record `SKIPPED-SENTINEL`.
   - Otherwise re-read the affected file(s) and verify the rule still holds; record `PASS` / `FAIL`.
4. **Stamp `Completed`**.
5. **Persist** per the "Atomic state transition" section. The execution log uses `### Inline execution` instead of `### Subagent report`.

A `FAIL` on any real invariant collapses the fast-path into a failure — the
file changes you already made stay on disk, but the rename target is
`TASK_NN.failed.md` and the failure block names the failing invariant.

## Atomic state transition

After the work finishes (success or failure), the only persistence is
the atomic file rename + body append. There is NO `save-step`, NO
`workflow.json` write, NO autosave hook for execute-task.

```bash
# Pick the rename target.
case "$OUTCOME" in
  success) TARGET="docs/browzer/$featureId/staging/TASK_$taskId.completed.md" ;;
  failure) TARGET="docs/browzer/$featureId/staging/TASK_$taskId.failed.md" ;;
esac

# Probe whether SOURCE is tracked BEFORE choosing the rename tool.
# `git ls-files --error-unmatch` exits 0 iff the path is in the index;
# any non-zero status (untracked file, file missing, not a repo) must
# fall back to plain `mv`. Both are atomic on the same filesystem
# (rename(2)). Calling `git mv` on an untracked file errors with
# "fatal: not under version control" — never silently skip the rename.
if git ls-files --error-unmatch "$SOURCE" >/dev/null 2>&1; then
  git mv "$SOURCE" "$TARGET"
else
  mv "$SOURCE" "$TARGET"
fi

# Append the execution log section to the renamed body.
# (Use Write/Edit tools to produce the exact section — bash heredoc shown
# only as schematic; the LLM authors the section text per template.md.)
```

The execution-log schema (Mode / Model / Files modified / Invariants
checked / Subagent report / etc.) is canonical in
`${CLAUDE_SKILL_DIR}/template.md` Section B. Follow it exactly. Frontmatter
of the renamed file is preserved byte-for-byte; only the body grows by one
`## Execution log` section.

## Retry semantics

When `$SOURCE` was `TASK_$taskId.failed.md` (RETRY=1):

1. Do NOT rename back to `TASK_NN.md`.
2. Run dispatch / fast-path as above.
3. **On failure**: do not rename. Append a new `## Retry attempt N` section
   to the existing `.failed.md` body. **Formula**: `N = count(existing "## Retry attempt" headings in the body) + 2`. The `+2` (not `+1`) is intentional because the original failure that produced the `.failed.md` file is implicitly attempt 1 and is recorded as the `## Execution log` section, NOT as a `## Retry attempt 1` heading. So the first re-run writes `## Retry attempt 2` (count was 0), the second writes `## Retry attempt 3` (count was 1), and so on.
4. **On success**: `mv .failed.md → .completed.md`. The prior `## Retry attempt N`
   sections travel with the rename, preserving the failure history.

Full retry shape lives in `${CLAUDE_SKILL_DIR}/references/trivial-fast-path.md`
("Retry semantics for `.failed.md`").

## Out-of-scope edits

The dispatched subagent MUST stay inside `task.scope.files[].path`. If the
`## Subagent report → Notes` section discloses edits outside that set:

- Record the deviation in the execution log under `### Scope adjustments` with one bullet per out-of-scope path.
- Do NOT auto-flip the status to `completed`. The outcome is `failure` with `### Failure → Reason: out-of-scope edits`.
- The operator may approve the deviation manually by renaming `.failed.md → .completed.md` after reviewing the diff.

## Intra-file closure

The execution log lives in the BODY of the renamed file. When a sub-section
references frontmatter data (an invariant rule, a scope-files path, an AC),
**inline the verbatim string OR cite a structured ID** — never write
narrative pins like "see invariants[2]" or "the second AC". This mirrors
generate-task's `testSpecs[].pinsAcs[]` / `pinsFrs[]` discipline. Downstream
consumers (`code-review`, `feature-acceptance`) parse the log without
ambiguity only when references are explicit.

## On invocation without `taskId`

When the operator (or orchestrator) calls `/execute-task <featureId>` with
no taskId:

1. Glob `docs/browzer/$featureId/staging/TASK_*.md` (excluding `.completed.md` / `.failed.md` siblings).
2. For each pending task in **lexical order**: invoke this skill recursively
   `/execute-task <featureId> <taskId>` and await before the next.
3. **Do NOT parallelize**. The orchestrator owns parallel dispatch — see
   `orchestrate-task-delivery` for `parallelizable[]` consumption from
   `TASK_GRAPH.md`. execute-task itself is single-task semantics by design.

When the loop completes, return one summary line and exit (no aggregation file).

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/template.md` — execution-log shape (Section B) + dispatch-prompt skeleton (Section A).
2. Preflight 1: locate the source file (`TASK_NN.md` or `TASK_NN.failed.md`).
3. Preflight 2: PRD drift check (halt on mismatch).
4. Preflight 3: frontmatter well-formed (halt on missing required field).
5. Decide MODE: trivial fast-path (AND of 4 gates) vs dispatched.
6. Execute the chosen path. Capture `Started` / `Completed`.
7. Atomic mv to `.completed.md` or `.failed.md`.
8. Append `## Execution log` (or `## Retry attempt N` on retry-failure) to the renamed body.

## Done when

- `docs/browzer/$featureId/staging/TASK_$taskId.completed.md` OR `.failed.md` exists.
- The renamed file's frontmatter equals the source frontmatter byte-for-byte.
- The renamed file's body ends with a `## Execution log` (or `## Retry attempt N`) section conforming to template.md Section B.
- `### Files modified` and `### Files created` bullets follow the rigid shape from template.md Section B (`- <repo-relative-path> (+<int>/-<int>)` and `- <repo-relative-path> (+<int>)` respectively). Empty case uses one literal `(none)` bullet — neither section is silently dropped.
- `### Symbols changed` section is present in every execution log, with one bullet per touched symbol following the `<scope> <kind> <symbol-id> <change>` shape, or one literal `(none)` bullet when no symbol surface shifted.
- Source code in `task.scope.files[].path` has been edited (success path) OR a `### Failure` block names the blocker (failure path).
- No file under `docs/browzer/$featureId/staging/` was edited that is not the rename target.

Return one line:

> `execute-task: $taskId <completed|failed> via <dispatched|inline-fast-path>; <N> files modified.`

Your turn is incomplete until the renamed file exists with its `## Execution
log` section. Do not stop to summarize after the dispatch returns.

## Things to flag

- **`TASK_NN.md` lacks `prdSha`** → halt; the closure-principle contract requires it. Operator must re-run `/generate-task`.
- **`mv` target already exists** (e.g. `.completed.md` exists when starting fresh) → halt with explicit message; never overwrite.
- **Subagent reports files outside `task.scope.files[]`** → execution log records under `### Scope adjustments`; outcome is `failure`.
- **Subagent skipped a declared `Skill(...)` invocation** → preamble's "Skill invocation" section says the dispatch lead may downgrade; record as `### Failure → Reason: skill-bypass`.
- **A skill name lookup gives a marketplace shadow** instead of the plugin variant → use the qualified `Skill(browzer:<name>)` form. The dispatch-protocol.md ref documents this.
- **Subagent's `Files modified` or `Files created` bullets violate the rigid shape** (no `(+N/-N)` suffix, comma-separated paths inline, etc.) → record the deviation under `Notes` in the execution log; do NOT silently rewrite the subagent output. Surface to the operator so the contract violation is visible.
- **Subagent omits the `Symbols changed` section entirely** → write the execution log with `### Symbols changed` containing a single `(none)` bullet, and record the deviation under `### Scope adjustments` so `code-review`'s qa lane has an explicit signal that the block is a fallback rather than authoritative. Do NOT re-prompt the subagent (cost outweighs the `(none)` fallback).
- **Subagent omits the `Files modified` section entirely** → treat as a malformed report; outcome is `failure` with `### Failure → Reason: malformed-subagent-report`. Stronger signal than `(none)`: the subagent did not engage with the shape at all, so the rest of the report is also untrustworthy.
