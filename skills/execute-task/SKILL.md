---
name: execute-task
description: "Implement a single closed-prompt TASK_NN.md by dispatching a domain-specialist subagent (or executing inline on the trivial fast-path). The coder writes tests inline alongside the implementation (one test per testSpec[]) and a hard-fail host-quality-gate (lint+typecheck+test, plus build at tier=full when public API drifted) runs BEFORE the atomic rename to .completed.md. Reads ONLY TASK_NN.md plus the cross-skill invocation preamble — never PRD.md or EXPLORATION.md. Persists per-task state by atomic-renaming the file: TASK_NN.md → TASK_NN.completed.md on success (with `qualityGate` + `testsAdded[]` frontmatter), TASK_NN.failed.md on failure. Appends an `## Execution log` section to the renamed body capturing the subagent report. Phase state lives entirely in `docs/browzer/<feat>/staging/`; no external persistence layer."
arguments: [featureId, taskId]
allowed-tools: Read Write Edit Bash(git *) Bash(node *) Bash(mv *) Bash(cat *) Bash(printf *) Bash(grep *) Bash(awk *) Bash(ls *) Bash(pnpm *) Bash(npm *) Bash(yarn *) Bash(go *) Bash(cargo *) Bash(pytest *) Bash(ruff *) Bash(mypy *) Bash(golangci-lint *) Bash(turbo *)
---

You are a fan-out controller. Your only inputs are a single closed-prompt
`TASK_NN.md` and the cross-skill subagent preamble. Your only outputs are
the modified source code (written by the dispatched subagent OR by you
inline on the trivial fast-path), the tests authored inline alongside the
implementation (one per `task.testSpecs[]`), the **hard-fail host quality
gate** result captured in `TASK_NN.completed.md.frontmatter.qualityGate`,
and the atomic rename of `TASK_NN.md` to `TASK_NN.completed.md` (success)
or `TASK_NN.failed.md` (failure) with an `## Execution log` section
appended to the renamed body.

