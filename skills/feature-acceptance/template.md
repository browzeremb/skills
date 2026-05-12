<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `FEATURE_ACCEPTANCE`

Auto-generated from `packages/cli/schemas/workflow-v1.cue` via
`scripts/packages/cli/sync-skill-templates.mjs`. Do not edit by hand —
the lefthook pre-push gate regenerates this file when the CLI schema
or related Go sources change.

## Canonical scaffold

> **Note:** the scaffold below is the **BODY** for `save-step` (positional phase arg). Do NOT wrap it in `{ "name": "...", "applicability": "...", ... }`. Write only the inner payload object — `save-step` takes the phase name as a positional argument and locates the step in `workflow.json`.

CUE-validated example shape — emit a payload matching this contract
to `staging/<PHASE>.json` (or `.md` for PRD).

```json
{
  "acceptanceCriteria": []
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `acRelaxations` |  | array |  |  |
| `acRelaxations[].acId` | ✓ | string | `^AC-[0-9]+$` |  |
| `acRelaxations[].at` | ✓ | string |  |  |
| `acRelaxations[].originalTarget` | ✓ | string |  |  |
| `acRelaxations[].rationale` | ✓ | string |  |  |
| `acRelaxations[].relaxedTarget` | ✓ | string |  |  |
| `acRelaxations[].source` | ✓ | string |  |  |
| `acceptanceCriteria` | ✓ | array |  |  |
| `acceptanceCriteria[].evidence` | ✓ | string |  |  |
| `acceptanceCriteria[].id` | ✓ | string | `^AC-[0-9]+$` |  |
| `acceptanceCriteria[].method` | ✓ | string | `inspect` \| `metric` \| `test` |  |
| `acceptanceCriteria[].rationale` |  | string |  |  |
| `acceptanceCriteria[].status` | ✓ | string | `failed` \| `unverified` \| `verified` |  |
| `executionRequiredProbe` |  | bool |  |  |
| `liveVerificationAttempt` |  | bool |  |  |
| `mode` |  | string | `autonomous` \| `autonomous-with-stack-boot` \| `hybrid` \| `manual` |  |
| `modeNote` |  | string |  |  |
| `nfrVerifications` |  | array |  |  |
| `nfrVerifications[].coversAcceptanceSignal` | ✓ | string | `block` \| `pass` \| `warn` |  |
| `nfrVerifications[].evidence` | ✓ | string |  |  |
| `nfrVerifications[].id` | ✓ | string | `^NFR-[0-9]+$` |  |
| `nfrVerifications[].measured` | ✓ | string |  |  |
| `nfrVerifications[].status` | ✓ | string | `failed` \| `partial` \| `verified` |  |
| `nfrVerifications[].target` | ✓ | string |  |  |
| `operatorActionsRequested` |  | array |  |  |
| `operatorActionsRequested[].ac` |  | *null | =~"^AC-[0-9]+$" | `^AC-[0-9]+$` |  |
| `operatorActionsRequested[].at` | ✓ | string |  |  |
| `operatorActionsRequested[].description` | ✓ | string |  |  |
| `operatorActionsRequested[].kind` | ✓ | string | `blocks-commit` \| `deferred-follow-up` \| `deferred-post-merge` \| `deferred-pre-commit` \| `inherited-scope-adjustment` \| `manual-verification` |  |
| `operatorActionsRequested[].resolution` |  | *null | string |  |  |
| `operatorActionsRequested[].resolved` |  | bool |  |  |
| `preRegistered` |  | bool |  |  |
| `successMetrics` |  | array |  |  |
| `successMetrics[].id` | ✓ | string | `^M-[0-9]+$` |  |
| `successMetrics[].measured` | ✓ | number | string |  |  |
| `successMetrics[].rationale` |  | string |  |  |
| `successMetrics[].resolved` |  | bool |  |  |
| `successMetrics[].status` | ✓ | string | `met` \| `unmet` |  |
| `successMetrics[].target` | ✓ | number | string |  |  |
| `verdict` |  | string | `completed` \| `paused-pending-operator` \| `stopped` |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
