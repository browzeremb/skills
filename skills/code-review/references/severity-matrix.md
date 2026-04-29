# severity-matrix — category ownership + severity rules

## Category ownership (mandatory in every dispatch)

Triple-flagging the same finding across three reviewers burns ~20k tokens per run for no review value.
The fix is exclusive ownership so other reviewers stay in their lane.

| Category                                            | Owner role          | Other roles MUST skip                             |
| --------------------------------------------------- | ------------------- | ------------------------------------------------- |
| cyclomatic / DRY / clean code / style               | senior-engineer     | software-architect, qa, regression-tester, others |
| race conditions / clean architecture                | software-architect  | senior-engineer, qa, regression-tester, others    |
| caching / performance                               | software-architect  | senior-engineer, qa, regression-tester, others    |
| edge cases / butterfly-effect / regressions (review)| qa                  | senior-engineer, software-architect, others       |
| failing tests in blast radius (run)                 | regression-tester   | (cannot be assigned to any other role)            |
| auth / tenancy / data leak                          | security            | senior-engineer, software-architect, qa, others   |
| a11y / bundle size                                  | frontend-specialist | senior-engineer, software-architect, others       |

The consolidator deduplicates cross-lane findings. When the same finding ID appears in N>1 reviewers,
`crossLaneOverlap: true` is set on that finding, and the off-lane reporters' output is **advisory
only** — it does NOT count toward `consensusScore`.

---

## Severity rules per lane

### senior-engineer
- Invariant violation → **high**
- Cyclomatic > 2× threshold → **high**
- Cyclomatic between 1× and 2× threshold → **medium**
- Style / naming → **low**

### software-architect
- Race condition with money/data integrity stakes → **high**
- Missing cache invalidation producing stale tenant-visible data → **high**
- Layer violations affecting testability → **medium**
- Performance regressions ≥2× without justification → **medium**

### qa
- Silent behaviour drift on a public surface → **high**
- Butterfly-effect with active blast-radius (dependent file in same diff or active feature work) → **high**
- Missing edge-case on a low-risk path → **low**

### regression-tester
- Every failing test → **high**, `category: regression`
- No test infrastructure → not a finding (write-tests bootstraps later)

---

## crossLaneOverlap semantics

When the same finding appears in multiple lanes:

1. The **owning lane's** finding is canonical.
2. Off-lane duplicates get `crossLaneOverlap: true`.
3. Off-lane reporters' findings are **advisory** — excluded from `consensusScore`.
4. Record the overlap in `codeReview.contractViolations[]` only if the off-lane reporter also ignored
   the lane-discipline instruction (i.e. the agent was told to stay in its lane and filed cross-lane
   anyway).

The consolidator never merges findings across lanes into a single finding — it deduplicates by ID,
keeps the canonical, and marks the overlapping ones advisory.

---

## Finding JSON shape

```jsonc
{
  "id": "F-<N>",
  "domain": "<domain>",
  "severity": "high" | "medium" | "low",
  "category": "<category-from-ownership-table>",
  "file": "<path>",
  "line": <int | null>,
  "description": "<specific, actionable>",
  "suggestedFix": "<concrete next step>",
  "assignedSkill": "<skill-name | null>",
  "status": "open",
  "crossLaneOverlap": false
}
```

Cap per lane: **10 findings maximum**. When a single lane would produce more, that signals the lane
scope is too broad — split the lane or escalate to `large` tier so the consolidator earns its keep.
