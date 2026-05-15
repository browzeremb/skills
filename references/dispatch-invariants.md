# Dispatch invariants — single source of truth

Every dispatcher skill (`execute-task`, `code-review`, `receiving-code-review`, `write-tests`, `finalize-feature`, `orchestrate-task-delivery`) Reads this file once per dispatch wave and composes its dispatch prompts by substituting the placeholders below. The legacy paste-include of `subagent-preamble.md` is retired by this closed set; the long-form rationale still lives in `references/subagent-preamble.md` but is reached by path-reference only.

## Operative invariants (closed set)

1. **SKILLS (BLOCKING).** For each entry in `{{skills}}`, call `Skill(<exact-name>)` BEFORE any Read/Edit/Write/Bash. Use the fully qualified name when the skill ships under a plugin namespace (e.g. `Skill(browzer:find-skills)`, never `Skill(find-skills)`). Empty list ⇒ skip. Skipping any listed skill is a contract violation; the dispatcher may downgrade status to `skill-bypass`.

2. **BLAST RADIUS (BLOCKING for code-touching roles).** For each file in `{{files}}`, run a dependency-graph reverse-probe (`browzer deps "<file>" --reverse --json --save /tmp/rdeps-<sanitized-path>.json`) BEFORE editing. Sanitized path is `$(echo "<file>" | tr '/' '_')`. Generated files (`*.gen.*`, `vendor/**`, `*.pb.go`, `*.schema.json`) are exempt. Skip on review-only or read-only roles.

3. **SCOPE.** Touch only files in `{{files}}`. Never touch `{{out-of-scope}}` even when a refactor there would be cleaner. Integration glue ≤15 lines (a barrel export, a one-line import, a config key) is permitted in adjacent files; disclose under `### Scope adjustments`.

4. **COMMENTS POLICY (BLOCKING for code-touching roles).** Add a comment only when the WHY of a line is non-obvious to a future reader who lacks this session's context. Do NOT reference workflow artefact IDs (FR-N, AC-N, F-NNN, TASK_NN), retired feature names, version-trajectory phrases ("as of vX.Y.Z", "retired in vX.Y.Z"), the current task, or sibling fixes. Why-this-changed rationale belongs in the commit body, not in source. Self-audit before declaring done: a regex grep over the touched files for `FR-[0-9]+|AC-[0-9]+|F-[0-9]{3}|TASK_[0-9]{2}|retired in v` MUST return empty.

5. **NO `git stash`.** The dispatcher's brief inlines every baseline you need (pre-change file content, baseline gate counts). Never run `git stash` — it mutates a global shell state and races across parallel lane dispatches. Where comparing against `origin/main` is necessary, use `git show origin/main:<path>` (non-mutating). Reading runtime git is fine; mutating it is forbidden.

6. **DISCOVER FIRST, training data LAST.** For every library / framework / config syntax you touch: run a workspace-doc search and a symbol-graph search BEFORE consulting training data. Note any training-data assumption verbatim under `### Scope adjustments`.

7. **RETURN SHAPE.** After your structured report lands, return EXACTLY ONE LINE. Any additional prose is a contract violation — the dispatcher truncates at the first newline and surfaces a warning. The structured report (per the return-shape footer below) is the canonical record; the one-line return is only a status summary.

For the rationale behind each invariant, see `references/subagent-preamble.md`. Do NOT re-read it during a dispatch — every operative rule is above.
