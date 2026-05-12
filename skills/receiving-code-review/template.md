<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `RECEIVING_CODE_REVIEW`

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
  "iteration": 0,
  "summary": {
    "fixed": 0,
    "total": 0,
    "unrecovered": 0
  }
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `dispatches` |  | array |  |  |
| `dispatches[].completedAt` | ✓ | string |  |  |
| `dispatches[].failureTrace` |  | *null | string |  |  |
| `dispatches[].filesChanged` |  | array |  |  |
| `dispatches[].filesChanged[]` | ✓ | string |  |  |
| `dispatches[].findingId` | ✓ | string | `^F-[0-9]+$` |  |
| `dispatches[].gatesPostFix` |  | object |  |  |
| `dispatches[].gatesPostFix.lint` |  | string |  |  |
| `dispatches[].gatesPostFix.tests` |  | string |  |  |
| `dispatches[].gatesPostFix.typecheck` |  | string |  |  |
| `dispatches[].iteration` | ✓ | int |  |  |
| `dispatches[].model` | ✓ | string | `opus` \| `sonnet` |  |
| `dispatches[].reason` | ✓ | string | `initial` \| `operator-feedback` \| `post-deploy` \| `research-then-opus` \| `research-then-sonnet` \| `retry` \| `staging-regression` |  |
| `dispatches[].researchBundle` |  | *null | string |  |  |
| `dispatches[].role` | ✓ | string |  |  |
| `dispatches[].skill` | ✓ | string |  |  |
| `dispatches[].startedAt` | ✓ | string |  |  |
| `dispatches[].status` | ✓ | string | `failed` \| `fixed` \| `skipped` |  |
| `iteration` | ✓ | int |  |  |
| `notes` |  | string |  |  |
| `summary` | ✓ | object |  |  |
| `summary.fixed` | ✓ | int |  |  |
| `summary.total` | ✓ | int |  |  |
| `summary.unrecovered` | ✓ | int |  |  |
| `unrecovered` |  | array |  |  |
| `unrecovered[].findingId` | ✓ | string | `^F-[0-9]+$` |  |
| `unrecovered[].lastTrace` | ✓ | string |  |  |
| `unrecovered[].loggedToTechDebt` |  | *null | string |  |  |
| `unrecovered[].modelsTried` | ✓ | array |  |  |
| `unrecovered[].modelsTried[]` | ✓ | string |  |  |
| `unrecovered[].researchPassesRun` | ✓ | int |  |  |
| `unrecovered[].severity` | ✓ | string | `high` \| `low` \| `medium` |  |
| `unrecovered[].totalIterations` | ✓ | int |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
