<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `BRAINSTORMING`

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
  "brainstorming": {
    "dimensions": {
      "inScope": [],
      "jobToBeDone": "",
      "outOfScope": [],
      "primaryUser": "",
      "successSignal": ""
    },
    "questionsAsked": 0,
    "researchRoundRun": false
  },
  "name": "BRAINSTORMING",
  "startedAt": "<RFC3339>",
  "status": "PENDING",
  "stepId": ""
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `assumptions` |  | array |  |  |
| `assumptions[]` | ✓ | string |  |  |
| `decision` |  | *null | {
	chosen:    string
	rationale: string
	alternat... |  |  |
| `decision.alternativesConsidered` |  | array |  |  |
| `decision.alternativesConsidered[].name` | ✓ | string |  |  |
| `decision.alternativesConsidered[].reason-rejected` | ✓ | string |  |  |
| `decision.chosen` | ✓ | string |  |  |
| `decision.rationale` | ✓ | string |  |  |
| `dimensions` | ✓ | object |  |  |
| `dimensions.acceptanceCriteria` |  | array |  |  |
| `dimensions.acceptanceCriteria[]` | ✓ | string |  |  |
| `dimensions.dependencies` |  | array |  |  |
| `dimensions.dependencies[]` | ✓ | string |  |  |
| `dimensions.failureModes` |  | array |  |  |
| `dimensions.failureModes[]` | ✓ | string |  |  |
| `dimensions.inScope` | ✓ | array |  |  |
| `dimensions.inScope[]` | ✓ | string |  |  |
| `dimensions.jobToBeDone` | ✓ | string |  |  |
| `dimensions.openQuestions` |  | array |  |  |
| `dimensions.openQuestions[]` | ✓ | string |  |  |
| `dimensions.outOfScope` | ✓ | array |  |  |
| `dimensions.outOfScope[]` | ✓ | string |  |  |
| `dimensions.primaryUser` | ✓ | string |  |  |
| `dimensions.repoSurface` |  | array |  |  |
| `dimensions.repoSurface[]` | ✓ | string |  |  |
| `dimensions.successSignal` | ✓ | string |  |  |
| `dimensions.techConstraints` |  | array |  |  |
| `dimensions.techConstraints[]` | ✓ | string |  |  |
| `openRisks` |  | array |  |  |
| `openRisks[]` | ✓ | string |  |  |
| `questionsAsked` | ✓ | int |  |  |
| `researchAgents` |  | int |  |  |
| `researchFindings` |  | array |  |  |
| `researchFindings[].answer` | ✓ | string |  |  |
| `researchFindings[].confidence` | ✓ | string | `high` \| `low` \| `med` |  |
| `researchFindings[].question` | ✓ | string |  |  |
| `researchFindings[].sources` |  | array |  |  |
| `researchFindings[].sources[]` | ✓ | string |  |  |
| `researchRoundRun` | ✓ | bool |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
