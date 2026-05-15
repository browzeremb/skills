---
name: judge-skill-runs
description: "Pull observability traces for a Browzer feature run and grade the quality of the plugin skills that executed during `orchestrate-task-delivery`. Use when the operator asks to 'judge', 'evaluate', 'score', 'audit', or 'review' a feature run — typical phrasings include 'judge feat-X', 'score the skills for this run', 'how did code-review / receiving-code-review / feature-acceptance perform', 'post scores for the last orchestrator run', 'audit run quality', or 'grade skill performance'. Always operates on a specific `feat-<slug>` from `docs/browzer/`. Evaluates each skill phase against its artifact contract, posts categorical and numeric scores, persists a markdown report at `docs/browzer/<feat>/JUDGMENT.md`, and returns the report ranked by skill plus three highest-leverage improvements. Use proactively after any orchestrator-driven feature lands and the operator wants signal on plugin skill quality, not just code correctness."
argument-hint: "feat-<slug>"
allowed-tools: Bash Read Write
---

# Judge Skill Runs

You evaluate the quality of Browzer plugin skills using observability traces
emitted during an `orchestrate-task-delivery` run for a specific feature slug.

## Inputs

- **Argument** (optional but strongly preferred): `feat-<slug>` — the feature
  identifier matching a directory under `docs/browzer/`.
- **Filesystem artifacts**: every phase artifact written to
  `docs/browzer/<feat>/staging/` during the run.
- **Observability backend** (optional): if a trace-collection integration is
  wired in the host workspace, pull traces filtered to `feature:<slug>` and
  use them to verify agent dispatch, token budgets, and elapsed time.
  If no integration is present, derive all verdicts from filesystem artifacts
  alone — do NOT fabricate trace IDs or metadata.

## Outputs

1. A markdown assessment report emitted to the conversation.
2. `docs/browzer/<feat>/JUDGMENT.md` — byte-identical to the conversation
   report, prefixed with a provenance comment. Idempotent: re-running
   overwrites cleanly.
3. Scores posted to whichever observability backend is wired (skip gracefully
   when none).

Closure line after writing (emit verbatim):

```
judge-skill-runs: report written to docs/browzer/<slug>/JUDGMENT.md;
<N> contract violations; verdict=<verdict>
```

---

## Phase 1 — Discovery

If the operator passed the slug as an argument, use it. Otherwise list
candidates:

```bash
ls docs/browzer/ | grep '^feat-'
```

Confirm the slug before pulling anything.

Verify the feature run exists on disk:

```bash
ls docs/browzer/<slug>/staging/ 2>/dev/null | head -30
ls docs/browzer/<slug>/ 2>/dev/null
```

If neither `docs/browzer/<slug>/staging/` nor any `TASK_*.completed.md`
yields results, stop — there is nothing to judge.

---

## Phase 2 — Pull traces (when a trace backend is configured)

A trace backend is optional. If the host workspace has one configured,
filter by `feature:<slug>` to exclude unrelated sessions. If no backend is
present or returns no data, continue with filesystem-only scoring and note
the gap under "Observability coverage" in the report. Never fabricate trace
IDs or metadata.

---

## Phase 3 — Per-phase artifact rubric

This rubric covers every artifact produced by the full
`orchestrate-task-delivery` pipeline. For each phase, score
`skill-phase-completion` and increment `skill-contract-violations` per the
checks below. All paths are relative to `docs/browzer/<feat>/` unless noted.

Frontmatter contract per artifact: verify required keys against
`${CLAUDE_PLUGIN_ROOT}/references/phase-frontmatter.md`.

### PRD — `docs/browzer/<feat>/staging/PRD.md`

Read `docs/browzer/<feat>/staging/PRD.md` to verify:

- File exists and is non-empty.
- Required frontmatter keys present (see `references/phase-frontmatter.md`).
- Acceptance criteria are testable — contain a metric, threshold, or
  observable. Vague ACs ("should be fast") = +1 violation each.
- `skillsFound[]` entries are verifiable on disk under
  `packages/skills/skills/<name>/SKILL.md` or in installed plugins.
  +1 violation per fictional or missing skill name.

### EXPLORATION.md — `docs/browzer/<feat>/staging/EXPLORATION.md`

Read `docs/browzer/<feat>/staging/EXPLORATION.md` to verify:

- File exists.
- Required frontmatter keys present (`featureId`, `prdSha`, `scoper`,
  `skillsFound[]`, `files[]`).
- `skillsFound[]` names are invocable (no marketplace URLs, no `url:` keys).
- `prdSha` matches current `docs/browzer/<feat>/staging/PRD.md` SHA.

### TASK_NN.md files — `docs/browzer/<feat>/staging/TASK_NN.md`

For each `TASK_NN.completed.md` (or `TASK_NN.failed.md`) under
`docs/browzer/<feat>/staging/`, verify:

- Required frontmatter keys present (see `references/phase-frontmatter.md`).
- `## Execution log` section appended.
- `### Files modified` and `### Files created` bullets follow the rigid shape
  (`(+N/-N)` and `(+N)` suffixes respectively).
