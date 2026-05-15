# Receiving-code-review templates

Two canonical artefacts:

1. `FIX_F-NNN.completed.md` / `FIX_F-NNN.tech_debt.md` — per-finding, atomic-written by the fixer subagent then renamed
2. `RECEIVING_CODE_REVIEW.md` — LLM/script aggregate written after all findings resolve

---

## A. `FIX_F-NNN.completed.md` and `FIX_F-NNN.tech_debt.md`

Status via filename suffix (same pattern as execute-task's
`TASK_NN.{completed,failed}.md`). Single atomic rename on resolution.

### Frontmatter (REQUIRED)

```yaml
---
findingId: F-NNN                       # mirrored from CODE_REVIEW.md.findings[].id
pinsFinding: F-NNN                     # closure: structured pin back to the finding
featureId: feat-YYYYMMDD-<slug>
severity: high | medium | low          # mirrored from CODE_REVIEW.md.findings[]
lane: <lane that raised it>            # mirrored
pinsFiles: ["<repo-relative path>", ...]   # files this fix touched (≥1 entry)
pinsTask: [TASK_NN, ...]               # OPTIONAL; mirrors finding.pinsTask[]
pinsAcs: [AC-NN, ...]                  # OPTIONAL; mirrors finding.pinsAcs[]
assignedSkill: <skill-name | null>     # mirrored from CODE_REVIEW.md.findings[]
ladderStepsUsed: <int>                 # 1..6 for .completed; always 6 for .tech_debt (scope-deferred uses 1)
modelAtSuccess: sonnet | opus | null   # null for .tech_debt
techDebtSubtype: scope_deferred | ladder_exhausted | null    # REQUIRED for .tech_debt
startedAt: <RFC3339>
completedAt: <RFC3339>
---
```

### Body (REQUIRED)

```markdown
# Fix log — <findingId>

## Original finding

<paste-include the finding from CODE_REVIEW.md verbatim — id, severity, ruleId, title, description, fix>

## Fix log

### Files modified
- (regex-strict per ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md Block 1)

### Files created
- (regex-strict — Block 2)

### Symbols changed
- (regex-strict — Block 3)

### Ladder transitions
- step-1 sonnet high <outcome: continued|fixed|escalated>
- step-2 sonnet high <outcome>
- ...
- step-N <model> <effort> <outcome>

### Baseline gates
<pre vs post gate counts when applicable; "(unavailable)" if not run>

### Scope adjustments
- <free-form, one bullet per deviation; (none) when none>

### Failure ladder (only in .tech_debt.md)
- step-1: <verbatim failure reason>
- step-2: <verbatim failure reason>
- ...
- step-6: <verbatim failure reason>

### Recommended follow-up (only in .tech_debt.md)
<one paragraph: what the operator should do next — typically a follow-up
feature with reduced scope OR an explicit acceptance-of-debt note>
```

### Ladder transition regex

```
^- step-(\d+) (sonnet|opus) (low|medium|high|xhigh|max) (continued|fixed|escalated)$
```

The outcome enum:

- `continued` — step failed but didn't exhaust the ladder; next step ran
- `fixed` — step succeeded; ladder terminated; outcome `completed`
- `escalated` — model bumped (step 3 → 4)

---

## B. `RECEIVING_CODE_REVIEW.md` — aggregate

Written by the dispatcher after all per-finding files exist. Frontmatter is
populated by `scripts/aggregate-fixes.mjs`; body is LLM-authored.

### Frontmatter (REQUIRED)

```yaml
---
featureId: feat-YYYYMMDD-<slug>
prdSha: <SHA mirrored from CODE_REVIEW.md>
generatedAt: <RFC3339>
summary:
  total: <int>
  fixed: <int>
  techDebt: <int>
  totalIterations: <int>                # sum of ladderStepsUsed across all findings
techDebtBreakdown:
  scopeDeferred: <int>
  ladderExhausted: <int>
fixOutcomes:
  - findingId: F-NNN
    pinsFinding: F-NNN
    status: fixed | tech_debt
    severity: high | medium | low
    lane: <lane>
    ladderStepsUsed: <int>
    modelAtSuccess: sonnet | opus | null
    techDebtSubtype: scope_deferred | ladder_exhausted | null
    pinsFiles: ["<path>", ...]
    pinsAcs: [AC-NN, ...]                # OPTIONAL
    fixFile: FIX_F-NNN.completed.md      # or .tech_debt.md
    elapsedSec: <int>
---
```

### Body (REQUIRED)

```markdown
# Receiving code review — aggregate

## Summary

<fixed>/<total> findings fixed, <techDebt> tech-debt entries. Iterations
total: <totalIterations>. Tech-debt breakdown: scope-deferred
<scopeDeferred>, ladder-exhausted <ladderExhausted>.

## Fixed findings

| Finding | Severity | Ladder steps | Model | Files |
|---|---|---|---|---|
| F-001 | high | 2 | sonnet | src/api/handler.<ext> |
| ...

## Tech-debt findings

<sub-section ONLY when techDebt > 0; per entry one paragraph citing
fixFile, severity, subtype, and recommended follow-up summary>

## Closure-principle check

<sanity statement: every fixOutcome.pinsFinding maps to an entry in
CODE_REVIEW.md.findings[]. Discrepancies (if any) listed here.>

## Next phase

<if techDebt entries with severity == high exist → "HALT — operator must
triage <count> high-severity tech-debt entries before /feature-acceptance
will run">
<else → "Run /write-tests $featureId" >
```

---

## Cross-reference invariants

1. Every `fixOutcomes[].pinsFinding` MUST match an existing `F-NNN` in `CODE_REVIEW.md.findings[]`. The aggregator drops orphan outcomes with a warning.
2. Every `FIX_F-NNN.{completed,tech_debt}.md` file MUST have a corresponding entry in `RECEIVING_CODE_REVIEW.md.fixOutcomes[]`.
3. `summary.fixed + summary.techDebt == summary.total`.
4. `techDebtBreakdown.scopeDeferred + techDebtBreakdown.ladderExhausted == summary.techDebt`.
5. `prdSha` mirrors `CODE_REVIEW.md.prdSha`. Drift HALTS the phase.
6. `.tech_debt.md` MUST carry `techDebtSubtype`. `.completed.md` MUST carry `modelAtSuccess` (sonnet OR opus).
7. The closure-principle check section enumerates any unexpected mismatch between `FIX_*.{completed,tech_debt}.md` files on disk and the `fixOutcomes[]` array.
