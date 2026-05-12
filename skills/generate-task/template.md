<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `TASKS_MANIFEST`

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
  "dependencyGraph": {},
  "tasksOrder": [],
  "totalTasks": 0
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `dependencyGraph` | ✓ | object |  |  |
| `granularityWarnings` |  | array |  |  |
| `granularityWarnings[].reason` | ✓ | string |  |  |
| `granularityWarnings[].taskId` | ✓ | string | `^TASK_[0-9]{2}$` |  |
| `granularityWarnings[].verdict` | ✓ | string | `collapse` \| `split` |  |
| `parallelizable` |  | array |  |  |
| `parallelizable[]` | ✓ | array | `^TASK_[0-9]{2}$` |  |
| `suppressedRedundantTasks` |  | array |  |  |
| `suppressedRedundantTasks[].candidateScope` | ✓ | array |  |  |
| `suppressedRedundantTasks[].candidateScope[]` | ✓ | string |  |  |
| `suppressedRedundantTasks[].candidateTitle` | ✓ | string |  |  |
| `suppressedRedundantTasks[].detectedBy` |  | string | `operational-audit-pass` \| `reviewer-pass` |  |
| `suppressedRedundantTasks[].reason` | ✓ | string | `^duplicates-canonical-phase-(write-tests|update-docs|code-review|commit|feature-acceptance|receiving-code-review)$` |  |
| `tasks` |  | array |  |  |
| `tasksOrder` | ✓ | array | `^TASK_[0-9]{2}$` |  |
| `tasksOrder[]` | ✓ | string | `^TASK_[0-9]{2}$` |  |
| `tasks[].dependsOn` |  | array | `^TASK_[0-9]{2}$` |  |
| `tasks[].dependsOn[]` | ✓ | string | `^TASK_[0-9]{2}$` |  |
| `tasks[].scope` |  | array |  |  |
| `tasks[].scope[]` | ✓ | string |  |  |
| `tasks[].skillsFound` |  | array |  |  |
| `tasks[].skillsFound[]` | ✓ | string |  |  |
| `tasks[].suggestedModel` |  | *null | "haiku" | "sonnet" | "opus" |  |  |
| `tasks[].taskId` | ✓ | string | `^TASK_[0-9]{2}$` |  |
| `tasks[].title` | ✓ | string |  |  |
| `tasks[].trivial` |  | bool |  |  |
| `totalTasks` | ✓ | int |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
