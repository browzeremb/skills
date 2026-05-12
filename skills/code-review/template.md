<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `CODE_REVIEW`

Auto-generated from `packages/cli/schemas/workflow-v1.cue` via
`scripts/packages/cli/sync-skill-templates.mjs`. Do not edit by hand —
the lefthook pre-push gate regenerates this file when the CLI schema
or related Go sources change.

## Canonical scaffold

CUE-validated example shape — emit a payload matching this contract
to `staging/<PHASE>.json` (or `.md` for PRD).

```json
{
  "applicability": {
    "applicable": false
  },
  "codeReview": {
    "dispatchMode": "agent-teams",
    "mandatoryMembers": [],
    "reviewTier": "basic"
  },
  "name": "CODE_REVIEW",
  "startedAt": "<RFC3339>",
  "status": "PENDING",
  "stepId": ""
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `agentTeamsEnabled` |  | bool |  |  |
| `baseline` |  | object |  |  |
| `baseline.command` |  | string |  |  |
| `baseline.duration` |  | string |  |  |
| `baseline.failures` |  | array |  |  |
| `baseline.failures[].error` | ✓ | string |  |  |
| `baseline.failures[].testFile` | ✓ | string |  |  |
| `baseline.failures[].testName` | ✓ | string |  |  |
| `baseline.freshGates` |  | array |  |  |
| `baseline.freshGates[]` | ✓ | string |  |  |
| `baseline.reusedGates` |  | array |  |  |
| `baseline.reusedGates[]` | ✓ | string |  |  |
| `baseline.source` | ✓ | string | `fresh-run` \| `hybrid` \| `workflow-json` |  |
| `consolidator` |  | object |  |  |
| `consolidator.mode` | ✓ | string | `dispatched-agent` \| `in-line` |  |
| `consolidator.reason` |  | string |  |  |
| `customMembers` |  | array |  |  |
| `customMembers[]` | ✓ | string |  |  |
| `cyclomaticAudit` |  | object |  |  |
| `cyclomaticAudit.conductedBy` | ✓ | string |  |  |
| `cyclomaticAudit.files` |  | array |  |  |
| `cyclomaticAudit.files[].file` | ✓ | string |  |  |
| `cyclomaticAudit.files[].maxComplexity` | ✓ | int |  |  |
| `cyclomaticAudit.files[].threshold` | ✓ | int |  |  |
| `cyclomaticAudit.files[].verdict` | ✓ | string | `fail` \| `ok` \| `warn` |  |
| `dispatchMode` | ✓ | string | `agent-teams` \| `parallel-with-consolidator` |  |
| `duplicationFindings` |  | array |  |  |
| `duplicationFindings[].files` | ✓ | array |  |  |
| `duplicationFindings[].files[]` | ✓ | string |  |  |
| `duplicationFindings[].pattern` | ✓ | string |  |  |
| `duplicationFindings[].suggestedExtraction` | ✓ | string |  |  |
| `exitCode` |  | *null | int |  |  |
| `findings` |  | array |  |  |
| `findings[].assignedSkill` |  | *null | string |  |  |
| `findings[].category` | ✓ | string |  |  |
| `findings[].crossLaneOverlap` |  | bool |  |  |
| `findings[].description` | ✓ | string |  |  |
| `findings[].domain` | ✓ | string |  |  |
| `findings[].file` | ✓ | string |  |  |
| `findings[].id` | ✓ | string | `^F-[0-9]+$` |  |
| `findings[].line` |  | int |  |  |
| `findings[].mergedFrom` |  | array | `^(SR|ARCH|QA|REG|F)-[0-9]+$` |  |
| `findings[].mergedFrom[]` | ✓ | string | `^(SR|ARCH|QA|REG|F)-[0-9]+$` |  |
| `findings[].severity` | ✓ | string | `high` \| `low` \| `medium` |  |
| `findings[].status` | ✓ | string | `fixed` \| `fixing` \| `open` \| `wontfix` |  |
| `findings[].suggestedFix` |  | string |  |  |
| `gate` |  | *null | "fail-on-high" | "fail-on-medium-or-high" | "advi... |  |  |
| `mandatoryMembers` | ✓ | array |  |  |
| `mandatoryMembers[]` | ✓ | string |  |  |
| `preRegistered` |  | bool |  |  |
| `recommendedMembers` |  | array |  |  |
| `recommendedMembers[]` | ✓ | string |  |  |
| `regressionRun` |  | *null | {
	tool:              "vitest" | "pytest" | "go t... |  |  |
| `regressionRun.command` | ✓ | string |  |  |
| `regressionRun.commandSource` | ✓ | string | `husky` \| `lefthook` \| `operator` \| `package-scripts` \| `stack-default` |  |
| `regressionRun.duration` |  | string |  |  |
| `regressionRun.executionDepth` | ✓ | string | `full-rehearse` \| `scoped-execute` \| `static-only` |  |
| `regressionRun.exitCode` | ✓ | int |  |  |
| `regressionRun.failed` | ✓ | int |  |  |
| `regressionRun.failures` |  | array |  |  |
| `regressionRun.failures[].error` | ✓ | string |  |  |
| `regressionRun.failures[].testFile` | ✓ | string |  |  |
| `regressionRun.failures[].testName` | ✓ | string |  |  |
| `regressionRun.filesInRadius` |  | int |  |  |
| `regressionRun.passed` | ✓ | int |  |  |
| `regressionRun.scope` |  | string |  |  |
| `regressionRun.skipReason` |  | *null | string |  |  |
| `regressionRun.skipped` | ✓ | bool |  |  |
| `regressionRun.skippedTests` |  | int |  |  |
| `regressionRun.summary` |  | string |  |  |
| `regressionRun.testFilesExecuted` |  | int |  |  |
| `regressionRun.tool` | ✓ | string | `cargo test` \| `go test` \| `jest` \| `lefthook` \| `pytest` \| `skipped` \| `vitest` |  |
| `reviewTier` | ✓ | string | `basic` \| `custom` \| `recommended` |  |
| `sensitivePathGate` |  | *null | {
	matched: bool
	matchedFiles: [...string]
} |  |  |
| `sensitivePathGate.matched` | ✓ | bool |  |  |
| `sensitivePathGate.matchedFiles` | ✓ | array |  |  |
| `sensitivePathGate.matchedFiles[]` | ✓ | string |  |  |
| `severityCounts` |  | object |  |  |
| `severityCounts.high` |  | int |  |  |
| `severityCounts.low` |  | int |  |  |
| `severityCounts.medium` |  | int |  |  |
| `tokenCostEstimate` |  | int |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
