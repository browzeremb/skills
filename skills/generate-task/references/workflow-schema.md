# workflow.json — Schema v2 (generated)

> **Generated artifact.** Source of truth lives in the upstream CUE
> schema bundled with the `browzer` CLI. Hand-edits to this file are
> overwritten by the codegen step on the next sync — edit the CUE
> source instead.

Schema v2 is the current contract. Workflows tagged `schemaVersion: 1`
are treated as read-only legacy state by every mutator verb.

## §1 — Top-level workflow

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `schemaVersion` | yes | `2` | `` | 2026-05-04T00:00:00Z |  |
| `pluginVersion` | no | `string` | `null` | 2026-05-04T00:00:00Z |  |
| `featureId` | yes | `=~"^feat-[0-9]{8}-[a-z0-9-]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `featureName` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `featDir` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `originalRequest` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `operator` | yes | `#OperatorInfo` | `` | 2026-04-24T00:00:00Z |  |
| `config` | yes | `#WorkflowConfig` | `` | 2026-04-24T00:00:00Z |  |
| `startedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `updatedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `completedAt` | no | `time.Format(time.RFC3339)` | `null` | 2026-05-04T00:00:00Z |  |
| `totalElapsedMin` | no | `float & >=0 \| int & >=0` | `0` | 2026-05-04T00:00:00Z |  |
| `currentStepId` | no | `=~"^STEP_[0-9]{2}_[A-Z0-9_]+$"` | `""` | 2026-04-24T00:00:00Z |  |
| `nextStepId` | no | `=~"^STEP_[0-9]{2}_[A-Z0-9_]+$"` | `""` | 2026-04-24T00:00:00Z |  |
| `totalSteps` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `completedSteps` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `notes` | no | `[...#Note]` | `[]` | 2026-04-24T00:00:00Z |  |
| `globalWarnings` | no | `[...#GlobalWarning]` | `[]` | 2026-04-24T00:00:00Z |  |
| `steps` | yes | `[...#Step]` | `` | 2026-04-24T00:00:00Z |  |

## §2 — Step base (shared across all step types)

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `stepId` | yes | `=~"^STEP_[0-9]{2}_[A-Z0-9_]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `name` | yes | `#StepName` | `` | 2026-04-24T00:00:00Z | `"PRD"` \| `"TASKS_MANIFEST"` \| `"TASK"` \| `"BRAINSTORMING"` \| `"CODE_REVIEW"` \| `"RECEIVING_CODE_REVIEW"` \| `"WRITE_TESTS"` \| `"UPDATE_DOCS"` \| `"FEATURE_ACCEPTANCE"` \| `"COMMIT"` |
| `taskId` | no | `=~"^TASK_[0-9]{2}$"` | `` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `#StepStatus` | `` | 2026-04-24T00:00:00Z | `"PENDING"` \| `"RUNNING"` \| `"AWAITING_REVIEW"` \| `"COMPLETED"` \| `"STOPPED"` \| `"PAUSED_PENDING_OPERATOR"` \| `"SKIPPED"` \| `"FAILED"` |
| `applicability` | yes | `#StepApplicability` | `` | 2026-04-24T00:00:00Z |  |
| `startedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `completedAt` | no | `time.Format(time.RFC3339)` | `null` | 2026-04-24T00:00:00Z |  |
| `elapsedMin` | no | `float & >=0 \| int & >=0` | `0` | 2026-05-04T00:00:00Z |  |
| `retryCount` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `skipReason` | no | `null \| string` | `` | 2026-04-24T00:00:00Z |  |
| `itDependsOn` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `nextStep` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `skillsToInvoke` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `skillsInvoked` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `owner` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |
| `worktrees` | no | `#StepWorktrees` | `` | 2026-04-24T00:00:00Z |  |
| `warnings` | no | `[...#Warning]` | `[]` | 2026-04-24T00:00:00Z |  |
| `reviewHistory` | no | `[...#ReviewExchange]` | `[]` | 2026-04-24T00:00:00Z |  |
| `dispatches` | no | `[...#DispatchRecord]` | `[]` | 2026-05-04T00:00:00Z |  |

## §3 — Step types

### PRD

