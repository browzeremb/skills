<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `PRD`

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
  "name": "PRD",
  "prd": {
    "acceptanceCriteria": [],
    "functionalRequirements": [],
    "title": ""
  },
  "startedAt": "<RFC3339>",
  "status": "PENDING",
  "stepId": ""
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `acceptanceCriteria` | ✓ | array |  |  |
| `acceptanceCriteria[].bindsTo` |  | array | `^FR-[0-9]+$` |  |
| `acceptanceCriteria[].bindsTo[]` | ✓ | string | `^FR-[0-9]+$` |  |
| `acceptanceCriteria[].description` |  | string |  |  |
| `acceptanceCriteria[].id` | ✓ | string | `^AC-[0-9]+$` |  |
| `acceptanceCriteria[].text` |  | string |  |  |
| `assumptions` |  | array |  |  |
| `assumptions[]` | ✓ | string |  |  |
| `deliverables` |  | array |  |  |
| `deliverables[]` | ✓ | string |  |  |
| `dependencies` |  | object |  |  |
| `dependencies.external` |  | array |  |  |
| `dependencies.external[]` | ✓ | string |  |  |
| `dependencies.internal` |  | array |  |  |
| `dependencies.internal[]` | ✓ | string |  |  |
| `functionalRequirements` | ✓ | array |  |  |
| `functionalRequirements[].description` |  | string |  |  |
| `functionalRequirements[].id` | ✓ | string | `^FR-[0-9]+$` |  |
| `functionalRequirements[].priority` |  | string | `could` \| `must` \| `should` |  |
| `functionalRequirements[].text` |  | string |  |  |
| `inScope` |  | array |  |  |
| `inScope[]` | ✓ | string |  |  |
| `nonFunctionalRequirements` |  | array |  |  |
| `nonFunctionalRequirements[].category` |  | string |  |  |
| `nonFunctionalRequirements[].description` |  | string |  |  |
| `nonFunctionalRequirements[].id` | ✓ | string | `^NFR-[0-9]+$` |  |
| `nonFunctionalRequirements[].target` | ✓ | string |  |  |
| `nonFunctionalRequirements[].text` |  | string |  |  |
| `objectives` |  | array |  |  |
| `objectives[]` | ✓ | string |  |  |
| `outOfScope` |  | array |  |  |
| `outOfScope[]` | ✓ | string |  |  |
| `overview` |  | string |  |  |
| `personas` |  | array |  |  |
| `personas[].description` | ✓ | string |  |  |
| `personas[].id` | ✓ | string | `^P-[0-9]+$` |  |
| `risks` |  | array |  |  |
| `risks[].description` |  | string |  |  |
| `risks[].id` | ✓ | string | `^R-[0-9]+$` |  |
| `risks[].mitigation` | ✓ | string |  |  |
| `risks[].text` |  | string |  |  |
| `successMetrics` |  | array |  |  |
| `successMetrics[].id` | ✓ | string | `^M-[0-9]+$` |  |
| `successMetrics[].method` | ✓ | string |  |  |
| `successMetrics[].metric` | ✓ | string |  |  |
| `successMetrics[].target` | ✓ | string |  |  |
| `taskGranularity` |  | string |  |  |
| `title` | ✓ | string |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