- `### Symbols changed` section present (a single `(none)` bullet is valid).
- `### Invariants checked` section present.
- Task-level violations: per-task `plugin-agnosticism` prefix in dispatch
  prompt when scope includes `skills/*/SKILL.md`. Missing = +1 violation.

### CODE_REVIEW.md — `docs/browzer/<feat>/staging/CODE_REVIEW.md`

Read `docs/browzer/<feat>/staging/CODE_REVIEW.md` to verify:

- File exists.
- Required frontmatter keys present.
- Four per-lane sections present (senior-engineer, software-architect, qa,
  regression-tester). Each missing lane = +1 violation.
- `sensitivePathGate` field present. Missing = +1 violation.
- `regressionEvidence` block populated (non-empty). Empty `{}` = +1 violation.

### RECEIVING_CODE_REVIEW.md — `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.md`

Read `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.md` to verify:

- File exists.
- Required frontmatter keys present.
- `summary.fixed + summary.techDebt == total findings`. Mismatch = +1.
- `techDebtBreakdown` present with `scopeDeferred + ladderExhausted ==
  summary.unrecovered`. Missing or mismatched = +1 violation.

### TESTS.md — `docs/browzer/<feat>/staging/TESTS.md`

Read `docs/browzer/<feat>/staging/TESTS.md` to verify:

- File exists, OR an explicit skip marker is present.
- When not skipped: results cover all 6 mutation categories — `boolean`,
  `conditional`, `arithmetic`, `boundary`, `off-by-one`, `return-value`.
  Each missing category = +1 violation.
- Survived mutants each carry a `rationale` field. Missing = +1 per mutant.
- Top-level `mutationScore`, `killed`, `survived`, `categories[]` present
  when `mutationSkipped: false`. Each missing field = +1 violation.

### DOC_PATCHES.md — `docs/browzer/<feat>/staging/DOC_PATCHES.md`

Read `docs/browzer/<feat>/staging/DOC_PATCHES.md` to verify:

- File exists.
- Required frontmatter keys present.
- `enoentFixed` field present (empty array is valid, `null` is not).
- No new `*.md` files created — doc patches apply to existing docs only.
  New doc = +1 violation per file.

### ACCEPTANCE.md — `docs/browzer/<feat>/staging/ACCEPTANCE.md`

Read `docs/browzer/<feat>/staging/ACCEPTANCE.md` to verify:

- File exists.
- `mode` is one of `autonomous | autonomous-with-stack-boot | hybrid |
  manual`. Missing or out-of-enum = +1 violation.
- `verdict` is one of `completed | paused-pending-operator | stopped`.
- `modeNote` present (capability probe summary). Missing = +1 violation.
- Any AC whose verbatim text matches `/render|display|visible|UI/i` MUST NOT
  carry `coversAcceptanceSignal: "deferred-post-merge"`. Offending AC =
  +1 violation each.

### README.md — `docs/browzer/<feat>/README.md`

Read `docs/browzer/<feat>/README.md` to verify:

- File exists at the feature root (`docs/browzer/<feat>/README.md`), NOT
  inside `staging/`. Wrong location = +1 violation.
- Contains only canonical H2 headings in the expected order. For the
  authoritative closed-set, see
  `${CLAUDE_PLUGIN_ROOT}/references/canonical-readme-h2.md` — do NOT
  enumerate the H2 list inline here. Each missing canonical H2 = +1
  violation; each non-canonical H2 = +1 violation.

---

## Phase 4 — Agent dispatch quality

For each phase, verify the typed agent dispatch contract against trace
observations (or execution-log evidence in `TASK_NN.completed.md`).

| Phase | Expected agent | Violation if |
|---|---|---|
| PRD | `browzer:pm` | Skill tool used directly OR `general-purpose` |
| Tasks | `browzer:po` | Skill tool used directly OR `general-purpose` |
| execute-task | `browzer:coder` | `general-purpose` OR `browzer:browzer` |
| code-review | `browzer:code-reviewer` ×4 | fewer than 4 parallel dispatches |
| receiving-code-review | `browzer:fixer` | `general-purpose` |
| write-tests | `browzer:tester` | `general-purpose` |
| update-docs Phase A | `browzer:explorer` | `general-purpose` |
| update-docs Phase B | `browzer:doc-writer` | `general-purpose` |

Routing-loop detection (hard violation): any dispatch with
`subagent_type: browzer:browzer` OR `subagent_type: browzer` = +2 violations.

**Skill bypass**: when `task.skillsFound[]` is non-empty for a given
`browzer:coder` dispatch, the execution log MUST show `Skill()` invocations
for each listed skill. Zero `Skill()` calls with non-empty `skillsFound[]` =
+1 violation per dispatch.

---

## Phase 5 — Scoring

### Score configs

Post scores to whichever observability backend is wired. Use these exact
config names:

