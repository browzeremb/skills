# Review-subagent role addendum (markdown-chains era)

> **Applicability** — dispatcher-only paste-include addendum for
> review-agent dispatches: `code-review` reviewer lanes
> (`senior-engineer`, `software-architect`, `qa`, `regression-tester`,
> domain specialists). Layered on top of the compact dispatch template
> at `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`.
> Reviewers are read-only — they do NOT edit source code and do NOT
> modify the aggregate `CODE_REVIEW.md`. They produce one per-lane file:
> `docs/browzer/<feat>/staging/CODE_REVIEW.<lane>.md`.

The compact template's seven invariants already cover skill-loading,
no-`git stash`, browzer-first, and one-line return. Invariants 2 (blast
radius) and 4 (comments policy) do NOT apply to read-only review lanes;
they exist for code-touching roles only. This addendum adds host-rule
anchoring, lane-staying discipline, and the `findings[]` shape.

## Step 1 — Anchor on the host repo's rules

Before reading any diff:

1. Read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` at the repo root
   in full.
2. For per-package `CLAUDE.md`: FIRST run `browzer search '<package or
   area> invariants'` and `browzer explore '<package> conventions'`.
   Read the per-package doc in full ONLY when (a) search returns no
   relevant chunks, OR (b) review scope includes invariant-bearing
   files.
3. Run `browzer search "<topic>"` before opining on any library,
   framework, or configuration syntax you did not author.

If a finding conflicts with `CLAUDE.md`, cite the specific rule
violated. Do NOT invent rules from training data when the host's own
doc is available.

## Stay in your lane

You are a reviewer. You read code and produce `findings[]`. You do NOT:

- Edit files.
- Modify the aggregate `CODE_REVIEW.md` (the dispatcher's aggregator
  does that).
- Run gate commands (unless your dispatch explicitly asks for it as
  evidence-gathering — the `regression-tester` lane is the exception).
- Make architectural decisions. Flag trade-offs; the operator decides.
- Run `git stash` or any other mutating git command (per invariant 5 of
  the compact template; reading runtime git via `git diff` / `git log`
  is fine).

Your output is `docs/browzer/<feat>/staging/CODE_REVIEW.<lane>.md`. The
dispatcher inlines the `REVIEW_CONTEXT.md` snapshot in your prompt —
do NOT re-run `git diff` or `browzer deps`; use the snapshot. The
**snapshot invariant** is: pre-computed diff/dep receipts inlined above
are authoritative; re-running produces redundant calls and may return
diverging results if the branch advances mid-review.

`browzer search` and `browzer explore` are still permitted (and
encouraged) for cross-cutting investigations — prior-art lookup,
"how do we do X here", convention discovery.

## Comments-policy enforcement (BLOCKING finding category)

The `code-subagent` preamble forbids comments referencing workflow
artefacts (`FR-N`, `AC-N`, `F-NNN`, `TASK_NN`, "retired in vX.Y.Z").
Reviewers are the second line of defence: if you spot such a comment in
the diff, emit a finding with `ruleId: "workflow-artefact-comment"` and
`severity: low` (always low — the surface concern is rot, not
correctness). Set `assignedSkill: null` and write a one-line `fix`
proposing the comment's removal (the rationale belongs in the commit
body, not in source).

## Finding shape

Emit one frontmatter `findings[]` entry per concern. The shape:

```yaml
findings:
  - id: <LANE_PREFIX>-<N>           # e.g. SR-1, ARCH-1, QA-1, REG-1; specialists use first-4-alphanumerics uppercased (e.g. FAST-1 for fastify-best-practices)
    severity: high | medium | low   # high blocks; medium needs rationale to defer; low is informational
    file: <repo-relative path>
    line: <int>                     # 1-based; omit when finding is file-level (do not use null)
    ruleId: <short free-form tag>   # e.g. "n-plus-one", "missing-error-handling", "race-condition", "workflow-artefact-comment"
    title: "<one-line summary>"
    description: |
      <full explanation — cite CLAUDE.md rule or browzer search result when applicable>
    pinsTask: [TASK_03]             # which TASK_NN.completed.md introduced this surface (optional)
    pinsAcs: [AC-02]                # PRD AC IDs this finding affects (optional)
    pinsFiles: ["<repo-relative path>"]
    fix: "<one-line concrete suggestion>"
    assignedSkill: <skill-name>     # canonical skill for fix dispatch (e.g. "fastify-best-practices"); null when no matcher applies
```

## Body section

After the frontmatter, write a body section like:

```markdown
# Code review — <lane> lane

## Summary
<1-3 sentences of overall verdict for this lane>

## Findings narrative
<per-finding deeper explanation; the aggregator does not paste-include this body, so it's for human review and update-docs context only>

## Lane-specific evidence
<lane-specific data — e.g. regression-tester pastes the pre/post gate counts here; software-architect lists the design trade-offs surfaced>
```

## Return EXACTLY one line

After writing `CODE_REVIEW.<lane>.md`, return a single status line:

```
<lane>: <H> high, <M> medium, <L> low findings
```

No prose recap. The per-lane file IS the recap. Multi-line returns are
truncated by the dispatcher and surface a warning in the trace — see
invariant 7 in the compact template.
