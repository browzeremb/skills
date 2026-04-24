# workflow.json — Schema v1 (authoritative)

This is the canonical reference for every skill that reads or writes
`docs/browzer/<feat>/workflow.json`. Skills embed jq queries based on
this schema; the frontmatter validator enforces required tools.

## §1 File location and mutation discipline

- **Path**: `docs/browzer/<feat>/workflow.json` (one per feature).
- **Format**: pretty-printed JSON, 2-space indent, UTF-8, LF.
- **Mutation discipline**: never edited with `Read`/`Write`/`Edit` tools. All mutations via `jq | mv` atomic rename. Operator never edits manually.

## §2 Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "featureId": "feat-20260424-workflow-redesign",
  "featureName": "Workflow redesign",
  "featDir": "docs/browzer/feat-20260424-workflow-redesign",
  "originalRequest": "<operator request verbatim>",
  "operator": { "locale": "pt-BR" },
  "config": {
    "mode": "autonomous" | "review",
    "setAt": "<ISO8601>",
    "switchedFrom": "<mode>",    // optional, when switched mid-flow
    "switchedAt": "<ISO8601>"    // optional, when switched mid-flow
  },
  "startedAt": "<ISO8601>",
  "updatedAt": "<ISO8601>",
  "totalElapsedMin": 17.3,
  "currentStepId": "STEP_07_TASK_03",
  "nextStepId": "STEP_08_TASK_04",
  "totalSteps": 12,
  "completedSteps": 6,
  "notes": [],
  "globalWarnings": [
    { "at": "<ISO8601>", "stepId": "...", "message": "..." }
  ],
  "steps": [ /* §5.3 */ ]
}
```

## §3 Step structure (discriminated union)

Every step has common fields + exactly one payload key matching its `name` (lowercased):

```jsonc
{
  "stepId": "STEP_04_TASK_01",
  "name": "TASK",
  "taskId": "TASK_01",                               // present only for TASK steps
  "status": "PENDING" | "RUNNING" | "AWAITING_REVIEW" | "COMPLETED" | "SKIPPED" | "STOPPED",
  "applicability": { "applicable": true, "reason": "default path" },
  "startedAt": "<ISO>", "completedAt": "<ISO>", "elapsedMin": 4.2,
  "retryCount": 0,
  "itDependsOn": ["STEP_03_TASKS_MANIFEST"],
  "nextStep": "STEP_05_TASK_02",
  "skillsToInvoke": ["execute-task"],
  "skillsInvoked": ["execute-task", "write-tests"],
  "owner": "worktree-TASK_01",                       // or null if not parallel
  "worktrees": {
    "used": true,
    "worktrees": [
      { "name": "worktree-TASK_01", "status": "ACTIVE" | "MERGED" | "PR_OPENED" }
    ]
  },
  "warnings": [],
  "reviewHistory": [ /* §7.7 */ ],
  "task": { /* payload typed per §5.4 */ }
}
```

## §4 Payload shapes per step type

### `brainstorm`

```jsonc
{
  "questionsAsked": 8,
  "researchRoundRun": false,
  "researchAgents": 0,
  "dimensions": {
    "primaryUser": "string",
    "jobToBeDone": "string",
    "successSignal": "string",
    "inScope": ["string"],
    "outOfScope": ["string"],
    "repoSurface": ["path"],
    "techConstraints": ["string"],
    "failureModes": ["string"],
    "acceptanceCriteria": ["string"],
    "dependencies": ["string"],
    "openQuestions": ["string"]
  },
  "researchFindings": [
    { "question": "string", "answer": "string", "confidence": "high|med|low", "sources": ["url"] }
  ],
  "assumptions": ["string"],
  "openRisks": ["string"]
}
```

### `prd`

```jsonc
{
  "title": "string",
  "overview": "string",
  "personas": [{ "id": "P-1", "description": "string" }],
  "objectives": ["string"],
  "functionalRequirements": [{ "id": "FR-1", "description": "string", "priority": "must|should|could" }],
  "nonFunctionalRequirements": [{ "id": "NFR-1", "category": "perf|security|a11y|…", "description": "string", "target": "string" }],
  "successMetrics": [{ "id": "M-1", "metric": "string", "target": "string", "method": "string" }],
  "acceptanceCriteria": [{ "id": "AC-1", "description": "string", "bindsTo": ["FR-1"] }],
  "assumptions": ["string"],
  "risks": [{ "id": "R-1", "description": "string", "mitigation": "string" }],
  "deliverables": ["string"],
  "inScope": ["string"],
  "outOfScope": ["string"],
  "dependencies": { "external": ["string"], "internal": ["string"] },
  "taskGranularity": "one-task-one-commit" | "grouped-by-layer" | "…"
}
```

### `tasksManifest`

```jsonc
{
  "totalTasks": 5,
  "tasksOrder": ["TASK_01", "TASK_02", "TASK_03", "TASK_04", "TASK_05"],
  "dependencyGraph": {
    "TASK_01": [],
    "TASK_02": ["TASK_01"],
    "TASK_03": ["TASK_01"],
    "TASK_04": ["TASK_02", "TASK_03"],
    "TASK_05": ["TASK_04"]
  },
  "parallelizable": [["TASK_02", "TASK_03"]]
}
```

### `task`

```jsonc
{
  "title": "string",
  "scope": ["string"],
  "dependsOn": ["TASK_XX"],
  "invariants": [{ "rule": "string", "source": "path#§" }],
  "acceptanceCriteria": [{ "id": "T-AC-1", "description": "string" }],
  "suggestedModel": "haiku" | "sonnet" | "opus",
  "trivial": false,

  "explorer": {
    "model": "haiku",
    "completedAt": "<ISO>",
    "filesModified": ["path"],
    "filesToRead": ["path"],
    "depsGraph": {
      "path": { "imports": ["path"], "importedBy": ["path"] }
    },
    "domains": ["fastify-backend", "redis", "…"],
    "skillsFound": [
      { "domain": "redis", "skill": ".claude/skills/redis-specialist", "relevance": "high|med|low" }
    ]
  },

  "reviewer": {
    "model": "sonnet",
    "completedAt": "<ISO>",
    "additionalContext": "string",
    "tddDecision": {
      "applicable": true,
      "reason": "string",
      "skipReason": null | "string"
    },
    "testSpecs": [
      {
        "testId": "T-1",
        "file": "path/__tests__/xyz.test.ts",
        "type": "red" | "green",
        "description": "string",
        "coverageTarget": "function|branch|…"
      }
    ]
  },

  "execution": {
    "agents": [
      {
        "role": "test-specialist",
        "skill": "test-driven-development",
        "model": "sonnet",
        "status": "pending|running|completed|failed",
        "startedAt": "<ISO>",
        "completedAt": "<ISO>",
        "notes": "string"
      },
      {
        "role": "redis-specialist",
        "skill": ".claude/skills/redis-specialist",
        "model": "sonnet",
        "status": "completed"
      }
    ],
    "files": {
      "created": ["path"],
      "modified": ["path"],
      "deleted": ["path"]
    },
    "gates": {
      "baseline": { "lint": "pass|fail|skip", "typecheck": "…", "tests": "1309 pass" },
      "postChange": { "lint": "…", "typecheck": "…", "tests": "1312 pass" },
      "regression": [{ "file": "path", "test": "name", "result": "pass|fail" }]
    },
    "invariantsChecked": [
      { "rule": "string", "source": "string", "status": "passed|failed", "note": "string" }
    ],
    "scopeAdjustments": [
      { "adjustment": "string", "reason": "string", "resolution": "string" }
    ],
    "fileEditsSummary": {
      "path": { "edits": 3, "details": ["string"] }
    },
    "testsRan": {
      "preChange": { "testCount": "92 passed", "duration": "3.75s", "details": "string" },
      "postChange": { "testCount": "92 passed", "duration": "3.64s", "details": "string" }
    },
    "nextSteps": "string"
  }
}
```

### `codeReview`

```jsonc
{
  "agentTeamsEnabled": false,
  "dispatchMode": "agent-teams" | "parallel-with-consolidator",
  "reviewTier": "basic" | "recommended" | "custom",
  "tokenCostEstimate": 45000,
  "mandatoryMembers": ["senior-engineer", "qa", "mutation-testing"],
  "recommendedMembers": ["security", "performance"],
  "customMembers": [],
  "cyclomaticAudit": {
    "conductedBy": "senior-engineer",
    "files": [
      { "file": "path", "maxComplexity": 12, "threshold": 10, "verdict": "warn|ok|fail" }
    ]
  },
  "mutationTesting": {
    "ran": true,
    "tool": "stryker|mutmut|go-mutesting",
    "score": 75,
    "target": 70,
    "testsToUpdate": [
      { "testFile": "path", "changeNeeded": "string", "reason": "string" }
    ]
  },
  "findings": [
    {
      "id": "F-1",
      "domain": "fastify-backend",
      "severity": "high|medium|low",
      "category": "security|perf|style|logic|…",
      "file": "path",
      "line": 42,
      "description": "string",
      "suggestedFix": "string",
      "assignedSkill": ".claude/skills/owasp-security-review",
      "status": "open|fixing|fixed|wontfix"
    }
  ]
}
```

### `fixFindings`

```jsonc
{
  "totalFindings": 5,
  "fixedFindings": 4,
  "skippedFindings": 1,
  "dispatches": [
    {
      "findingId": "F-1",
      "role": "fastify-backend",
      "skill": ".claude/skills/owasp-security-review",
      "model": "sonnet",
      "status": "done|failed|skipped",
      "filesChanged": ["path"]
    }
  ],
  "qualityGates": { "lint": "pass", "typecheck": "pass", "tests": "1312 pass" },
  "regressionTests": {
    "blastRadiusFiles": ["path"],
    "testsRun": 247,
    "testsPassed": 247,
    "testsFailed": 0,
    "duration": "18.2s"
  }
}
```

### `updateDocs`

```jsonc
{
  "docsMentioning": [
    {
      "sourceFile": "apps/api/src/routes/auth.ts",
      "mentionedBy": [
        { "doc": "docs/runbooks/RBAC_OPERATIONS.md", "confidence": 0.92 }
      ]
    }
  ],
  "patches": [
    {
      "doc": "path",
      "reason": "string",
      "linesChanged": 12,
      "verdict": "applied|skipped|failed"
    }
  ],
  "budgetUsed": 0.4,
  "budgetMax": 1.0,
  "twoPassRun": { "directRef": true, "conceptLevel": true }
}
```

### `featureAcceptance`

```jsonc
{
  "mode": "autonomous" | "manual",
  "acceptanceCriteria": [
    { "id": "AC-1", "status": "verified|unverified|failed", "evidence": "string", "method": "test|inspect|metric" }
  ],
  "nfrVerifications": [
    { "id": "NFR-1", "status": "verified|failed", "evidence": "string", "measured": "string", "target": "string" }
  ],
  "successMetrics": [
    { "id": "M-1", "measured": 42, "target": 40, "status": "met|unmet" }
  ],
  "operatorActionsRequested": [
    { "at": "<ISO>", "description": "string", "resolved": true, "resolution": "string" }
  ]
}
```

### `commit`

```jsonc
{
  "sha": "abc123",
  "conventionalType": "feat|fix|chore|docs|refactor|test",
  "scope": "skills|cli|api|…",
  "subject": "string",
  "body": "string",
  "trailers": [
    "Co-Authored-By: Claude <noreply@anthropic.com>"
  ]
}
```

## §5 Status lifecycle

```
PENDING ──start──► RUNNING
  │                   │
  │                   ├──(mode=review)──► AWAITING_REVIEW ──approve──► COMPLETED
  │                   │                       │
  │                   │                       ├──skip────► SKIPPED
  │                   │                       └──stop────► STOPPED
  │                   │
  │                   └──(mode=autonomous)──► COMPLETED
  │
  ├──applicability.applicable=false──► SKIPPED
  └──stop condition────────────────► STOPPED
