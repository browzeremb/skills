<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `UPDATE_DOCS`

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
  "name": "UPDATE_DOCS",
  "startedAt": "<RFC3339>",
  "status": "PENDING",
  "stepId": "",
  "updateDocs": {
    "twoPassRun": {
      "conceptLevel": false,
      "directRef": false,
      "mentionsFallbackUsed": false,
      "mentionsPass": false
    }
  }
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `anchorDocsAlwaysIncluded` |  | array |  |  |
| `anchorDocsAlwaysIncluded[].disposition` | ✓ | string | `auto-included-fresh` \| `deduped-vs-concept` \| `deduped-vs-direct-ref` \| `deduped-vs-mentions` \| `skipped-historical-archived` \| `skipped-no-user-visible-change` |  |
| `anchorDocsAlwaysIncluded[].doc` | ✓ | string |  |  |
| `anchorDocsAlwaysIncluded[].source` | ✓ | string | `repo-root-changelog` \| `repo-root-debts` \| `user-visible-change` \| `walk-up` |  |
| `docsMentioning` |  | array |  |  |
| `docsMentioning[].mentionedBy` | ✓ | array |  |  |
| `docsMentioning[].mentionedBy[].confidence` | ✓ | float |  |  |
| `docsMentioning[].mentionedBy[].doc` | ✓ | string |  |  |
| `docsMentioning[].sourceFile` | ✓ | string |  |  |
| `patches` |  | array |  |  |
| `patches[].doc` | ✓ | string |  |  |
| `patches[].linesChanged` |  | int |  |  |
| `patches[].notes` |  | string |  |  |
| `patches[].reason` | ✓ | string |  |  |
| `patches[].verdict` | ✓ | string | `applied` \| `failed` \| `skipped` |  |
| `twoPassRun` | ✓ | object |  |  |
| `twoPassRun.conceptLevel` | ✓ | bool |  |  |
| `twoPassRun.directRef` | ✓ | bool |  |  |
| `twoPassRun.mentionsFallbackUsed` | ✓ | bool |  |  |
| `twoPassRun.mentionsPass` | ✓ | bool |  |  |
| `twoPassRun.mentionsResultEmpty` |  | *null | "all-new-files" | "no-edges" | "uncommitted-edits... |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
