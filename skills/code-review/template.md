# Code-review templates

This file holds the two canonical artefact shapes that `code-review`
produces. Both are LLM-authored (the agent fills them) — there is no
script generating them. The `CODE_REVIEW.md` aggregate is post-processed
by `scripts/aggregate-findings.mjs`, which merges per-lane findings into
the frontmatter.

---

## A. `CODE_REVIEW.<lane>.md` — one per reviewer lane

One file per lane: `senior-engineer`, `software-architect`, `qa`,
`regression-tester`, plus any domain specialists discovered via
`Skill(browzer:find-skills)`.

### Frontmatter (REQUIRED — canonical shape)

Every lane MUST emit findings in this exact shape. The aggregator
(`scripts/aggregate-findings.mjs`) DOES accept the alias keys documented
in `references/finding-shape.md §Aliases`, but lane authors should treat
those aliases as a safety net for hand-authored drift, not a parallel
contract. Always emit the canonical keys.

```yaml
---
featureId: feat-YYYYMMDD-<slug>
lane: <senior-engineer|software-architect|qa|regression-tester|<specialist>>
diffBase: <merge-base SHA>
prdSha: <SHA carried from TASK_NN.completed.md>
generatedAt: <RFC3339>
findings:
  - id: <LANE_PREFIX>-<N>            # REQUIRED — e.g. SR-1, ARCH-1, QA-1, REG-1, FAST-1
    severity: high | medium | low    # REQUIRED
    file: <repo-relative path>        # REQUIRED — POSIX, no leading ./
    line: <int>                       # OPTIONAL — 1-based; OMIT for file-level findings
    ruleId: <short tag>               # REQUIRED — kebab-case; "general" when no specific rule applies
    title: "<one-line summary>"       # REQUIRED — ≤80 chars
    description: |                    # REQUIRED — multi-line; cite CLAUDE.md or browzer evidence
      <full explanation>
    pinsTask: [TASK_03]               # OPTIONAL; which .completed.md introduced this surface
    pinsAcs: [AC-02]                  # OPTIONAL; PRD AC IDs affected
    pinsFiles: ["<repo-relative path>"]  # REQUIRED — at least the `file` itself; >1 when fix spans files
    fix: "<one-line concrete suggestion>" # REQUIRED — actionable, ≤120 chars
    assignedSkill: <skill-name>       # OPTIONAL; null when no matcher applies
---
```

**Anti-pattern (do NOT emit):** `pin: {kind, path, startLine, endLine}`
as a single object, or `summary:` instead of `description:`. Both are
accepted by the aggregator's alias layer but normalize to the canonical
shape on read — emitting them directly defeats deduplication. See
`references/finding-shape.md §Aliases` for the full alias table.

### Body (REQUIRED)

```markdown
# Code review — <lane> lane

## Summary

<1-3 sentences of overall verdict for this lane. Quantify when possible:
"3 high-severity findings, all in <area>"; "no findings"; "1 medium related
to <pattern>".>

## Findings narrative

<For each finding in frontmatter (in id order), one sub-section:>

### <id> — <title>

<Free-form explanation. Cite the CLAUDE.md rule or browzer search result
you used. Show the relevant diff hunk inline as a fenced code block when
helpful. The aggregator does NOT paste-include this body, so it serves
human review and update-docs context — be thorough.>

## Lane-specific evidence

<For regression-tester: paste the pre/post gate counts and reference
REGRESSION_RESULTS.md.
For software-architect: list design trade-offs surfaced.
For senior-engineer: cyclomatic / DRY / clean-code observations.
For qa: butterfly-effect summary citing `browzer mentions` results.
For domain specialists: skill-specific evidence.>
```

---

## B. `CODE_REVIEW.md` — LLM-authored aggregate

Written by the dispatcher (the `code-review` skill itself) after all lane
files exist. Its frontmatter is also touched by `aggregate-findings.mjs` to
inject the deduped findings list.

### Frontmatter (REQUIRED)

```yaml
---
featureId: feat-YYYYMMDD-<slug>
diffBase: <merge-base SHA>
prdSha: <SHA mirrored from CODE_REVIEW.<lane>.md>
generatedAt: <RFC3339>
totalFindings: <int>
severityCounts:
  high: <int>
  medium: <int>
  low: <int>
sensitivePathGate:
  matched: true | false
  matchedFiles: ["<repo-relative path>"]
findings:                              # script-merged from per-lane files (preserve-all algorithm)
  - id: F-001
    mergedFrom: ["SR-3", "QA-1"]
    severity: high
    lane: senior-engineer
    file: <repo-relative path>
    line: 42
    ruleId: <short tag>
    title: "<one-line summary>"
    description: |
      <full explanation>
    pinsTask: [TASK_03]
    pinsAcs: [AC-02]
    pinsFiles: ["<repo-relative path>"]
    fix: "<one-line suggestion>"
    assignedSkill: <skill-name|null>
laneFiles:
  senior-engineer: CODE_REVIEW.senior-engineer.md
  software-architect: CODE_REVIEW.software-architect.md
  qa: CODE_REVIEW.qa.md
  regression-tester: CODE_REVIEW.regression-tester.md
---
```

### Body (REQUIRED)

```markdown
# Code review — aggregate

## Verdict

<one-liner: "X high, Y medium, Z low findings — review-gate <pass|conditional|block>". `block` when high > 0; `conditional` when medium > 0 and high == 0; `pass` when all zero.>

## Sensitive-path gate

<matched yes/no, list matched files when present>

## Per-lane summary

- [senior-engineer](CODE_REVIEW.senior-engineer.md) — <H>/<M>/<L> findings
- [software-architect](CODE_REVIEW.software-architect.md) — <H>/<M>/<L> findings
- [qa](CODE_REVIEW.qa.md) — <H>/<M>/<L> findings
- [regression-tester](CODE_REVIEW.regression-tester.md) — <H>/<M>/<L> findings
- (domain specialists, if any)

## Orphan findings

<only when some finding has empty pinsTask[]>

## Next phase

<short pointer: "Run /receiving-code-review feat-YYYYMMDD-<slug>" when
totalFindings > 0; "Skip to /write-tests feat-..." otherwise.>
```

---

## Cross-reference invariants

1. Every `findings[].file` in CODE_REVIEW.md MUST be one of the files touched in `### Files modified` or `### Files created` of at least one `TASK_*.completed.md`. The orphan-findings sub-section lists exceptions.
2. Every `findings[].pinsTask[]` entry MUST reference an existing `TASK_NN.completed.md` (NOT `.failed.md`).
3. `prdSha` in `CODE_REVIEW.md` MUST equal `prdSha` in EVERY consumed `TASK_*.completed.md`. Mismatch is a hard halt.
4. Every `mergedFrom[]` ID MUST be one of the lane-prefixed IDs from a per-lane file. Orphan `mergedFrom[]` entries indicate aggregator drift.
5. `severityCounts` MUST equal the actual count of findings at each severity in the merged list.