You NEVER read the BODY of `PRD.md`, `EXPLORATION.md`, `TASK_GRAPH.md`,
or any other phase artefact. The single exception is a
`git hash-object docs/browzer/$featureId/staging/planning/PRD.md`
invocation during Preflight 2 — that is a metadata/fingerprint read for
drift detection, NOT a content read, so the closure principle still holds
(no PRD field travels into the dispatch prompt or the execution log).
Every datum the executor needs is inlined verbatim in `TASK_NN.md` by
`generate-task` (or by the orchestrator's inline write for `tier=express`).
If something is missing, that is a `generate-task` / orchestrator-inline
bug — halt and surface it; never paper over it.

## Tier-aware mode

Read `staging/CONFIG.md.tier` as the first step of every invocation:

| Tier       | Quality gate scope                                       | Build step                                                                                                                                 |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `express`  | `lint + typecheck + test` over the package-scoped filter | omitted                                                                                                                                    |
| `standard` | `lint + typecheck + test` over the package-scoped filter | omitted                                                                                                                                    |
| `full`     | `lint + typecheck + test` over the package-scoped filter | `build` added when public-API drift is detected in the changed-symbol list (`exported` scope + `signature-changed` / `added` change types) |

The gate command tuple is resolved at runtime by the cross-skill
detector `${CLAUDE_PLUGIN_ROOT}/references/scripts/detect-quality-gate.mjs`.
Failures HALT the task with retry-with-gate-output (max 2 retries
before TASK_NN.failed.md).

## Inputs

- `$featureId` — REQUIRED. Stable id matching `^feat-[0-9]{8}-[a-z0-9-]+$`. Identifies `docs/browzer/<feat-id>/`.
- `$taskId` — OPTIONAL. Pattern `^TASK_[0-9]{2}$`. When omitted, the orchestrator is expected to call `/execute-task <featureId> <taskId>` once per pending task; this skill is single-task semantics. See "On invocation without taskId" below.

You read at most these files per invocation:

1. `docs/browzer/$featureId/staging/tasks/TASK_$taskId.md` — the closed prompt.
2. `docs/browzer/$featureId/staging/tasks/TASK_$taskId.failed.md` — only when the prior attempt failed and a retry is starting (mutually exclusive with #1).
3. `docs/browzer/$featureId/staging/CONFIG.md` — frontmatter only, to extract `tier`.
4. `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — the compact dispatch composer (substituted into the dispatch prompt with task-specific placeholders, NOT paste-included verbatim).
5. `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` — code-edit role addendum, referenced by path; the dispatcher layers it below the compact invariants block.
6. `${CLAUDE_PLUGIN_ROOT}/references/scripts/detect-quality-gate.mjs` — host-quality-gate command resolver, invoked at the post-implementation gate.

`$CLAUDE_PLUGIN_ROOT` is set by Claude Code at runtime to the plugin's
installed root. This skill is a plugin — never hard-code monorepo paths
into the dispatch prompt.

## Output contract

| Path                                                              | Produced by                                                                   | Role                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/browzer/$featureId/staging/tasks/TASK_$taskId.completed.md` | atomic mv + body append (includes `qualityGate` + `testsAdded[]` frontmatter) | success terminal state                                                                                                                                             |
| `docs/browzer/$featureId/staging/tasks/TASK_$taskId.failed.md`    | atomic mv + body append                                                       | failure (non-terminal — retries append `## Retry attempt N` or `## Quality gate failure`)                                                                          |
| Source files in `task.scope.files[].path`                         | `browzer:coder` subagent OR inline fast-path                                  | the actual feature implementation                                                                                                                                  |
| Test files alongside the implementation                           | `browzer:coder` subagent OR inline fast-path                                  | one file per `task.testSpecs[].id`; paths captured in `### Tests added` block of the subagent report and rolled into the renamed file's `testsAdded[]` frontmatter |

The canonical execution-log shape lives in `${CLAUDE_SKILL_DIR}/template.md` —
read it before writing the appended section. Frontmatter is preserved
byte-for-byte from the source TASK file.

## Preflight 1 — locate the task file

```bash
TASK_FILE="docs/browzer/$featureId/staging/tasks/TASK_$taskId.md"
FAILED_FILE="docs/browzer/$featureId/staging/tasks/TASK_$taskId.failed.md"

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
PRD_PATH="docs/browzer/$featureId/staging/planning/PRD.md"

# Express-tier short-circuit — no PRD.md exists; prdSha must be null in TASK_NN.
if [ ! -f "$PRD_PATH" ]; then
  if [ "$TASK_SHA" != "null" ] && [ -n "$TASK_SHA" ]; then
    echo "execute-task: PRD.md absent but TASK declares prdSha=$TASK_SHA." >&2
    echo "  Tier-express tasks must carry prdSha: null." >&2
    exit 1
  fi
else
  NOW_SHA=$(git hash-object "$PRD_PATH")
  if [ "$TASK_SHA" != "$NOW_SHA" ]; then
    echo "execute-task: PRD has drifted since this task was decomposed." >&2
    echo "  task.prdSha = $TASK_SHA" >&2
    echo "  PRD.md SHA  = $NOW_SHA" >&2
    echo "  Re-run /scope-feature $featureId then /generate-task $featureId, then retry." >&2
    exit 1
  fi
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

| #   | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `task.trivial: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | `task.scope.files[].length ≤ 2`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3   | No `task.scope.files[].path` was flagged sensitive at scope-feature time. The TASK_NN.md frontmatter does NOT carry sensitive-scope hits directly (those live in EXPLORATION.md, which execute-task cannot read). The proxy here is `task.invariants[]` length: when sensitive-scope hit, `generate-task` is required to populate non-empty invariants. So gate #3 reads as: `task.invariants[].length == 0` (or every entry carries the `INVARIANT_RATIONALE:` sentinel — i.e. no real invariants apply). |
| 4   | `task.skillsFound[].length == 0` AND every `task.scope.files[].blastRadius.reverse[].length == 0`                                                                                                                                                                                                                                                                                                                                                                                                          |

All four hold → `MODE=inline-fast-path`. Any single failure → `MODE=dispatched`.

## Dispatch path

When `MODE=dispatched`:

1. **Resolve dispatch parameters**:
   - `model` ← `task.suggestedModel` (default `sonnet`)
   - `effort` ← derived from `task.scope.files[].length`: 1→`medium`, 2–5→`high`, 6–15→`xhigh`, 16+→`max`
   - `subagent_type` ← always `browzer:coder`

2. **Build the dispatch prompt** by composing the five blocks of
   `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`
   (full protocol in `${CLAUDE_SKILL_DIR}/references/dispatch-protocol.md`).
   Operative dispatch invariants: see `${CLAUDE_PLUGIN_ROOT}/references/dispatch-invariants.md`. Read once per dispatch wave; do not paste-include into dispatch prompts.
   - **Block 1 — role lead line**: `You are a <task.role> implementation specialist. Implement TASK_$taskId for feature $featureId per the closed prompt below.`
   - **Block 2 — compact invariants**: substitute the seven-invariant template, filling `{{skills}}` from `task.skillsFound[]`, `{{files}}` from `task.scope.files[]`, `{{out-of-scope}}` from `task.scope.doNotTouch[]` (empty array when absent).
   - **Block 3 — code-subagent addendum** (path reference only): one line directing the subagent to the layered addendum at `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md`. Do NOT paste-include the file.
   - **Block 4 — TASK body**: verbatim contents of `$SOURCE` (frontmatter + body).
   - **Block 5 — return-shape footer**: the coder return-shape line from the compact template, plus an explicit "write tests inline" addendum listing `task.testSpecs[]` with the instruction _"For every testSpec[].id, author a test file in the host's conventional location alongside the implementation. The test file path goes into the subagent report's `### Tests added` block (one bullet per file: `- <path>`). Do NOT defer test authoring to a later phase — this skill's hard-fail quality gate (Step 8) runs the host's `test` command before this dispatch can be marked complete."_

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

## Hard-fail quality gate

After the subagent reports completion (dispatched path) or the inline
edits finish (fast-path), run the host's local quality gate over the
**changed surface**. The gate is mandatory — failures HALT the task
and the rename target becomes `.failed.md`.

1. **Resolve the command tuple** via the cross-skill detector:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/references/scripts/detect-quality-gate.mjs" \
     --json \
     --scope "$PACKAGE_FILTER" \
     $TIER_BUILD_FLAG \
     > /tmp/execute-task-${featureId}-${taskId}-gate.json
   ```

   - `$PACKAGE_FILTER` is the host-runner-specific filter scoping the
     gate to packages touched by the subagent (e.g. for pnpm/turbo:
     a comma-joined list of `@scope/package` names derived from
     `task.scope.files[]`; pass empty string when the host runner has
     no native filter concept).
   - `$TIER_BUILD_FLAG` is `--build` when `CONFIG.tier == full` AND the
     subagent reported any `### Symbols changed → exported … signature-changed | added`
     entry (public API drift). Otherwise omitted.

   The script returns `{runner, lint, typecheck, test, build?}` arrays.
   When `runner == "unknown"`, skip the gate (no detectable runner — record
   `qualityGate.runner = "unknown"` in the frontmatter and proceed).

2. **Run each gate command sequentially** via the `Bash` tool. Capture
   stdout+stderr per command. Tally pass/fail per command.

3. **Decision**:
   - **All commands `pass`** (or `runner == "unknown"`): record
     `qualityGate: {runner, lint: pass, typecheck: pass, test: pass,
build?: pass}` and proceed to "Atomic state transition" with
     `OUTCOME=success`.
   - **Any command `fail`**: HALT the task with retry-with-gate-output.
     Build a new dispatch prompt prepending the gate output excerpt
     (last ~30 lines of the failing command), re-spawn the coder with
     instructions "Fix the gate failure(s) above; do not introduce
     scope changes." Allow up to **2 retries** before giving up.
     Record each retry in the execution log under
     `### Quality gate retry N`. After the third failure (initial +
     2 retries), set `OUTCOME=failure` and append a
     `## Quality gate failure` section to the rename target's body
     containing the full last-attempt gate output.

4. **Record in frontmatter**: regardless of outcome, the renamed file's
   frontmatter (atomic state transition step) gains:

   ```yaml
   qualityGate:
     runner: <detector output>
     lint: pass | fail | n/a
     typecheck: pass | fail | n/a
     test: pass | fail | n/a
     build: pass | fail | n/a # only when --build was requested
     retries: <0-2>
   testsAdded:
     - <test-file-path> # one bullet per file from `### Tests added`
   ```

   `testsAdded[]` is consumed by `code-review` (regression-tester +
   qa lanes) and by `finalize-feature/render-readme.mjs` for the
   README's "Tests added" section.

## Atomic state transition

After the work finishes (success or failure), the only persistence is
the atomic file rename + body append. There is no external workflow
state and no autosave hook for execute-task — `docs/browzer/<feat>/staging/`
is the entire state surface.

```bash
# Pick the rename target.
case "$OUTCOME" in
  success) TARGET="docs/browzer/$featureId/staging/tasks/TASK_$taskId.completed.md" ;;
  failure) TARGET="docs/browzer/$featureId/staging/tasks/TASK_$taskId.failed.md" ;;
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