```

## §6 Step ID scheme

- Unique steps (once per feature): `STEP_NN_<NAME>` (uppercase). E.g. `STEP_01_BRAINSTORMING`, `STEP_02_PRD`, `STEP_03_TASKS_MANIFEST`, `STEP_<NN>_CODE_REVIEW`, `STEP_<NN>_FIX_FINDINGS`, `STEP_<NN>_UPDATE_DOCS`, `STEP_<NN>_FEATURE_ACCEPTANCE`, `STEP_<NN>_COMMIT`.
- Per-task steps (N tasks → N steps): `STEP_NN_TASK_MM`. E.g. `STEP_04_TASK_01`, `STEP_05_TASK_02`.
- `NN` is the monotonic step index (01, 02, …); `MM` is the task number from `tasksManifest.tasksOrder`.

## §7 schemaVersion policy

- v1 locks at redesign merge.
- During the redesign branch, `schemaVersion` may drift as draft milestones (documented in commits).
- Post-merge bumps to v2 require a migration script in `scripts/migrate-workflow-v1-to-v2.ts` plus a new reference doc section.

## §8 Size guards

- Soft warning: `workflow.json > 300 KB` → agent appends to `globalWarnings[]`, continues.
- Hard stop: `> 1 MB` → skill stops; emits `hint: consider splitting feature into sub-features`. No auto-split in v1.
- Reference: today's largest `.meta/` dir sums ~40 KB; expect v1 to sit well under the soft warning.

## §9 Canonical jq views

Documented in `packages/skills/references/workflow-schema.md` §Views. Example views per skill:

| Skill | Canonical jq view |
| ----- | ----------------- |
| `generate-prd` | `.steps[] | select(.name=="PRD") | .prd` |
| `generate-task` (Explorer) | `.steps[] | select(.name=="PRD") | .prd` + `.steps[] | select(.taskId==$id) | .task` |
| `execute-task` | `.steps[] | select(.stepId==$id)` |
| `write-tests` (in-execute) | `.steps[] | select(.stepId==$id) | .task.reviewer.testSpecs` |
| `test-driven-development` | idem |
| `code-review` | `{prd: (.steps[] | select(.name=="PRD") | .prd), tasks: [.steps[] | select(.name=="TASK")]}` |
| `fix-findings` | `.steps[] | select(.name=="CODE_REVIEW") | .codeReview.findings[] | select(.status=="open")` |
| `update-docs` | `[.steps[] | select(.name=="TASK") | .task.execution.files] | add` (all changed files) |
| `feature-acceptance` | PRD's AC/NFR/metrics + completed task executions |
| `commit` | `.steps[] | select(.stepId==$id) | .task.execution.files` |

**Rule**: no skill uses `Read` on `workflow.json`. Only `Bash(jq *)`.

## §10 Atomic write pattern

```bash
jq --arg id "$STEP_ID" \
   --argjson update '<payload>' \
   --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '(.steps[] | select(.stepId==$id)) |= (. + $update)
    | .updatedAt = $now
    | .currentStepId = $id
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Three guarantees:
1. Filter by `stepId` prevents cross-index writes.
2. `.tmp + mv` on same FS is atomic (POSIX) — concurrent readers never see partial state.
3. Top-level fields (`updatedAt`, `currentStepId`, `completedSteps`) refreshed in same op.

