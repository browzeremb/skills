# Iteration ladder — 7-step model-escalation

The fixer subagent walks this ladder for every finding. Steps 1-6 are
sequential attempts; step 7 is the terminal tech-debt log. Haiku is
forbidden at every step.

---

## Ladder steps

| Step | Model | Effort | Action | Outcome enum |
|---|---|---|---|---|
| 1 | sonnet | xhigh (high sev) / high (medium/low) | Initial attempt — read finding, deps, source; apply fix | `fixed` / `continued` |
| 2 | sonnet | xhigh / high | Retry with explicit failure context from step 1 | `fixed` / `continued` |
| 3 | sonnet | xhigh / high | Research + sonnet: `browzer search`, `browzer explore`, optional Context7 + WebSearch before re-attempting | `fixed` / `escalated` |
| 4 | opus | max (high sev) / xhigh (medium/low) | Initial opus attempt with full failure history | `fixed` / `continued` |
| 5 | opus | max / xhigh | Opus retry with explicit failure context from step 4 | `fixed` / `continued` |
| 6 | opus | max / xhigh | Research + opus: deeper investigation, prior-art lookup, ADR consultation | `fixed` / `continued` |
| 7 | — | — | Tech-debt log — write `.tech_debt.md`, document failure ladder | terminal |

`escalated` outcome on step 3 marks the model bump from sonnet to opus.
Steps 1-2-3 are sonnet-only; steps 4-5-6 are opus-only. The escalation
between them MUST be recorded as one bullet `step-3 sonnet <effort>
escalated`.

---

## Iteration-step regex contract

In every `FIX_F-NNN.<status>.md` body, the `### Ladder transitions`
section emits one bullet per step ATTEMPTED. Regex:

```
^- step-(\d+) (sonnet|opus) (low|medium|high|xhigh|max) (continued|fixed|escalated)$
```

Examples:

```markdown
### Ladder transitions
- step-1 sonnet xhigh continued
- step-2 sonnet xhigh continued
- step-3 sonnet xhigh escalated
- step-4 opus max fixed
```

Or a step-1 success:

```markdown
### Ladder transitions
- step-1 sonnet xhigh fixed
```

Or scope-deferred (1 step only):

```markdown
### Ladder transitions
- step-1 sonnet xhigh continued
```

(plus `techDebtSubtype: scope_deferred` in frontmatter and an explicit
`rationale` in the body's "Recommended follow-up" section).

---

## Tech-debt taxonomy

When a finding cannot be fixed, classify into one of two sub-types:

| Sub-type | `ladderStepsUsed` | Meaning |
|---|---|---|
| `scope_deferred` | 1 | Intentionally out-of-scope for this feature cycle. One step recorded; `rationale` required in "Recommended follow-up". Valid terminal state — operator review the README's Deferred actions section. |
| `ladder_exhausted` | 6 | All six ladder steps attempted and failed. Every step documented with failure reason in the "Failure ladder" body section. |

Classification rule: if the fixer was instructed at dispatch time to skip
the ladder (deferred by design), emit `techDebtSubtype: scope_deferred`
and one step record. If the full 6-step ladder ran to exhaustion, emit
`techDebtSubtype: ladder_exhausted` and six step records.

No other values are valid. The aggregator validates these counts.

---

## Halt rules

The fixer MUST halt early in these conditions (record outcome, do NOT
proceed to next step):

- **prdSha drift** — `git hash-object docs/browzer/<feat>/staging/PRD.md` no longer matches `CODE_REVIEW.md.prdSha`. Halt with `outcome: blocked`; the receiving-code-review dispatcher surfaces this to the operator.
- **Sensitive file edit attempt outside scope** — the fix would touch a file NOT in `finding.pinsFiles[]` AND NOT integration glue ≤15 lines. Halt with `outcome: scope-violation`.
- **Loop-escape rule (3 consecutive identical failures)** — same assertion message / typecheck error / test ID across 3 sequential steps. Halt with `outcome: blocked` and surface the failure fingerprint.

---

## Severity → effort mapping

The fixer sets `effort` based on `finding.severity`:

| Severity | sonnet steps | opus steps |
|---|---|---|
| `high` | xhigh | max |
| `medium` | high | xhigh |
| `low` | high | xhigh |

This is hard-coded in the dispatcher; the fixer does NOT override.

---

## Why the ladder is load-bearing

The 7-step ladder is the **single quality control surface** between
"finding raised" and "feature shipped". Skipping steps directly to
tech-debt is a contract violation: it inflates the deferred-actions list,
forces feature-acceptance to reject, and surfaces operator-facing
backlog instead of resolved code.

The default is **zero tech-debt**. Reaching `tech_debt.md` requires
recorded justification. The aggregator surfaces tech-debt counts to
`feature-acceptance` which may reject the feature when high-severity
tech-debt entries are present.
