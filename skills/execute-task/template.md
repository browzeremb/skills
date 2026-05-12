<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `TASK`

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
  "execution": {
    "gates": {
      "baseline": {},
      "postChange": {}
    }
  },
  "scope": []
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `acceptanceCriteria` |  | array |  |  |
| `acceptanceCriteria[].bindsTo` | ✓ | array | `^AC-[0-9]+$` |  |
| `acceptanceCriteria[].bindsTo[]` | ✓ | string | `^AC-[0-9]+$` |  |
| `acceptanceCriteria[].description` |  | string |  |  |
| `acceptanceCriteria[].id` | ✓ | string | `^T-AC-[0-9]+$` |  |
| `dependsOn` |  | array | `^TASK_[0-9]{2}$` |  |
| `dependsOn[]` | ✓ | string | `^TASK_[0-9]{2}$` |  |
| `execution` | ✓ | object |  |  |
| `execution.agents` |  | array |  |  |
| `execution.agents[].completedAt` |  | string |  |  |
| `execution.agents[].filesCreated` |  | array |  |  |
| `execution.agents[].filesCreated[]` | ✓ | string |  |  |
| `execution.agents[].filesModified` |  | array |  |  |
| `execution.agents[].filesModified[]` | ✓ | string |  |  |
| `execution.agents[].model` |  | *null | "haiku" | "sonnet" | "opus" |  |  |
| `execution.agents[].notes` |  | string |  |  |
| `execution.agents[].role` | ✓ | string |  |  |
| `execution.agents[].skill` | ✓ | string |  |  |
| `execution.agents[].skillsLoaded` |  | array |  |  |
| `execution.agents[].skillsLoaded[]` | ✓ | string |  |  |
| `execution.agents[].startedAt` |  | string |  |  |
| `execution.agents[].status` | ✓ | string | `completed` \| `failed` \| `pending` \| `running` |  |
| `execution.fileEditsSummary` |  | object |  |  |
| `execution.files` |  | object |  |  |
| `execution.files.created` |  | array |  |  |
| `execution.files.created[]` | ✓ | string |  |  |
| `execution.files.deleted` |  | array |  |  |
| `execution.files.deleted[]` | ✓ | string |  |  |
| `execution.files.modified` |  | array |  |  |
| `execution.files.modified[]` | ✓ | string |  |  |
| `execution.filesCreated` |  | array |  |  |
| `execution.filesCreated[]` | ✓ | string |  |  |
| `execution.filesDeleted` |  | array |  |  |
| `execution.filesDeleted[]` | ✓ | string |  |  |
| `execution.filesModified` |  | array |  |  |
| `execution.filesModified[]` | ✓ | string |  |  |
| `execution.gates` | ✓ | object |  |  |
| `execution.gates.baseline` | ✓ | object |  |  |
| `execution.gates.baseline.lint` |  | string | `fail` \| `pass` \| `skip` |  |
| `execution.gates.baseline.tests` |  | string |  |  |
| `execution.gates.baseline.typecheck` |  | string |  |  |
| `execution.gates.postChange` | ✓ | object |  |  |
| `execution.gates.postChange.lint` |  | string | `fail` \| `pass` \| `skip` |  |
| `execution.gates.postChange.tests` |  | string |  |  |
| `execution.gates.postChange.typecheck` |  | string |  |  |
| `execution.gates.regression` |  | array |  |  |
| `execution.gates.regression[].file` | ✓ | string |  |  |
| `execution.gates.regression[].result` | ✓ | string | `fail` \| `pass` \| `skip` |  |
| `execution.gates.regression[].test` | ✓ | string |  |  |
| `execution.invariantsChecked` |  | array |  |  |
| `execution.invariantsChecked[].note` |  | string |  |  |
| `execution.invariantsChecked[].rule` | ✓ | string |  |  |
| `execution.invariantsChecked[].source` | ✓ | string |  |  |
| `execution.invariantsChecked[].status` | ✓ | string | `failed` \| `passed` |  |
| `execution.nextSteps` |  | string |  |  |
| `execution.scopeAdjustments` |  | array |  |  |
| `execution.scopeAdjustments[].adjustment` | ✓ | string |  |  |
| `execution.scopeAdjustments[].kind` | ✓ | string | `deferred-to-followup` \| `no-op-refactor` \| `out-of-scope-fix` \| `scope-expansion` \| `scope-reduction` \| `spec-relaxation` |  |
| `execution.scopeAdjustments[].loggedAsWarning` |  | bool |  |  |
| `execution.scopeAdjustments[].owner` | ✓ | string | `orchestrator` \| `specialist` |  |
| `execution.scopeAdjustments[].reason` | ✓ | string |  |  |
| `execution.scopeAdjustments[].resolution` | ✓ | string | `^(accepted|rejected|deferred)( — .+)?$` |  |
| `execution.testsRan` |  | object |  |  |
| `execution.testsRan.postChange` |  | object |  |  |
| `execution.testsRan.postChange.details` |  | string |  |  |
| `execution.testsRan.postChange.duration` |  | string |  |  |
| `execution.testsRan.postChange.testCount` |  | string |  |  |
| `execution.testsRan.preChange` |  | object |  |  |
| `execution.testsRan.preChange.details` |  | string |  |  |
| `execution.testsRan.preChange.duration` |  | string |  |  |
| `execution.testsRan.preChange.testCount` |  | string |  |  |
| `explorer` |  | object |  |  |
| `explorer.completedAt` |  | string |  |  |
| `explorer.depsGraph` |  | object |  |  |
| `explorer.domains` |  | array |  |  |
| `explorer.domains[]` | ✓ | string |  |  |
| `explorer.filesModified` |  | array |  |  |
| `explorer.filesModified[]` | ✓ | string |  |  |
| `explorer.filesToRead` |  | array |  |  |
| `explorer.filesToRead[]` | ✓ | string |  |  |
| `explorer.model` |  | *null | "haiku" | "sonnet" | "opus" |  |  |
| `explorer.skillsFound` |  | array |  |  |
| `explorer.skillsFound[].domain` | ✓ | string |  |  |
| `explorer.skillsFound[].relevance` |  | string | `high` \| `low` \| `med` |  |
| `explorer.skillsFound[].skill` | ✓ | string |  |  |
| `invariants` |  | array |  |  |
| `invariants[].rule` | ✓ | string |  |  |
| `invariants[].source` |  | string |  |  |
| `reviewer` |  | object |  |  |
| `reviewer.additionalContext` |  | *"" | string | {
	changes: [...{
		kind: "corrected" | "a... |  |  |
| `reviewer.completedAt` |  | string |  |  |
| `reviewer.model` |  | *null | "haiku" | "sonnet" | "opus" |  |  |
| `reviewer.skipTestsReason` |  | *null | string |  |  |
| `reviewer.testSpecs` |  | array |  |  |
| `reviewer.testSpecs[].coverageTarget` |  | string |  |  |
| `reviewer.testSpecs[].description` | ✓ | string |  |  |
| `reviewer.testSpecs[].file` | ✓ | string |  |  |
| `reviewer.testSpecs[].intent` | ✓ | string | `chaos` \| `green` \| `red` |  |
| `reviewer.testSpecs[].scope` | ✓ | string | `chaos` \| `e2e` \| `integration` \| `unit` |  |
| `reviewer.testSpecs[].testId` | ✓ | string | `^T-[0-9]+$` |  |
| `scope` | ✓ | array |  |  |
| `scope[]` | ✓ | string |  |  |
| `suggestedModel` |  | *null | "haiku" | "sonnet" | "opus" |  |  |
| `title` |  | string |  |  |
| `trivial` |  | bool |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