## §11 allowed-tools cluster

Base cluster for any skill touching `workflow.json`:

```yaml
allowed-tools: Bash(jq *), Bash(mv *), Bash(date *), Bash(browzer *)
```

Additions by role:
- Review-candidate skills: `AskUserQuestion`
- Skills writing source code: `Read`, `Write`, `Edit`
- Skills dispatching specialist agents: `Agent`
- `code-review`: `Agent`, `AskUserQuestion`, `Bash(find *)`, `Bash(grep *)`
- `feature-acceptance`: `Agent`, `AskUserQuestion`, plus any gate runner

**Validator extension** (`scripts/validate-frontmatter.mjs`): any skill whose `description` or `SKILL.md` body mentions `workflow.json` MUST declare `Bash(jq *)` and `Bash(mv *)`. Violations fail `pnpm turbo test`.

## §12 One-line output contract

Success:
```
<skill>: updated workflow.json <stepId>; status <STATUS>; steps <done>/<total>
```

Failure:
```
<skill>: stopped at <stepId> — <reason>
hint: <actionable next step>
```

## §13 Render templates

One jq template per step-type in `packages/skills/references/renderers/*.jq`:

- `brainstorm.jq`
- `prd.jq`
- `tasks-manifest.jq`
- `task.jq`
- `code-review.jq`
- `fix-findings.jq`
- `update-docs.jq`
- `feature-acceptance.jq`
- `commit.jq`

Invocation:
```bash
jq -r --from-file packages/skills/references/renderers/prd.jq \
   --arg stepId "$STEP_ID" \
   "$WORKFLOW" > "/tmp/review-$STEP_ID.md"
```

Templates live under `references/` because they're cross-cutting contracts — not skill-internal logic.