| Name | Type | Allowed values |
|---|---|---|
| `skill-phase-completion` | CATEGORICAL | `completed` \| `partial` \| `violated` \| `skipped` \| `failed` |
| `feature-acceptance-verdict` | CATEGORICAL | `completed` \| `paused-pending-operator` \| `stopped` |
| `dispatch-prompt-quality` | CATEGORICAL | `clean` \| `missing-render` \| `inflated` |
| `skill-contract-violations` | NUMERIC | 0–20 (count) |
| `render-template-adoption` | NUMERIC | 0–100 (%) |
| `workflow-elapsed-min` | NUMERIC | 0–600 (minutes) |
| `clarification-budget-burn` | NUMERIC | 0–5 |
| `agent-typed-dispatch` | CATEGORICAL | `correct` \| `untyped` \| `wrong-agent` \| `routing-loop` |
| `mutation-score` | NUMERIC | 0–100 |
| `update-docs-signals` | NUMERIC | 0–4 |

Every score MUST carry a comment with concrete evidence (file path + field, or
trace observation name) so the score is auditable.

---

## Phase 6 — Output report

Return a markdown report ranked by skill — high-risk phases first. Use this
template:

```markdown
## Assessment — feat-<slug>

### feature-acceptance: <verdict> (<n> ACs / <m> NFRs)
- skill-phase-completion: completed | partial | violated | skipped | failed
- contract-violations: N
- evidence: ACCEPTANCE.md verdict=<>, mode=<>, modeNote=<present|missing>

### code-review: <stat>
- lanes present: senior-engineer, software-architect, qa, regression-tester
- findings: <H> high, <M> medium, <L> low
- sensitivePathGate: present | missing
- regressionEvidence: populated | empty
- contract-violations: N

### receiving-code-review: <stat>
- fixed: N, tech-debt: M, total: T
- techDebtBreakdown: scopeDeferred=N, ladderExhausted=M
- contract-violations: N

### tests: mutation-score=<value>
- mutation categories covered: boolean, conditional, arithmetic, boundary,
  off-by-one, return-value (mark each ✓/✗)
- survived mutants with rationale: N/M
- contract-violations: N

### prd: <stat>
- frontmatter keys: complete | missing (<list>)
- testable ACs: N/M
- skillsFound[] verified: N/M
- contract-violations: N

### tasks: <N> completed, <M> failed
- execution logs: present | missing on <list>
- files-modified/created bullets: valid shape ✓/✗
- contract-violations: N

### doc-patches: <stat>
- enoentFixed: present | null
- new docs created (should be 0): N
- contract-violations: N

### readme: present | missing | wrong-location
- canonical H2s present: N (see ${CLAUDE_PLUGIN_ROOT}/references/canonical-readme-h2.md)
- non-canonical H2s: <list>
- contract-violations: N

### Agent dispatch audit
- PRD agent: browzer:pm ✓/✗
- Tasks agent: browzer:po ✓/✗
- execute-task agent: browzer:coder ✓/✗
- code-review agents: browzer:code-reviewer ×4 ✓/✗
- receiving-code-review agent: browzer:fixer ✓/✗
- write-tests agent: browzer:tester ✓/✗
- update-docs agents: browzer:explorer + browzer:doc-writer ✓/✗
- routing-loop detected: yes/no
- agent-typed-dispatch verdict: correct | untyped | wrong-agent | routing-loop
- skill-bypass violations: N dispatches where skillsFound[] was non-empty
  but no Skill() calls were recorded

### Observability coverage
- trace backend: wired | not-wired
- traces fetched: N (or "filesystem-only scoring")
- elapsed (from git log timestamps): <N> minutes

## Token budget summary
- session total: <N> tokens (target ≤80,000; +/-<delta>)
- top 3 heaviest phases: <phase1> <X>, <phase2> <Y>, <phase3> <Z>

## Top 3 improvements for the next plugin cycle
1. <skill file path>::<clause> — concrete action
2. <skill file path>::<clause> — concrete action
3. <skill file path>::<clause> — concrete action
```

Each "Top 3 improvement" MUST name the specific skill file
(`packages/skills/skills/<skill>/SKILL.md` or a `references/*.md`) and the
concrete clause to harden, weaken, or remove. Vague advice is useless —
point at the line.

---

## Phase 7 — Persist

After printing the report, write it to disk:

```
docs/browzer/<feat-slug>/JUDGMENT.md
```

Prefix with a provenance comment:

```markdown
<!-- Generated by judge-skill-runs at <RFC3339-timestamp>.
     Do not edit by hand — re-run /judge-skill-runs to refresh. -->
```

Use the `Write` tool — do not use shell redirection. Re-running overwrites
cleanly; never append.

---

## Hard constraints

- Never invent trace IDs, session IDs, or artifact content. Filesystem and
  traces are the only authoritative sources. If neither yields data for the
  slug, say so and stop.
- Always filter traces by `feature:<slug>` before judging — turns from
  unrelated sessions land in the same backend.
- Score names MUST match the configs exactly. Categorical values MUST match
  the config's `categories[].label` exactly (case-sensitive).
- Always include a comment with concrete evidence on every score post.
- If a score config is missing, recreate it before posting; do not silently
  drop the score.
- The report covers only what actually ran. Skills not invoked during the run
  are omitted.