1. Glob `docs/browzer/$featureId/staging/tasks/TASK_*.md` (excluding `.completed.md` / `.failed.md` siblings).
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

- `docs/browzer/$featureId/staging/tasks/TASK_$taskId.completed.md` OR `.failed.md` exists.
- The renamed file's frontmatter equals the source frontmatter byte-for-byte, PLUS the new `qualityGate` block and `testsAdded[]` list appended at the end.
- The renamed file's body ends with a `## Execution log` (or `## Retry attempt N`) section conforming to template.md Section B.
- `### Files modified` and `### Files created` bullets follow the rigid shape from template.md Section B (`- <repo-relative-path> (+<int>/-<int>)` and `- <repo-relative-path> (+<int>)` respectively). Empty case uses one literal `(none)` bullet — neither section is silently dropped.
- `### Symbols changed` section is present in every execution log, with one bullet per touched symbol following the `<scope> <kind> <symbol-id> <change>` shape, or one literal `(none)` bullet when no symbol surface shifted.
- Source code in `task.scope.files[].path` has been edited (success path) OR a `### Failure` block names the blocker (failure path).
- No file under `docs/browzer/$featureId/staging/` was edited that is not the rename target.
- `qualityGate` frontmatter records the host-quality-gate verdict for every command the detector returned. `qualityGate.runner == "unknown"` is permitted (no detectable host runner); any other runner must show `pass`/`fail`/`n/a` for every probed command.

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
