# `codeReview` step — payload shape

Copy-paste-ready template for the `codeReview` payload on the
`CODE_REVIEW` step. Mirrors `#CodeReview` and `#Finding` in
`references/workflow-schema.md`.

```json
{
  "tier": "minimal|recommended|full",
  "tierSelection": {
    "mode": "auto|operator",
    "reason": "<why this tier>"
  },
  "domains": [
    { "domain": "infra-build", "weight": "heavy", "reviewer": "senior-engineer" }
  ],
  "summary": "<one paragraph>",
  "severityCounts": { "high": 0, "medium": 0, "low": 0 },
  "findings": [
    {
      "id": "F-1",
      "severity": "high|medium|low",
      "domain": "infra-build|api|data|frontend|other",
      "file": "packages/foo/src/bar.ts",
      "line": 42,
      "message": "<one-sentence problem statement>",
      "suggestion": "<one-sentence fix>",
      "assignedSkill": "<skill-id>",
      "status": "open|fixed|wontfix"
    }
  ],
  "regressionRuns": [
    { "tool": "vitest", "command": "<exact cmd>", "exitCode": 0, "passCount": 0, "failCount": 0 }
  ],
  "recommendedMembers": []
}
```

## Required vs optional

- **Required**: `tier`, `summary`, `severityCounts`, `findings`.
- **Optional**: `tierSelection`, `recommendedMembers`,
  `regressionRuns`, `domains`.

## Common drift

- `findings[].id` regex is `^F-[0-9]+$`. Lane prefixes like
  `F-SE-1` (senior-engineer) get rejected — number findings
  globally, not per-lane.
- `findings[].severity` enum is `high | medium | low` only. Lower
  tiers (informational, critical) are NOT in the enum and get
  rejected by CUE — fold them into one of the three accepted values
  or omit the finding.
- `findings[].line` is `int & >=1`. Use `1` (not a null literal)
  when the finding is file-level; the validator rejects nulls here.
- `regressionRuns[].tool` enum is `"vitest" | "pytest" | "go test"
  | "cargo test" | "jest" | "skipped" | "lefthook"`. For audit-script
  or node script runs, use `"lefthook"` (best fit) or `"skipped"`.
- `severityCounts` only carries `high`, `medium`, `low` keys —
  extra severity-tier keys (e.g. an informational counter) reject
  the payload.
