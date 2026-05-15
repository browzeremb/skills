# Dispatch protocol — how `execute-task` builds the subagent prompt

`TASK_NN.md` is a CLOSED PROMPT. The dispatch prompt is the **paste-include of
two files only** plus a one-line lead, in this exact order:

1. The lead line (model + role + task id).
2. The contents of `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md`
   (cross-skill invocation rule body) — paste verbatim, no transformation.
3. The contents of `docs/browzer/<feat>/staging/TASK_NN.md` — paste verbatim, including
   YAML frontmatter and body.

`$CLAUDE_PLUGIN_ROOT` is set by Claude Code at runtime to the plugin's
installed root directory; this skill is a plugin and MUST NOT hard-code
monorepo-specific paths.

The dispatch must NOT splice in PRD.md, EXPLORATION.md, or anything else. The
closure principle says every datum the executor needs is already inlined in
TASK_NN.md by `generate-task`. If something is missing, that is a
`generate-task` bug — re-run the planning chain rather than papering over it
in the dispatch.

## Prompt skeleton

```
You are a <task.role> specialist. Implement TASK_<NN> for feature <featureId>.

<contents of ${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md, verbatim>

---

<contents of docs/browzer/<featureId>/TASK_<NN>.md, verbatim>

---

When you are done, return a structured report. The full schema — regex-strict
bullet shapes, empty-case sentinels, language-agnostic symbol-id — lives in
`${CLAUDE_SKILL_DIR}/template.md` Section A. Skeleton:

  ## Subagent report
  - Started: <RFC3339>
  - Completed: <RFC3339>
  - Files modified:
      - <repo-relative-path> (+<added>/-<removed>)
      - … or one literal `(none)` bullet when zero files were modified
  - Files created:
      - <repo-relative-path> (+<line-count>)
      - … or one literal `(none)` bullet when zero files were created
  - Symbols changed:
      - <scope> <kind> <symbol-id> <change>
      - … or one literal `(none)` bullet when no symbol surface shifted
  - Skills loaded:
      - <skill-name>
      - … or one literal `(none)` bullet when task.skillsFound[] was empty
  - Invariants checked:
      - <verbatim rule> → PASS | FAIL | SKIPPED-SENTINEL
      - … or one literal `(none)` bullet when task.invariants[] was empty
  - Notes: <free text — assumptions made, anything outside scope, etc. — or `(none)`>

Do not write any files outside `task.scope.files[].path` without first
recording the deviation under `Notes` (the executor will surface it in the
execution log).
```

## Post-return: atomic rename (execute-task only, never the subagent)

The `TASK_NN.md → TASK_NN.{completed,failed}.md` rename is performed by
execute-task in the orchestrator's thread AFTER the subagent's report
returns. The subagent never invokes `git mv` or `mv` — it never touches
the task file at all. execute-task's rename code:

```bash
if git ls-files --error-unmatch "$SOURCE" >/dev/null 2>&1; then
  git mv "$SOURCE" "$TARGET"
else
  mv "$SOURCE" "$TARGET"
fi
```

The tracked-check is mandatory: `git mv` on an untracked file errors
with `fatal: not under version control`, and the rename silently drops
the file if the error is ignored. The `git ls-files --error-unmatch`
probe is the only correct way to decide between the two tools — never
hard-code one or the other.

## Why the `Symbols changed` block exists

The `code-review` qa lane probes butterfly effects at symbol granularity
via `browzer mentions <symbol-id>`. Without a structured symbol manifest
the lane has to re-derive symbol identity from the diff — expensive in
Go / TS with generics, lossy on stringly-typed dispatch, reflection, and
doc cross-links. Emitting the block here once is cheaper than re-deriving
it N times across the review lanes.

The block is language-agnostic by design:

- `scope` distinguishes `exported` (public surface — package-external
  callers can be affected) from `internal` (same-package only — no
  butterfly check needed at the global level).
- `kind` lets reviewers filter (e.g. const changes ≠ method changes).
- `symbol-id` uses `<file-path>::<dotted-name>` so the same identifier
  scheme works for Go, TypeScript, Python, Rust, etc. without per-language
  parsing.
- `change` classifies the edit: `added` and `removed` are unambiguous;
  `signature-changed` covers parameter / return / generics edits;
  `semantics-changed` covers same-signature edits whose observable
  behaviour shifted in a way that callers should re-validate.

Pure refactors that preserve all observable behaviour need not appear —
emit `(none)`. The qa lane reads silence as "no butterfly check required".

## Model / effort resolution

`execute-task` resolves model + effort BEFORE dispatching:

| Source | Value |
|---|---|
| Model | `task.suggestedModel` (default `sonnet`) |
| Effort (from `task.scope.files[].length`) | 1 → `medium`; 2–5 → `high`; 6–15 → `xhigh`; 16+ → `max` |

`Agent(subagent_type: "browzer:coder", model: <model>, effort: <effort>,
prompt: <skeleton above>)`. `subagent_type` is always `browzer:coder` — the
`task.role` only flavours the lead line, never the routing.

## Skill invocation — qualified names only

The dispatched subagent loads every entry in `task.skillsFound[]` via the
`Skill(...)` tool BEFORE writing code. **Always use the fully qualified name**
when the skill ships under a plugin namespace (e.g. `Skill(browzer:find-skills)`
not `Skill(find-skills)`). A marketplace variant commonly shadows the
unqualified name and the wrong skill loads silently. The preamble Section
"Skill invocation — use `skillsFound[].skill` verbatim" carries the rule body
and the worked example.

When `task.skillsFound[]` is empty, the subagent proceeds without `Skill(...)`
invocations — that is an explicit signal from `generate-task`, not a default.

## Trivial fast-path — no dispatch at all

When `task.trivial: true` AND all four gates in
`${CLAUDE_SKILL_DIR}/references/trivial-fast-path.md` hold, `execute-task`
performs the edits in its own thread instead of spawning a subagent. The execution-log shape is identical; only the `## Subagent report`
section is replaced with a `## Inline execution` block describing why the
fast-path was taken.

## Out-of-scope edits

The subagent must not write outside `task.scope.files[].path`. If it does, the
report's `Notes` field is the only acceptable disclosure. `execute-task` then:

1. Records the deviation in the execution log under `### Scope adjustments`.
2. Does NOT auto-flip the status to `completed` — operator review required.
3. Renames the task to `TASK_NN.failed.md` with `Failure: out-of-scope edits`
   appended to the body unless the operator approves the deviation explicitly.

## When the subagent reports a failure

The subagent returns its short report regardless of success. If `Files modified`
is empty AND no invariants were checked, or the subagent surfaced a blocker in
`Notes`, treat the dispatch as a failure: `mv TASK_NN.md → TASK_NN.failed.md`,
append `## Execution log` with the full report verbatim, and surface the
blocker to the operator on stdout.

`failed.md` is not terminal. See `${CLAUDE_SKILL_DIR}/references/trivial-fast-path.md`
for retry semantics — re-running `execute-task` against the same task appends a
new `## Retry attempt N` section to the existing `.failed.md` body; eventual
success renames `.failed.md → .completed.md` preserving the retry log.
