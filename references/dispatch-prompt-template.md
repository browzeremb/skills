# Dispatch prompt template — compact per-lane composer

> **Applicability** — `<thread-or-subagent>: dispatcher-only`. Used by every
> skill that spawns `Agent(...)` / `Task(...)`: `execute-task`,
> `code-review`, `receiving-code-review`, `write-tests`,
> `finalize-feature`. Replaces the legacy "paste-include the entire
> `references/subagent-preamble.md` verbatim" path. The long-form
> contract still lives in `subagent-preamble.md`; this template is the
> *runtime* shape — concise, parameterised, one composition per dispatch.

> **Upstream source-of-truth**: the operative invariants block below is the runtime composer. The closed-set authoritative list lives in `${CLAUDE_PLUGIN_ROOT}/references/dispatch-invariants.md`. Edit there first; this template substitutes placeholders, not invariant text.

## Why this exists

`subagent-preamble.md` is ~170 lines of human-readable contract. Paste-
including it verbatim into N parallel dispatches costs ~25 k redundant
tokens per session and trains subagents to skim the same headings
instead of acting. This template encodes only the **operative
invariants** at the top of the dispatch prompt and references the
long-form doc by path for any subagent that needs the rationale.

## Composition order (top to bottom of the dispatch prompt)

A dispatcher composes a prompt by concatenating these blocks in order:

1. **Role lead line** — one sentence naming the role and the scope.
2. **Compact invariants block** — the canonical 7-rule list below, with
   `{{skills}}`, `{{files}}`, `{{out-of-scope}}` filled in.
3. **Absolute-path injection block** (BLOCKING) — the staging directory
   absolute path AND the deliverable absolute path. The dispatcher MUST
   compute these once from `$REPO_ROOT/docs/browzer/<featureId>/staging/`
   and inject them verbatim — never let the subagent compute its own
   path from a relative cwd. See "Absolute-path injection" below for the
   exact shape. This block closes the path-discipline class observed in
   both RETRO §2.1 and JUDGMENT §3.4 #3 (fixers writing to feat-root
   instead of `staging/`).
4. **Optional lane-specific addendum** — e.g. the lane persona for a
   code-review reviewer, the iteration-ladder pointer for a fixer.
5. **Task body** — verbatim contents of the closed prompt (`TASK_NN.md`
   for `execute-task`; the per-finding FIX BRIEF for
   `receiving-code-review`; etc.).
6. **Return-shape footer** — one or two lines naming the structured
   blocks the subagent must emit (`### Files modified`, `### Symbols
   changed`, etc.) and the one-line return. Includes the
   `### artifactsWritten` block (absolute paths to every file the
   subagent created or modified) — the dispatcher uses this to validate
   the file-write contract per "File-write contract enforcement" below.

The dispatcher MUST emit ONLY these six blocks. No prose preamble
explaining the chain, no "you are working in a Browzer-indexed
workspace" boilerplate — the subagent's host already injects that.

---

## CWD discipline (orchestrator-side invariant)

The Claude Code Bash tool **persists `cwd` across calls in the same
session**. A previous `cd packages/cli && go test ./...` leaves the next
Bash call resolving paths relative to `packages/cli/` — including
`node docs/browzer/<feat>/...` invocations the orchestrator makes for
`detect-phase.mjs`, agregadores, etc. JUDGMENT §3.4 #4 / J5 documents
the resulting cycle: detect-phase resolved its feat folder relative to
the wrong root, returned `state: no-feat-folder`, and the orchestrator
re-prompted the operator for the same featureId until the operator
re-issued with `cd $REPO_ROOT` prefix.

The dispatcher contract:

1. **Always pass absolute paths.** Resolve `$REPO_ROOT` once per session
   via `git rev-parse --show-toplevel`. All Bash invocations of
   pipeline scripts use absolute paths derived from it.
2. **Or prefix with subshell `cd`.** When an absolute path is awkward
   (e.g. a script that expects relative cwd to its package), use a
   subshell: `(cd "$REPO_ROOT" && node …)`. The parentheses isolate the
   cwd change from the outer shell so the next Bash call resumes from
   the prior cwd.
3. **Never write a top-level `cd …`** at the start of an orchestrator-
   level Bash command. The cwd change leaks to subsequent commands and
   causes the path-resolution failure class above.

This invariant applies to the orchestrator's own Bash calls AND to any
helper script the orchestrator invokes. Subagents have their own
cwd-isolation (each `Agent(...)` starts with a fresh cwd), so this
specifically guards orchestrator-thread Bash usage.

## Absolute-path injection (BLOCKING block 3)

The dispatcher computes once per dispatch and inlines verbatim:

