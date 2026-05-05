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

## Enum quick-reference (literal CUE values)

Use the literals BELOW verbatim — anything else is rejected by `cue vet`.

| Field | Literal values |
|---|---|
| `tier` | `"basic"` \| `"recommended"` \| `"custom"` |
| `dispatchMode` | `"agent-teams"` \| `"parallel-with-consolidator"` |
| `consolidator.mode` | `"in-line"` \| `"dispatched-agent"` |
| `baseline.source` | `"workflow-json"` \| `"fresh-run"` \| `"hybrid"` |
| `cyclomaticAudit.files[].verdict` | `"warn"` \| `"ok"` \| `"fail"` |
| `regressionRun.tool` | `"vitest"` \| `"pytest"` \| `"go test"` \| `"cargo test"` \| `"jest"` \| `"skipped"` \| `"lefthook"` |
| `regressionRun.commandSource` | `"lefthook"` \| `"husky"` \| `"package-scripts"` \| `"stack-default"` \| `"operator"` |
| `regressionRun.executionDepth` | `"static-only"` \| `"scoped-execute"` \| `"full-rehearse"` |
| `findings[].id` | regex `^F-[0-9]+$` (one F-N per dispatch — for batches use `browzer workflow set-finding-statuses --batch '<json>'`) |
| `findings[].severity` | `"high"` \| `"medium"` \| `"low"` |
| `findings[].status` | `"open"` \| `"fixing"` \| `"fixed"` \| `"wontfix"` |
| `warnings[].kind` | open string — field is named `kind`, NOT `level` |
