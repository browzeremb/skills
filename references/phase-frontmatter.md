# Phase artifact frontmatter — single source of truth

Every phase skill that writes a phase artifact under `<feat>/staging/` Reads this file at write time; consumers Read it at parse time. The contract for each artifact's required and optional frontmatter keys lives here only.

## PRD.md

REQUIRED keys: `featureId`, `complexityTier`, `pm`, `originalRequest`, `prdReceipts[]`, `acCount`, `nfrCount`, `smCount`.
OPTIONAL keys: `assumptions[]`, `searchTriggerProposals[]`, `openQuestions[]`.

### prdSha computation

The PRD's content hash, consumed by downstream phases for drift detection, is computed as a SHA-256 over the raw bytes of `PRD.md`, optionally concatenated with `PRD_AMENDMENTS.md` when that file exists. The concatenation contract closes the failure class where post-PRD wording fixes invalidate every downstream artifact's `prdSha`. Phase skills that record `prdSha` MUST compute it via this rule.

**Byte-level specification:**

```
prdSha = sha256(concatenation of:
  - PRD.md's raw bytes (including any trailing newline)
  - (only when PRD_AMENDMENTS.md exists): a single 0x0a byte (LF), then PRD_AMENDMENTS.md's raw bytes
)

When PRD_AMENDMENTS.md does not exist, prdSha = sha256(PRD.md raw bytes).
When PRD_AMENDMENTS.md exists,       prdSha = sha256(PRD.md raw bytes || 0x0a || PRD_AMENDMENTS.md raw bytes).
```

**Implementations MUST:**
- Read both files in binary mode (`Buffer` in Node, `bytes` in Python).
- Compute SHA-256 over the concatenation; output is lower-case hex.
- Never trim or normalize whitespace before hashing.

## EXPLORATION.md

REQUIRED: `featureId`, `prdSha`, `scoper`, `skillsFound[]`, `files[]`.
OPTIONAL: `searchTriggerProposals[]`, `granularityWarnings[]`, `crossFileCouplingNotes[]`.

## TASK_NN.md

REQUIRED: `taskId`, `title`, `role`, `domain`, `prdSha`, `suggestedModel`, `trivial`, `dependsOn[]`, `coderRole`, `acceptanceCriteria[]`, `scope.files[]`, `outOfScopeFiles[]`, `skillsFound[]`, `invariants[]`.
OPTIONAL: `granularityNote`, `sensitiveScope`, `sensitiveMatchedFiles[]`.

## review/CODE_REVIEW.md

REQUIRED: `featureId`, `prdSha`, `sensitivePathGate`, `lanes[]`, `findings[]`, `verdict`, `severityCounts`.
OPTIONAL: `regressionRun`, `consolidatorMode`. `findings[]` entries MAY carry `round: <int>` (regression-guard appends round-2/3 findings; backward-compatible default `round: 1`) and `fixStatus` (set in place by `aggregate-fixes.mjs`).

## fixes/FIXES.md (and the back-compat sidecar review/RECEIVING_CODE_REVIEW.md)

REQUIRED: `featureId`, `prdSha`, `summary.fixed`, `summary.techDebt`, `techDebtBreakdown`, `fixOutcomes[]`.
OPTIONAL: `coupledFindingBatches[]`.

## tasks/TASK_NN.completed.md (Lever C frontmatter additions)

REQUIRED (Lever C additions, appended by execute-task on success): `qualityGate: {runner, lint, typecheck, test, build?, retries}`, `testsAdded[]`.

## review/GATE_REPORT.md

REQUIRED: `featureId`, `round`, `runner`, `gateResults: {lint, typecheck, test, build?}`, `correlatedFixes[]`.
OPTIONAL: `notes`.

## acceptance/DOC_PATCHES.md

REQUIRED: `featureId`, `prdSha`, `patchesApplied`, `candidatesConsidered`.
OPTIONAL: `enoentFixed`, `brokenCommandsFound`, `brokenCommandsFixed`.

## ACCEPTANCE.md

REQUIRED: `featureId`, `prdSha`, `mode`, `verdict`, `executionRequiredProbe`.
OPTIONAL: `modeNote`, `pinsFindings[]`.

## README.md

REQUIRED: `featureId`, `verdict`, `commitSha`, `tasksCount`, `findingsFixed`, `findingsTechDebt`, `testsAdded`, `docsPatched`.
OPTIONAL: `blastRadiusReceipts[]`, `regressionGuardRound`. `mutationKillRate` was removed in Lever C (mutation testing dropped from the workflow entirely).