```text
ABSOLUTE PATHS (do not compute relative paths from cwd):

  REPO_ROOT:      {{repoRoot}}
  STAGING_DIR:    {{stagingDir}}
  DELIVERABLE:    {{deliverableAbsolutePath}}

Your single output file MUST be written to DELIVERABLE above. Never write
to feat-root, never use a path relative to your current cwd, never assume
the dispatcher's cwd is `{{stagingDir}}`. The Bash tool's cwd persists
across calls; relying on cwd is the path-discipline class the dispatcher
contract closes.
```

Substitutions:

- `{{repoRoot}}` — `git rev-parse --show-toplevel` resolved by the
  dispatcher.
- `{{stagingDir}}` — `${repoRoot}/docs/browzer/${featureId}/staging`.
- `{{deliverableAbsolutePath}}` — per role:
  - coder (execute-task) → none (coder edits in place; the structured
    report is in the return-shape footer's `## Subagent report` block,
    not a separate file).
  - fixer → `${stagingDir}/FIX_${findingId}.completed.md` (success) OR
    `${stagingDir}/FIX_${findingId}.tech_debt.md` (exhausted).
  - code-reviewer → `${stagingDir}/CODE_REVIEW.${lane}.md`.
  - tester → `${stagingDir}/TESTS.md`.
  - explorer → receipt paths from the brief (one path per query, named
    in the brief's `--save` lines).

Skills that previously inlined a relative `staging/<file>` reference
MUST migrate to this block. The relative-path fallback class is
documented in RETRO §2.1 + JUDGMENT §3.4 #3 as the single largest
source of "fixer wrote to wrong directory" issues.

---

## File-write contract enforcement (BLOCKING, post-dispatch)

When the subagent returns, the dispatcher MUST validate the file-write
contract BEFORE proceeding to the next phase:

1. **Parse `### artifactsWritten` from the subagent return.** Each line
   is `- <absolute-path>`. Empty section is a contract violation.
2. **Verify each path exists on disk.** `fs.existsSync` against the
   absolute path. Missing file → contract violation.
3. **Verify the deliverable path is in `artifactsWritten`.** When a
   deliverable was promised in block 3, it MUST appear. When absent →
   inline-return drift (the subagent returned findings/fixes/execution
   log inline as text instead of writing the file).

### Inline-return drift recovery (RETRO §10 + JUDGMENT §3.2)

When inline-return drift is detected, the dispatcher has TWO options,
in this order of preference:

- **Option A (preferred, zero re-dispatch)**: persist the subagent's
  inline output to the deliverable path verbatim. The subagent's
  structured frontmatter + body, as returned, is written to disk by
  the dispatcher. Then proceed to the next phase. This avoids the
  ~30-100k tokens / 3+ min wall-clock penalty of a re-dispatch.
- **Option B (last resort)**: re-dispatch the same role with an
  explicit `"Write the file at <DELIVERABLE> or fail. Do not return
  findings inline."` directive. Used only when Option A's inline
  parse fails (e.g. the subagent's return is not a coherent file body).

Memory-is-context-not-substitute clause: the subagent's persistent
memory (`.claude/agent-memory/<role>.md`) is read-only context, never
a reason to skip a deliverable. When the agent's memory implies the
file already exists, the dispatch contract still requires the file to
be written on this run. Cached memory does not substitute for the
dispatched contract.

---

## Canonical compact invariants block

Paste verbatim into every dispatch (substitute `{{...}}` placeholders).
Total length ≈ 30 lines when expanded.

```text
You are the {{role}} for {{featureId}}{{taskOrLane}}. Stay inside the file scope listed below.

INVARIANTS — non-negotiable, in this order:

1. SKILLS (BLOCKING). For each entry in {{skills}}, call `Skill(<exact-name>)` BEFORE any Read/Edit/Write/Bash. Use the fully qualified name when the skill ships under a plugin namespace (e.g. `Skill(browzer:find-skills)`, never `Skill(find-skills)`). Empty list ⇒ skip. Skipping any listed skill is a contract violation; the dispatcher may downgrade status to `skill-bypass`.

2. BLAST RADIUS (BLOCKING for code-touching roles). For each file in {{files}}, run `browzer deps "<file>" --reverse --json --save /tmp/rdeps-<sanitized-path>.json` BEFORE editing. Sanitized path is `$(echo "<file>" | tr '/' '_')`. Generated files (`*.gen.*`, `*.pb.go`, `vendor/**`, `*.schema.json`) are exempt. Skip this step on review-only or read-only roles.

3. SCOPE. Touch only files in {{files}}. Never touch {{out-of-scope}} even when a refactor there would be cleaner. Integration glue ≤15 lines (a barrel export, a one-line import, a config key) is permitted in adjacent files; disclose under `### Scope adjustments`.

4. COMMENTS POLICY (BLOCKING for code-touching roles). Add a code comment only when the WHY of a line is non-obvious to a future reader who lacks this session's context. Do NOT reference workflow artefact IDs (FR-N, AC-N, F-NNN, TASK_NN), retired feature names, version-trajectory phrases ("as of vX.Y.Z", "retired in vX.Y.Z"), the current task, or sibling fixes. Why-this-changed rationale belongs in the commit body, not in source. Self-audit before declaring done: `grep -E "FR-[0-9]+|AC-[0-9]+|F-[0-9]{3}|TASK_[0-9]{2}|retired in v" <files-you-touched>` MUST return empty.

5. NO `git stash`. The dispatcher's brief inlines every baseline you need (pre-change file content, baseline gate counts). Never run `git stash` — it mutates a global shell state and races across parallel lane dispatches. Where comparing against `origin/main` is necessary, use `git show origin/main:<path>` (non-mutating). Reading runtime git is fine; mutating it is forbidden.

6. BROWZER FIRST, training data LAST. For every library / framework / config syntax you touch: `browzer search "<topic>" --save /tmp/...` then `browzer explore "<symbol>" --save /tmp/...` BEFORE consulting training data. Note any training-data assumption verbatim under `### Scope adjustments`.

7. RETURN SHAPE. After your structured report lands, return EXACTLY ONE LINE. Any additional prose is a contract violation — the dispatcher truncates at the first newline and surfaces a warning. The structured report (per the return-shape footer below) is the canonical record; the one-line return is only a status summary.

For the rationale behind each invariant, see ${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md. Do NOT re-read it during this dispatch — every operative rule is above.
```

---

## Per-role role-lead-line examples

| Role | Lead line |
|---|---|
| coder (execute-task) | `You are a {{task.role}} implementation specialist. Implement TASK_{{taskId}} for feature {{featureId}} per the closed prompt below.` |
| coder (receiving-code-review fixer) | `You are a post-review fixer for finding {{findingId}} in feature {{featureId}}. Close the finding through the escalation ladder.` |
| code-reviewer (lane) | `You are the {{lane}} reviewer for feature {{featureId}}. Produce CODE_REVIEW.{{lane}}.md.` |
| tester (write-tests) | `You are a test author for feature {{featureId}}. Add coverage for the symbols listed below and verify the suite kills mutants across the 6 mutation categories.` |
| explorer (any) | `You are a read-only explorer for feature {{featureId}}. Run the discovery queries below and write the JSON receipts named in the brief.` |

The lead line is ONE sentence. Multi-sentence leads encourage the
subagent to narrate; one sentence keeps it acting.

---

## Per-role return-shape footer examples

Every role's footer concludes with the canonical `### artifactsWritten`
block — one absolute path per line — so the dispatcher can validate the
file-write contract (see "File-write contract enforcement" above).

| Role | Footer block |
|---|---|
| coder | `Return shape — emit a structured "## Subagent report" block with sections: Outcome, Files modified, Files created, Symbols changed, Baseline gates, Invariants checked, Scope adjustments, browzer queries run, Failure (only when failed), artifactsWritten. Regex shapes in ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md. Then return ONE LINE: <skill>: outcome=...; files=...; symbols=...` |
| code-reviewer | `Return shape — write the file at DELIVERABLE (absolute path from block 3). Then emit "### artifactsWritten" with that path. Then return ONE LINE: {{lane}}: <H> high, <M> medium, <L> low findings.` |
| fixer | `Return shape — write the file at DELIVERABLE (absolute; .completed.md on success, .tech_debt.md when exhausted). Then emit "### artifactsWritten" with that path. Then return ONE LINE: fixer: {{findingId}} <fixed|tech_debt>; ladder=<N>; model=<sonnet|opus|null>.` |
| tester | `Return shape — write the file at DELIVERABLE (absolute). Then emit "### artifactsWritten" with that path plus any test files created. Then return ONE LINE: tester: <N> tests added; kill-rate <pct>%.` |
| doc-writer | `Return shape — emit a JSON patch summary to DELIVERABLE (absolute /tmp path). Then emit "### artifactsWritten" with every doc file patched. Then return ONE LINE: doc-writer: <N> docs patched; <M> skipped (no drift).` |
| explorer | `Return shape — write receipt files to the absolute paths named in the brief. Then emit "### artifactsWritten" with every receipt path. Then return ONE LINE: explorer: <N> receipts written.` |

### artifactsWritten block — canonical shape

```text
### artifactsWritten

- /abs/path/to/docs/<featId>/staging/<deliverable>.md
- /abs/path/to/<file-2-touched>
```

When the role made no on-disk changes (rare; explorer with `--no-save`,
review-only smoke runs), emit:

```text
### artifactsWritten

- (none)
```

The dispatcher's post-dispatch validator rejects any return that
lacks this block. See "File-write contract enforcement" above.

---

## `browzer mentions` cross-phase receipt reuse

Subagents that issue `browzer mentions <path>` MUST pass `--save` so
the receipt is reusable across phases. The CLI verb takes a file path
(see `packages/cli/internal/commands/mentions.go` — `Use: "mentions
<path>"`); passing a bare symbol exits non-zero with `mentions requires
a <path> argument`.

```bash
browzer mentions <path> --json --save /tmp/mentions-<sanitized-path>.json
```

The dispatcher inlines this hint when a brief expects a `mentions`-style
probe (code-review qa lane, finalize-feature Phase A inline discovery).
The `<sanitized-path>` token is the file path with `/` → `-` and any
non-alnum byte stripped, so two phases looking up the same path land
on the same `/tmp/` receipt and pay the network cost exactly once. The
dedicated Node-side cache helper was removed in
`feat-20260514-hooks-shell-port`; the `--save` receipt is the canonical
reuse mechanism.

## What the dispatcher promises

By using this template, the dispatcher commits to:

- **Inlining every baseline the subagent needs** — pre-change file
  content (so the subagent never reaches for `git stash`), the
  per-file `blastRadius.reverse[]` snapshot (so it doesn't re-run
  `browzer deps` unnecessarily), the diff snapshot (for review lanes),
  the verbatim AC/FR text (so the subagent never reads `PRD.md`).
- **Setting `out-of-scope` explicitly** — never leaving it implicit.
- **Truncating subagent return at the first newline** — keeps the
  one-line contract enforceable.
- **Not paste-including `subagent-preamble.md`** — its long-form
  rationale is one path-reference away when the subagent needs it.

---

## Migration note for skill authors

Skills that previously used the pattern:

```bash
# OLD — paste-include the universal preamble verbatim
PREAMBLE=$(cat "${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md")
PROMPT="${LEAD_LINE}

${PREAMBLE}

${TASK_BODY}

${RETURN_TRAILER}"
```

migrate to:

```bash
# NEW — fill the compact template with task-specific values
PROMPT="$(node "${CLAUDE_PLUGIN_ROOT}/references/scripts/compose-dispatch-prompt.mjs" \
  --role coder \
  --feature-id "$FEAT_ID" \
  --task-id "$TASK_ID" \
  --skills "$SKILLS_JSON" \
  --files "$FILES_JSON" \
  --out-of-scope "$OUT_OF_SCOPE_JSON" \
  --task-body-file "$TASK_FILE" \
  --return-shape coder)"
```

When no helper script ships with the plugin, the skill author MUST inline
the compact invariants block verbatim (substituting placeholders) rather
than fall back to the legacy paste-include path.

---

## Self-test before dispatch

Before spawning the agent, the dispatcher verifies:

| Check | Failure mode |
|---|---|
| `{{skills}}` placeholder is a JSON array (possibly empty), never the literal string `skillsFound[]` | unfilled template ⇒ silent skill bypass |
| `{{files}}` placeholder is a JSON array of at least one path | scope-less dispatch ⇒ subagent improvises scope |
| `{{out-of-scope}}` placeholder is present (may be empty array) | omitted ⇒ subagent assumes everything is in-scope |
| `{{repoRoot}}` and `{{stagingDir}}` are absolute paths starting with `/` | relative path ⇒ subagent writes to wrong directory |
| `{{deliverableAbsolutePath}}` is absolute AND starts with `{{stagingDir}}` (when role expects a deliverable) | non-absolute or off-staging ⇒ artifacts leak to feat-root or `/tmp` |
| Total prompt size < 30 % of the model's context budget | bloated prompt ⇒ degraded reasoning |
| No literal `subagent-preamble.md` content in the prompt body (the file path may appear once at the bottom of the invariants block; its content must not) | regression to the legacy paste-include path |

A failing self-test aborts the dispatch and surfaces a precise error to
the orchestrator — never silently fall back.

## Post-dispatch validation

After the subagent returns:

| Check | Failure mode | Recovery |
|---|---|---|
| Return contains a `### artifactsWritten` block | inline-return drift | Option A (persist inline) or Option B (re-dispatch) per "Inline-return drift recovery" above |
| Every absolute path in `artifactsWritten` exists on disk | subagent claimed write but file is absent | re-dispatch with explicit `"Write the file at <path> or fail"` |
| The deliverable absolute path is one of the `artifactsWritten` entries | wrong-path drift | Option A (move file from where it was written to deliverable) OR re-dispatch |
| No `artifactsWritten` entry is outside `{{stagingDir}}` (for staging deliverables) | feat-root or random-cwd writes | move file into staging; warn operator |