_(no fields recorded for #PRDStep)_

### TASKS_MANIFEST

_(no fields recorded for #TasksManifestStep)_

### TASK

_(no fields recorded for #TaskStep)_

### BRAINSTORMING

_(no fields recorded for #BrainstormingStep)_

### CODE_REVIEW

_(no fields recorded for #CodeReviewStep)_

### RECEIVING_CODE_REVIEW

_(no fields recorded for #ReceivingCodeReviewStep)_

### WRITE_TESTS

_(no fields recorded for #WriteTestsStep)_

### UPDATE_DOCS

_(no fields recorded for #UpdateDocsStep)_

### FEATURE_ACCEPTANCE

_(no fields recorded for #FeatureAcceptanceStep)_

### COMMIT

_(no fields recorded for #CommitStep)_

## §4 — Payload structs

### #AC

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^AC-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `text` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `description` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `bindsTo` | no | `[...=~"^FR-[0-9]+$"]` | `` | 2026-04-24T00:00:00Z |  |

### #ACRelaxation

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `acId` | yes | `=~"^AC-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `originalTarget` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `relaxedTarget` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `rationale` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `source` | yes | `"operator"` | `` | 2026-04-24T00:00:00Z | `"operator"` |
| `at` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |

### #AdditionalContextObj

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `changes` | yes | `[...#FileChange]` | `` | 2026-05-04T00:00:00Z |  |

### #AnchorDoc

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `doc` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `source` | yes | `"repo-root-changelog" \| "walk-up" \| "repo-root-debts" \| "user-visible-change"` | `` | 2026-04-24T00:00:00Z | `"repo-root-changelog"` \| `"walk-up"` \| `"repo-root-debts"` \| `"user-visible-change"` |
| `disposition` | yes | `"auto-included-fresh" \| "deduped-vs-direct-ref" \| "deduped-vs-mentions" \| "deduped-vs-concept" \| "skipped-no-user-visible-change" \| "skipped-historical-archived"` | `` | 2026-04-24T00:00:00Z | `"auto-included-fresh"` \| `"deduped-vs-direct-ref"` \| `"deduped-vs-mentions"` \| `"deduped-vs-concept"` \| `"skipped-no-user-visible-change"` \| `"skipped-historical-archived"` |

### #BrainstormAlternative

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `name` | yes | `string` | `` | 2026-05-05T00:00:00Z |  |

### #BrainstormDecision

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `chosen` | yes | `string` | `` | 2026-05-05T00:00:00Z |  |
| `rationale` | yes | `string` | `` | 2026-05-05T00:00:00Z |  |
| `alternativesConsidered` | no | `[...#BrainstormAlternative]` | `[]` | 2026-05-05T00:00:00Z |  |

### #BrainstormDimensions

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `primaryUser` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `jobToBeDone` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `successSignal` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `inScope` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `outOfScope` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `repoSurface` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `techConstraints` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `failureModes` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `acceptanceCriteria` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `dependencies` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `openQuestions` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |

### #Brainstorming

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `questionsAsked` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `researchRoundRun` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `researchAgents` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `dimensions` | yes | `#BrainstormDimensions` | `` | 2026-04-24T00:00:00Z |  |
| `researchFindings` | no | `[...#ResearchFinding]` | `[]` | 2026-04-24T00:00:00Z |  |
| `assumptions` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `openRisks` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `decision` | no | `#BrainstormDecision` | `null` | 2026-05-05T00:00:00Z |  |

### #CodeReview

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `agentTeamsEnabled` | no | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `dispatchMode` | yes | `"agent-teams" \| "parallel-with-consolidator"` | `` | 2026-04-24T00:00:00Z | `"agent-teams"` \| `"parallel-with-consolidator"` |
| `reviewTier` | yes | `"basic" \| "recommended" \| "custom"` | `` | 2026-04-24T00:00:00Z | `"basic"` \| `"recommended"` \| `"custom"` |
| `tokenCostEstimate` | no | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `mandatoryMembers` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `recommendedMembers` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `customMembers` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `consolidator` | no | `#CodeReviewConsolidator` | `` | 2026-04-24T00:00:00Z |  |
| `baseline` | no | `#CodeReviewBaseline` | `` | 2026-04-24T00:00:00Z |  |
| `severityCounts` | no | `#SeverityCounts` | `` | 2026-04-24T00:00:00Z |  |
| `cyclomaticAudit` | no | `#CyclomaticAudit` | `` | 2026-04-24T00:00:00Z |  |
| `duplicationFindings` | no | `[...#DuplicationFinding]` | `[]` | 2026-04-24T00:00:00Z |  |
| `regressionRun` | no | `#RegressionRun` | `null` | 2026-04-24T00:00:00Z |  |
| `findings` | no | `[...#Finding]` | `[]` | 2026-04-24T00:00:00Z |  |
| `preRegistered` | no | `bool` | `false` | 2026-05-04T00:00:00Z |  |

### #CodeReviewBaseline

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `source` | yes | `"workflow-json" \| "fresh-run" \| "hybrid"` | `` | 2026-04-24T00:00:00Z | `"workflow-json"` \| `"fresh-run"` \| `"hybrid"` |
| `reusedGates` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `freshGates` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `duration` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `command` | no | `string` | `""` | 2026-05-04T00:00:00Z |  |
| `failures` | no | `[...#RegressionFailure]` | `[]` | 2026-05-04T00:00:00Z |  |

### #CodeReviewConsolidator

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `mode` | yes | `"in-line" \| "dispatched-agent"` | `` | 2026-04-24T00:00:00Z | `"in-line"` \| `"dispatched-agent"` |
| `reason` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #CommitDescriptor

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `sha` | no | `=~"^[a-f0-9]{7,40}$"` | `` | 2026-04-24T00:00:00Z |  |
| `conventionalType` | yes | `"feat" \| "fix" \| "chore" \| "docs" \| "refactor" \| "test" \| "perf" \| "ci" \| "build" \| "style" \| "revert"` | `` | 2026-04-24T00:00:00Z | `"feat"` \| `"fix"` \| `"chore"` \| `"docs"` \| `"refactor"` \| `"test"` \| `"perf"` \| `"ci"` \| `"build"` \| `"style"` \| `"revert"` |
| `scope` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `subject` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `body` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `trailers` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `prePushAuditsRun` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `pushAttempts` | no | `[...#PushAttempt]` | `[]` | 2026-04-24T00:00:00Z |  |
| `prePushAudits` | no | `[...#PrePushAudit]` | `[]` | 2026-04-24T00:00:00Z |  |

### #CyclomaticAudit

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `conductedBy` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `files` | no | `[...#CyclomaticFile]` | `[]` | 2026-04-24T00:00:00Z |  |

### #CyclomaticFile

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `file` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `maxComplexity` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `threshold` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `verdict` | yes | `"warn" \| "ok" \| "fail"` | `` | 2026-04-24T00:00:00Z | `"warn"` \| `"ok"` \| `"fail"` |

### #DispatchRecord

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `agentId` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `dispatchPromptDigest` | yes | `=~"^sha256:[a-f0-9]{64}$"` | `` | 2026-05-04T00:00:00Z |  |
| `promptByteCount` | yes | `int & >=1` | `` | 2026-05-04T00:00:00Z |  |
| `promptPath` | yes | `string` | `` | 2026-05-04T00:00:00Z |  |
| `renderTemplateUsed` | no | `string` | `null` | 2026-05-04T00:00:00Z |  |
| `dispatchedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-05-04T00:00:00Z |  |
| `model` | no | `"haiku" \| "sonnet" \| "opus"` | `null` | 2026-04-24T00:00:00Z | `"haiku"` \| `"sonnet"` \| `"opus"` |
| `status` | no | `"in_progress" \| "completed" \| "failed" \| "skipped"` | `"in_progress"` | 2026-04-24T00:00:00Z | `"in_progress"` \| `"completed"` \| `"failed"` \| `"skipped"` |
| `findingsAddressed` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `filesModified` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `filesCreated` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `filesDeleted` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |

### #DocMention

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `sourceFile` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #DocPatch

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `doc` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `reason` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `linesChanged` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `verdict` | yes | `"applied" \| "skipped" \| "failed"` | `` | 2026-04-24T00:00:00Z | `"applied"` \| `"skipped"` \| `"failed"` |
| `notes` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #DuplicationFinding

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `pattern` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `files` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `suggestedExtraction` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #FAcceptanceCriterion

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^AC-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `"verified" \| "unverified" \| "failed"` | `` | 2026-04-24T00:00:00Z | `"verified"` \| `"unverified"` \| `"failed"` |
| `evidence` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `method` | yes | `"test" \| "inspect" \| "metric"` | `` | 2026-04-24T00:00:00Z | `"test"` \| `"inspect"` \| `"metric"` |
| `rationale` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #FNFR

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^NFR-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `"verified" \| "partial" \| "failed"` | `` | 2026-04-24T00:00:00Z | `"verified"` \| `"partial"` \| `"failed"` |
| `coversAcceptanceSignal` | yes | `"pass" \| "warn" \| "block"` | `` | 2026-04-24T00:00:00Z | `"pass"` \| `"warn"` \| `"block"` |
| `evidence` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `measured` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `target` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #FR

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^FR-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `text` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `description` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `priority` | no | `"must" \| "should" \| "could"` | `` | 2026-04-24T00:00:00Z | `"must"` \| `"should"` \| `"could"` |

### #FSuccessMetric

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^M-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `measured` | yes | `number \| string` | `` | 2026-04-24T00:00:00Z |  |
| `target` | yes | `number \| string` | `` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `"met" \| "unmet"` | `` | 2026-04-24T00:00:00Z | `"met"` \| `"unmet"` |
| `resolved` | no | `bool` | `false` | 2026-05-04T00:00:00Z |  |
| `rationale` | no | `string` | `""` | 2026-05-04T00:00:00Z |  |

### #FeatureAcceptance

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `mode` | yes | `"autonomous" \| "manual" \| "hybrid"` | `` | 2026-04-24T00:00:00Z | `"autonomous"` \| `"manual"` \| `"hybrid"` |
| `modeNote` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `acceptanceCriteria` | yes | `[...#FAcceptanceCriterion]` | `` | 2026-04-24T00:00:00Z |  |
| `nfrVerifications` | no | `[...#FNFR]` | `[]` | 2026-04-24T00:00:00Z |  |
| `successMetrics` | no | `[...#FSuccessMetric]` | `[]` | 2026-04-24T00:00:00Z |  |
| `acRelaxations` | no | `[...#ACRelaxation]` | `[]` | 2026-04-24T00:00:00Z |  |
| `operatorActionsRequested` | no | `[...#OperatorAction]` | `[]` | 2026-04-24T00:00:00Z |  |
| `verdict` | no | `"completed" \| "stopped" \| "paused-pending-operator"` | `` | 2026-05-04T00:00:00Z | `"completed"` \| `"stopped"` \| `"paused-pending-operator"` |
| `executionRequiredProbe` | no | `bool` | `false` | 2026-05-04T00:00:00Z |  |
| `liveVerificationAttempt` | no | `bool` | `false` | 2026-05-04T00:00:00Z |  |
| `preRegistered` | no | `bool` | `false` | 2026-05-04T00:00:00Z |  |

### #FileChange

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `kind` | yes | `"corrected" \| "added" \| "dropped" \| "rename-domain"` | `` | 2026-05-04T00:00:00Z | `"corrected"` \| `"added"` \| `"dropped"` \| `"rename-domain"` |
| `from` | no | `string` | `` | 2026-05-04T00:00:00Z |  |
| `to` | no | `string` | `` | 2026-05-04T00:00:00Z |  |
| `path` | no | `string` | `` | 2026-05-04T00:00:00Z |  |
| `reason` | no | `string` | `` | 2026-05-04T00:00:00Z |  |

### #Finding

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^F-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `domain` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `severity` | yes | `"high" \| "medium" \| "low"` | `` | 2026-04-24T00:00:00Z | `"high"` \| `"medium"` \| `"low"` |
| `category` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `file` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `line` | no | `int & >=1` | `` | 2026-04-24T00:00:00Z |  |
| `description` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `suggestedFix` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `assignedSkill` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `"open" \| "fixing" \| "fixed" \| "wontfix"` | `` | 2026-04-24T00:00:00Z | `"open"` \| `"fixing"` \| `"fixed"` \| `"wontfix"` |
| `crossLaneOverlap` | no | `bool` | `false` | 2026-05-04T00:00:00Z |  |

### #GateRow

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `lint` | no | `"pass" \| "fail" \| "skip"` | `` | — | `"pass"` \| `"fail"` \| `"skip"` |
| `typecheck` | no | `string` | `` | — |  |
| `tests` | no | `string` | `` | — |  |

### #GlobalWarning

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `at` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `stepId` | no | `=~"^STEP_[0-9]{2}_[A-Z0-9_]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `message` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #GreenTests

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `added` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `augmented` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `duration` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #Invariant

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `rule` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `source` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #InvariantCheck

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `rule` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `source` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `"passed" \| "failed"` | `` | 2026-04-24T00:00:00Z | `"passed"` \| `"failed"` |
| `note` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #MutationCoverageGap

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `reason` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `uncoveredFiles` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `remediation` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #MutationSurvivor

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `file` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `line` | yes | `int & >=1` | `` | 2026-04-24T00:00:00Z |  |
| `mutator` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `killedByNewTest` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `addedTestFile` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

### #MutationTesting

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `ran` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `tool` | no | `"stryker" \| "mutmut" \| "go-mutesting"` | `null` | 2026-04-24T00:00:00Z | `"stryker"` \| `"mutmut"` \| `"go-mutesting"` |
| `score` | no | `int & >=0 & <=100` | `0` | 2026-04-24T00:00:00Z |  |
| `target` | no | `int & >=0 & <=100` | `0` | 2026-04-24T00:00:00Z |  |
| `survivors` | no | `[...#MutationSurvivor]` | `[]` | 2026-04-24T00:00:00Z |  |
| `coverageGap` | no | `#MutationCoverageGap` | `null` | 2026-04-24T00:00:00Z |  |

### #NFR

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^NFR-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `text` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `description` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `category` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `target` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #Note

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `at` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `stepId` | no | `=~"^STEP_[0-9]{2}_[A-Z0-9_]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `message` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #OperatorAction

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `ac` | no | `=~"^AC-[0-9]+$"` | `null` | 2026-04-24T00:00:00Z |  |
| `kind` | yes | `"deferred-post-merge" \| "manual-verification" \| "inherited-scope-adjustment" \| "blocks-commit" \| "deferred-follow-up" \| "deferred-pre-commit"` | `` | 2026-04-24T00:00:00Z | `"deferred-post-merge"` \| `"manual-verification"` \| `"inherited-scope-adjustment"` \| `"blocks-commit"` \| `"deferred-follow-up"` \| `"deferred-pre-commit"` |
| `description` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `at` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `resolved` | no | `bool` | `false` | 2026-04-24T00:00:00Z |  |
| `resolution` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |

### #OperatorInfo

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `locale` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

### #PRD

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `title` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `overview` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `personas` | no | `[...#Persona]` | `[]` | 2026-04-24T00:00:00Z |  |
| `objectives` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `inScope` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `outOfScope` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `deliverables` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `functionalRequirements` | yes | `[...#FR]` | `` | 2026-04-24T00:00:00Z |  |
| `nonFunctionalRequirements` | no | `[...#NFR]` | `[]` | 2026-04-24T00:00:00Z |  |
| `successMetrics` | no | `[...#SuccessMetric]` | `[]` | 2026-04-24T00:00:00Z |  |
| `acceptanceCriteria` | yes | `[...#AC]` | `` | 2026-04-24T00:00:00Z |  |
| `risks` | no | `[...#Risk]` | `[]` | 2026-04-24T00:00:00Z |  |
| `dependencies` | no | `#PRDDependencies` | `` | 2026-04-24T00:00:00Z |  |
| `assumptions` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `taskGranularity` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

### #PRDDependencies

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `external` | no | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `internal` | no | `[...string]` | `` | 2026-04-24T00:00:00Z |  |

### #Persona

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^P-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `description` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #PrePushAudit

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `name` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `source` | yes | `"lefthook" \| "husky" \| "operator"` | `` | 2026-04-24T00:00:00Z | `"lefthook"` \| `"husky"` \| `"operator"` |
| `exitCode` | yes | `int` | `` | 2026-04-24T00:00:00Z |  |
| `durationMs` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `output` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #PushAttempt

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `sha` | yes | `=~"^[a-f0-9]{7,40}$"` | `` | 2026-04-24T00:00:00Z |  |
| `attemptedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `lefthookBypassed` | no | `bool` | `false` | 2026-04-24T00:00:00Z |  |
| `noVerifyPassed` | no | `bool` | `false` | 2026-04-24T00:00:00Z |  |
| `amendUsed` | no | `bool` | `false` | 2026-04-24T00:00:00Z |  |
| `bypassedAudits` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `bypassReason` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |
| `retryCount` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `previousFailure` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |

### #ReceivingCodeReview

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `iteration` | yes | `int & >=1` | `` | 2026-04-24T00:00:00Z |  |
| `summary` | yes | `#ReceivingSummary` | `` | 2026-04-24T00:00:00Z |  |
| `dispatches` | no | `[...#ReceivingDispatch]` | `[]` | 2026-04-24T00:00:00Z |  |
| `unrecovered` | no | `[...#UnrecoveredFinding]` | `[]` | 2026-04-24T00:00:00Z |  |
| `notes` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

### #ReceivingDispatch

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `findingId` | yes | `=~"^F-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `iteration` | yes | `int & >=1` | `` | 2026-04-24T00:00:00Z |  |
| `reason` | yes | `"initial" \| "retry" \| "research-then-sonnet" \| "research-then-opus" \| "staging-regression" \| "post-deploy" \| "operator-feedback"` | `` | 2026-04-24T00:00:00Z | `"initial"` \| `"retry"` \| `"research-then-sonnet"` \| `"research-then-opus"` \| `"staging-regression"` \| `"post-deploy"` \| `"operator-feedback"` |
| `role` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `skill` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `model` | yes | `"sonnet" \| "opus"` | `` | 2026-04-24T00:00:00Z | `"sonnet"` \| `"opus"` |
| `status` | yes | `"fixed" \| "failed" \| "skipped"` | `` | 2026-04-24T00:00:00Z | `"fixed"` \| `"failed"` \| `"skipped"` |
| `filesChanged` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `researchBundle` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |
| `failureTrace` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |
| `startedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `completedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |

### #ReceivingSummary

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `total` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `fixed` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `unrecovered` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |

### #RegressionFailure

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `testFile` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `testName` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `error` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #RegressionRow

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `file` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `test` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `result` | yes | `"pass" \| "fail" \| "skip"` | `` | 2026-04-24T00:00:00Z | `"pass"` \| `"fail"` \| `"skip"` |

### #RegressionRun

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `tool` | yes | `"vitest" \| "pytest" \| "go test" \| "cargo test" \| "jest" \| "skipped" \| "lefthook"` | `` | 2026-04-24T00:00:00Z | `"vitest"` \| `"pytest"` \| `"go test"` \| `"cargo test"` \| `"jest"` \| `"skipped"` \| `"lefthook"` |
| `scope` | no | `string` | `"blast-radius"` | 2026-04-24T00:00:00Z |  |
| `command` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `commandSource` | yes | `"lefthook" \| "husky" \| "package-scripts" \| "stack-default" \| "operator"` | `` | 2026-04-30T18:00:00Z | `"lefthook"` \| `"husky"` \| `"package-scripts"` \| `"stack-default"` \| `"operator"` |
| `executionDepth` | yes | `"static-only" \| "scoped-execute" \| "full-rehearse"` | `` | 2026-04-30T18:00:00Z | `"static-only"` \| `"scoped-execute"` \| `"full-rehearse"` |
| `filesInRadius` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `testFilesExecuted` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `exitCode` | yes | `int` | `` | 2026-04-24T00:00:00Z |  |
| `passed` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `failed` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `skippedTests` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `duration` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `skipped` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `skipReason` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |
| `summary` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `failures` | no | `[...#RegressionFailure]` | `[]` | 2026-04-24T00:00:00Z |  |

### #ResearchFinding

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `question` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `answer` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `confidence` | yes | `"high" \| "med" \| "low"` | `` | 2026-04-24T00:00:00Z | `"high"` \| `"med"` \| `"low"` |
| `sources` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |

### #ReviewExchange

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `round` | yes | `int & >=1` | `` | 2026-04-24T00:00:00Z |  |
| `proposal` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `operatorAction` | yes | `"approve" \| "adjust" \| "skip" \| "stop"` | `` | 2026-04-24T00:00:00Z | `"approve"` \| `"adjust"` \| `"skip"` \| `"stop"` |
| `operatorNote` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |
| `decidedAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |

### #Risk

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^R-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `text` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `description` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `mitigation` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #ScopeAdjustment

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `kind` | yes | `"spec-relaxation" \| "scope-expansion" \| "scope-reduction" \| "no-op-refactor" \| "out-of-scope-fix" \| "deferred-to-followup"` | `` | 2026-04-30T18:00:00Z | `"spec-relaxation"` \| `"scope-expansion"` \| `"scope-reduction"` \| `"no-op-refactor"` \| `"out-of-scope-fix"` \| `"deferred-to-followup"` |
| `adjustment` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `reason` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `resolution` | yes | `=~"^(accepted\|rejected\|deferred)( — .+)?$"` | `` | 2026-04-24T00:00:00Z |  |
| `owner` | yes | `"specialist" \| "orchestrator"` | `` | 2026-04-24T00:00:00Z | `"specialist"` \| `"orchestrator"` |
| `loggedAsWarning` | no | `bool` | `` | 2026-04-24T00:00:00Z |  |

### #SeverityCounts

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `high` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `medium` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |
| `low` | no | `int & >=0` | `0` | 2026-04-24T00:00:00Z |  |

### #SkillFound

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `domain` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `skill` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `relevance` | no | `"high" \| "med" \| "low"` | `"med"` | 2026-04-24T00:00:00Z | `"high"` \| `"med"` \| `"low"` |

### #StepApplicability

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `applicable` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `reason` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

### #StepDefinitions

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `PRD` | yes | `#PRDStep` | `` | — |  |
| `TASKS_MANIFEST` | yes | `#TasksManifestStep` | `` | — |  |
| `TASK` | yes | `#TaskStep` | `` | — |  |
| `BRAINSTORMING` | yes | `#BrainstormingStep` | `` | — |  |
| `CODE_REVIEW` | yes | `#CodeReviewStep` | `` | — |  |
| `RECEIVING_CODE_REVIEW` | yes | `#ReceivingCodeReviewStep` | `` | — |  |
| `WRITE_TESTS` | yes | `#WriteTestsStep` | `` | — |  |
| `UPDATE_DOCS` | yes | `#UpdateDocsStep` | `` | — |  |
| `FEATURE_ACCEPTANCE` | yes | `#FeatureAcceptanceStep` | `` | — |  |
| `COMMIT` | yes | `#CommitStep` | `` | — |  |

### #StepWorktrees

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `used` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `worktrees` | no | `[...#WorktreeEntry]` | `[]` | 2026-04-24T00:00:00Z |  |

### #SuccessMetric

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^M-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `metric` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `target` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `method` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |

### #TaskAC

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `id` | yes | `=~"^T-AC-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `bindsTo` | yes | `[...=~"^AC-[0-9]+$"]` | `` | 2026-04-24T00:00:00Z |  |
| `description` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #TaskAgent

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `role` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `skill` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `model` | no | `"haiku" \| "sonnet" \| "opus"` | `null` | 2026-04-24T00:00:00Z | `"haiku"` \| `"sonnet"` \| `"opus"` |
| `status` | yes | `"pending" \| "running" \| "completed" \| "failed"` | `` | 2026-04-24T00:00:00Z | `"pending"` \| `"running"` \| `"completed"` \| `"failed"` |
| `startedAt` | no | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `completedAt` | no | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `skillsLoaded` | no | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `notes` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #TaskBrief

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `taskId` | yes | `=~"^TASK_[0-9]{2}$"` | `` | 2026-04-24T00:00:00Z |  |
| `title` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `suggestedModel` | no | `"haiku" \| "sonnet" \| "opus"` | `null` | 2026-04-24T00:00:00Z | `"haiku"` \| `"sonnet"` \| `"opus"` |
| `trivial` | no | `bool` | `false` | 2026-04-24T00:00:00Z |  |
| `skillsFound` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `scope` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `dependsOn` | no | `[...=~"^TASK_[0-9]{2}$"]` | `` | 2026-04-24T00:00:00Z |  |

### #TaskExecution

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `title` | no | `string` | `` | 2026-04-24T00:00:00Z |  |
| `scope` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `dependsOn` | no | `[...=~"^TASK_[0-9]{2}$"]` | `` | 2026-04-24T00:00:00Z |  |
| `invariants` | no | `[...#Invariant]` | `[]` | 2026-04-24T00:00:00Z |  |
| `acceptanceCriteria` | no | `[...#TaskAC]` | `` | 2026-04-24T00:00:00Z |  |
| `suggestedModel` | no | `"haiku" \| "sonnet" \| "opus"` | `null` | 2026-04-24T00:00:00Z | `"haiku"` \| `"sonnet"` \| `"opus"` |
| `trivial` | no | `bool` | `false` | 2026-04-24T00:00:00Z |  |
| `explorer` | no | `#TaskExplorer` | `` | 2026-04-24T00:00:00Z |  |
| `reviewer` | no | `#TaskReviewer` | `` | 2026-04-24T00:00:00Z |  |
| `execution` | yes | `#TaskExecutionResult` | `` | 2026-04-24T00:00:00Z |  |

### #TaskExecutionResult

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `gates` | yes | `#TaskGates` | `` | 2026-04-24T00:00:00Z |  |
| `files` | no | `#TaskFiles` | `` | 2026-04-24T00:00:00Z |  |
| `filesModified` | no | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `filesCreated` | no | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `filesDeleted` | no | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `scopeAdjustments` | no | `[...#ScopeAdjustment]` | `[]` | 2026-04-24T00:00:00Z |  |
| `agents` | no | `[...#TaskAgent]` | `[]` | 2026-04-24T00:00:00Z |  |
| `invariantsChecked` | no | `[...#InvariantCheck]` | `[]` | 2026-04-24T00:00:00Z |  |
| `testsRan` | no | `#TestsRan` | `` | 2026-04-24T00:00:00Z |  |
| `nextSteps` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

### #TaskExplorer

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `model` | no | `"haiku" \| "sonnet" \| "opus"` | `null` | 2026-04-24T00:00:00Z | `"haiku"` \| `"sonnet"` \| `"opus"` |
| `completedAt` | no | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `filesModified` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `filesToRead` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `domains` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `skillsFound` | no | `[...#SkillFound]` | `[]` | 2026-04-24T00:00:00Z |  |

### #TaskFiles

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `created` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `modified` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `deleted` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |

### #TaskGates

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `baseline` | yes | `#GateRow` | `` | 2026-04-24T00:00:00Z |  |
| `postChange` | yes | `#GateRow` | `` | 2026-04-24T00:00:00Z |  |
| `regression` | no | `[...#RegressionRow]` | `[]` | 2026-04-24T00:00:00Z |  |

### #TaskReviewer

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `model` | no | `"haiku" \| "sonnet" \| "opus"` | `null` | 2026-04-24T00:00:00Z | `"haiku"` \| `"sonnet"` \| `"opus"` |
| `completedAt` | no | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `additionalContext` | no | `string \| #AdditionalContextObj` | `""` | 2026-04-24T00:00:00Z |  |
| `skipTestsReason` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |
| `testSpecs` | no | `[...#TestSpec]` | `[]` | 2026-04-24T00:00:00Z |  |

### #TasksManifest

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `totalTasks` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `tasksOrder` | yes | `[...=~"^TASK_[0-9]{2}$"]` | `` | 2026-04-24T00:00:00Z |  |
| `dependencyGraph` | yes | `[string]: [...=~"^TASK_[0-9]{2}$"]` | `` | — |  |
| `parallelizable` | no | `[...[...=~"^TASK_[0-9]{2}$"]]` | `[]` | 2026-04-24T00:00:00Z |  |
| `tasks` | no | `[...#TaskBrief]` | `` | 2026-04-24T00:00:00Z |  |

### #TestSpec

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `testId` | yes | `=~"^T-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `file` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `intent` | yes | `"green" \| "red" \| "chaos"` | `` | 2026-05-06T00:00:00Z | `"green"` \| `"red"` \| `"chaos"` |
| `scope` | yes | `"unit" \| "integration" \| "e2e" \| "chaos"` | `` | 2026-05-06T00:00:00Z | `"unit"` \| `"integration"` \| `"e2e"` \| `"chaos"` |
| `description` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `coverageTarget` | no | `string` | `` | 2026-04-24T00:00:00Z |  |

### #TestsRan

_(no fields recorded for #TestsRan)_

### #TwoPassRun

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `directRef` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `conceptLevel` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `mentionsPass` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `mentionsFallbackUsed` | yes | `bool` | `` | 2026-04-30T18:00:00Z |  |
| `mentionsResultEmpty` | no | `"all-new-files" \| "no-edges" \| "uncommitted-edits" \| "index-lag"` | `null` | 2026-04-30T18:00:00Z | `"all-new-files"` \| `"no-edges"` \| `"uncommitted-edits"` \| `"index-lag"` |

### #UnrecoveredFinding

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `findingId` | yes | `=~"^F-[0-9]+$"` | `` | 2026-04-24T00:00:00Z |  |
| `severity` | yes | `"high" \| "medium" \| "low"` | `` | 2026-04-24T00:00:00Z | `"high"` \| `"medium"` \| `"low"` |
| `lastTrace` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `totalIterations` | yes | `int & >=1` | `` | 2026-04-24T00:00:00Z |  |
| `modelsTried` | yes | `[...string]` | `` | 2026-04-24T00:00:00Z |  |
| `researchPassesRun` | yes | `int & >=0` | `` | 2026-04-24T00:00:00Z |  |
| `loggedToTechDebt` | no | `string` | `null` | 2026-04-24T00:00:00Z |  |

### #UpdateDocs

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `docsMentioning` | no | `[...#DocMention]` | `[]` | 2026-04-24T00:00:00Z |  |
| `anchorDocsAlwaysIncluded` | no | `[...#AnchorDoc]` | `[]` | 2026-04-24T00:00:00Z |  |
| `patches` | no | `[...#DocPatch]` | `[]` | 2026-04-24T00:00:00Z |  |
| `twoPassRun` | yes | `#TwoPassRun` | `` | 2026-04-24T00:00:00Z |  |

### #Warning

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `kind` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `message` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `at` | no | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |

### #WorkflowConfig

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `mode` | no | `"review"` | `"autonomous"` | 2026-04-24T00:00:00Z | `"review"` |
| `executionStrategy` | no | `"serial" \| "parallel-worktrees" \| "agent-teams" \| "parallel"` | `` | 2026-04-24T00:00:00Z | `"serial"` \| `"parallel-worktrees"` \| `"agent-teams"` \| `"parallel"` |
| `testExecutionDepth` | no | `"static-only" \| "scoped-execute" \| "full-rehearse"` | `` | 2026-04-30T18:00:00Z | `"static-only"` \| `"scoped-execute"` \| `"full-rehearse"` |
| `testExecutionDepthAuto` | no | `bool` | `` | 2026-04-30T18:00:00Z |  |
| `setAt` | yes | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |
| `switchedFrom` | no | `"autonomous" \| "review"` | `` | 2026-04-24T00:00:00Z | `"autonomous"` \| `"review"` |
| `switchedAt` | no | `time.Format(time.RFC3339)` | `` | 2026-04-24T00:00:00Z |  |

### #WorktreeEntry

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `name` | yes | `string` | `` | 2026-04-24T00:00:00Z |  |
| `status` | yes | `"ACTIVE" \| "MERGED" \| "PR_OPENED" \| "ABANDONED" \| "CREATED"` | `` | 2026-04-24T00:00:00Z | `"ACTIVE"` \| `"MERGED"` \| `"PR_OPENED"` \| `"ABANDONED"` \| `"CREATED"` |

### #WriteTests

| Field | Required | Type | Default | AddedIn | Literal values |
|---|---|---|---|---|---|
| `skipped` | yes | `bool` | `` | 2026-04-24T00:00:00Z |  |
| `skipReason` | no | `"no-test-setup" \| string` | `null` | 2026-04-24T00:00:00Z |  |
| `runner` | no | `"vitest" \| "jest" \| "pytest" \| "go test" \| "cargo test"` | `null` | 2026-04-24T00:00:00Z | `"vitest"` \| `"jest"` \| `"pytest"` \| `"go test"` \| `"cargo test"` |
| `filesAuthored` | no | `[...string]` | `[]` | 2026-04-24T00:00:00Z |  |
| `greenTests` | no | `#GreenTests` | `` | 2026-04-24T00:00:00Z |  |
| `mutationTesting` | no | `#MutationTesting` | `` | 2026-04-24T00:00:00Z |  |
| `notes` | no | `string` | `""` | 2026-04-24T00:00:00Z |  |

