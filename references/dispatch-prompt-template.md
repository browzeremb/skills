# Dispatch prompt template — compact per-lane composer

> **Applicability** — `<thread-or-subagent>: dispatcher-only`. Used by every
> skill that spawns `Agent(...)` / `Task(...)`: `execute-task`,
> `code-review`, `receiving-code-review`, `write-tests`, `update-docs`,
> `finalize-feature`. Replaces the legacy "paste-include the entire
> `references/subagent-preamble.md` verbatim" path. The long-form
> contract still lives in `subagent-preamble.md`; this template is the
> *runtime* shape — concise, parameterised, one composition per dispatch.

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
3. **Optional lane-specific addendum** — e.g. the lane persona for a
   code-review reviewer, the iteration-ladder pointer for a fixer.
4. **Task body** — verbatim contents of the closed prompt (`TASK_NN.md`
   for `execute-task`; the per-finding FIX BRIEF for `receiving-code-review`;
   the per-doc DOC BRIEF for `update-docs`).
5. **Return-shape footer** — one or two lines naming the structured
   blocks the subagent must emit (`### Files modified`, `### Symbols
   changed`, etc.) and the one-line return.

The dispatcher MUST emit ONLY these five blocks. No prose preamble
explaining the chain, no "you are working in a Browzer-indexed
workspace" boilerplate — the subagent's host already injects that.

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
| doc-writer (update-docs) | `You are a documentation patcher for feature {{featureId}}. Apply the structured DOC PATCHES below to the existing docs named in the brief.` |
| explorer (any) | `You are a read-only explorer for feature {{featureId}}. Run the discovery queries below and write the JSON receipts named in the brief.` |

The lead line is ONE sentence. Multi-sentence leads encourage the
subagent to narrate; one sentence keeps it acting.

---

## Per-role return-shape footer examples

| Role | Footer block |
|---|---|
| coder | `Return shape — emit a structured "## Subagent report" block with sections: Outcome, Files modified, Files created, Symbols changed, Baseline gates, Invariants checked, Scope adjustments, Failure (only when failed). Regex shapes in ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md. Then return ONE LINE: <skill>: outcome=...; files=...; symbols=...` |
| code-reviewer | `Return shape — write docs/browzer/{{featureId}}/staging/CODE_REVIEW.{{lane}}.md (frontmatter findings[] + body). Then return ONE LINE: {{lane}}: <H> high, <M> medium, <L> low findings.` |
| fixer | `Return shape — write FIX_{{findingId}}.completed.md (success) or FIX_{{findingId}}.tech_debt.md (exhausted). Then return ONE LINE: fixer: {{findingId}} <fixed|tech_debt>; ladder=<N>; model=<sonnet|opus|null>.` |
| tester | `Return shape — write TESTS.md aggregate (frontmatter testsAdded[] + body coverage log). Then return ONE LINE: tester: <N> tests added; kill-rate <pct>%.` |
| doc-writer | `Return shape — emit a JSON patch summary to /tmp/update-docs-{{featureId}}-patch-summary.json. Then return ONE LINE: doc-writer: <N> docs patched; <M> skipped (no drift).` |
| explorer | `Return shape — write receipt files to the paths in the brief. Then return ONE LINE: explorer: <N> receipts written.` |

---

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
| Total prompt size < 30 % of the model's context budget | bloated prompt ⇒ degraded reasoning |
| No literal `subagent-preamble.md` content in the prompt body (the file path may appear once at the bottom of the invariants block; its content must not) | regression to the legacy paste-include path |

A failing self-test aborts the dispatch and surfaces a precise error to
the orchestrator — never silently fall back.
