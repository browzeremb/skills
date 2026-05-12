<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `WRITE_TESTS`

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
  "name": "WRITE_TESTS",
  "startedAt": "<RFC3339>",
  "status": "PENDING",
  "stepId": "",
  "writeTests": {
    "skipped": false
  }
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `categories` |  | *null | [...string] |  |  |
| `filesAuthored` |  | array |  |  |
| `filesAuthored[]` | ✓ | string |  |  |
| `greenTests` |  | object |  |  |
| `greenTests.added` | ✓ | int |  |  |
| `greenTests.augmented` |  | int |  |  |
| `greenTests.duration` |  | string |  |  |
| `killed` |  | *null | int |  |  |
| `mutationScore` |  | *null | int |  |  |
| `mutationTesting` |  | object |  |  |
| `mutationTesting.coverageGap` |  | *null | {
	reason: string
	uncoveredFiles: [...string]
	r... |  |  |
| `mutationTesting.coverageGap.reason` | ✓ | string |  |  |
| `mutationTesting.coverageGap.remediation` | ✓ | string |  |  |
| `mutationTesting.coverageGap.uncoveredFiles` | ✓ | array |  |  |
| `mutationTesting.coverageGap.uncoveredFiles[]` | ✓ | string |  |  |
| `mutationTesting.ran` | ✓ | bool |  |  |
| `mutationTesting.score` |  | int |  |  |
| `mutationTesting.survivors` |  | array |  |  |
| `mutationTesting.survivors[].addedTestFile` |  | string |  |  |
| `mutationTesting.survivors[].file` | ✓ | string |  |  |
| `mutationTesting.survivors[].killedByNewTest` | ✓ | bool |  |  |
| `mutationTesting.survivors[].line` | ✓ | int |  |  |
| `mutationTesting.survivors[].mutator` | ✓ | string |  |  |
| `mutationTesting.target` |  | int |  |  |
| `mutationTesting.tool` |  | *null | "stryker" | "mutmut" | "go-mutesting" |  |  |
| `notes` |  | string |  |  |
| `runner` |  | *null | "vitest" | "jest" | "pytest" | "go test" | "cargo... |  |  |
| `skipReason` |  | *null | "no-test-setup" | string |  |  |
| `skipped` | ✓ | bool |  |  |
| `survived` |  | *null | int |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
