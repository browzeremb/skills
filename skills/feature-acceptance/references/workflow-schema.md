# workflow.json — Schema v1 (authoritative)

This is the canonical reference for every skill that reads or writes
`docs/browzer/<feat>/workflow.json`. Skills embed jq queries based on
this schema; the frontmatter validator enforces required tools.

## §1 File location and mutation discipline

- **Path**: `docs/browzer/<feat>/workflow.json` (one per feature).
- **Format**: pretty-printed JSON, 2-space indent, UTF-8, LF.
- **Mutation discipline**: never edited with `Read`/`Write`/`Edit` tools. All mutations via the **canonical `browzer workflow *` CLI surface** (see below). Operator never edits manually.

### Canonical I/O surface — `browzer workflow *` subcommands

Post-migration, all skills use the `browzer workflow` subcommands for every mutation and semantic read. The CLI handles atomic rename (tmp+rename), advisory flock with stale-PID recovery, and counter recomputation internally — skills no longer need to manage any of that.

| Subcommand | Purpose |
| --- | --- |
| `browzer workflow append-step --workflow <path>` | Append a new step JSON (stdin or `--payload <file>`). Auto-recomputes `totalSteps`, `completedSteps`, `updatedAt`. |
| `browzer workflow update-step <stepId> --workflow <path>` | Patch fields on an existing step (JSON patch via stdin or `--payload`). |
| `browzer workflow complete-step <stepId> --workflow <path>` | Flip step status → `COMPLETED`; sets `completedAt`, recomputes `completedSteps`. |
| `browzer workflow set-status <stepId> <STATUS> --workflow <path>` | Set step status to any lifecycle value (`RUNNING`, `AWAITING_REVIEW`, `STOPPED`, etc.). |
| `browzer workflow set-config <key> <value> --workflow <path>` | Set a key under `.config` (e.g. `mode`, `setAt`). |
| `browzer workflow get-config <key> --workflow <path>` | Print a scalar config field unquoted; use `${VAR:-default}` shell idiom for defaults. |
| `browzer workflow get-step <stepId> --workflow <path> [--field <jqpath>] [--render <template>] [--bash-vars]` | Print a step (or a sub-field) as JSON; `--render <template>` emits a compressed prompt-embed text block; `--bash-vars` emits eval-safe `KEY='value'` lines. Read-only. |
| `browzer workflow query <named> --workflow <path>` | Run a pre-baked cross-step aggregation. Registry: `reused-gates`, `failed-findings`, `open-deferred-actions`, `task-gates-baseline`, `changed-files`, `deferred-scope-adjustments`, `open-findings`, `next-step-id`. Pure Go (no jq), schema-validated, audit-line emitted. Run `--help` for descriptions. |
| `browzer workflow set-current-step <stepId> --workflow <path>` | Set `currentStepId` and propagate `nextStepId`. |
| `browzer workflow append-review-history <stepId> --workflow <path>` | Append a review history entry (stdin or `--payload <file>`). |
| `browzer workflow patch --jq '<expr>' --workflow <path>` | Apply an arbitrary jq mutation; use only when no semantic verb fits. Respects the same advisory lock and tmp+rename guarantees. |
| `browzer workflow validate --workflow <path>` | Structural integrity check; exits non-zero on schema violations. |

**Lock semantics**: every write subcommand acquires an advisory flock before reading, computing, and atomically writing via tmp+rename. Stale PIDs are recovered automatically. Use `--no-lock` only for explicitly read-only calls (`get-step`, `get-config`, `validate`).

**Atomicity guarantee**: identical to the legacy `jq | mv` pattern — tmp+rename on the same filesystem is POSIX-atomic for concurrent readers.

### Legacy raw `jq | mv` pattern — deprecated; migration window only

The following pattern is **deprecated** and accepted only during the migration window (PRD R-5):

```bash
# DEPRECATED — use browzer workflow * instead
jq '<expression>' "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Skills that have not yet been migrated may still use this form. Once all 9 workflow skills are migrated, the legacy form will be removed from the validator's acceptance criteria. Read-only `jq` calls against `$WORKFLOW` (no `mv`) are permitted indefinitely for cross-step searches that `get-step` does not yet cover.

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
  "status": "PENDING" | "RUNNING" | "AWAITING_REVIEW" | "COMPLETED" | "PAUSED_PENDING_OPERATOR" | "SKIPPED" | "STOPPED",
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
  "consolidator": {
    "mode": "in-line" | "dispatched-agent",
    "reason": "string"            // why this mode (scope tier, qualitative-synthesis-needed, etc.)
  },
  "baseline": {
    "source": "workflow-json" | "fresh-run" | "hybrid",
    "reusedGates": ["lint", "typecheck", "tests"],   // gates inherited from upstream task steps
    "freshGates": [],                                 // gates re-run because reused signal was missing/stale
    "duration": "string"
  },
  "severityCounts": { "high": 0, "medium": 0, "low": 0 },   // derived from findings[]; populate before COMPLETED
  "cyclomaticAudit": {
    "conductedBy": "senior-engineer",
    "files": [
      { "file": "path", "maxComplexity": 12, "threshold": 10, "verdict": "warn|ok|fail" }
    ]
  },
  "duplicationFindings": [        // from senior-engineer dup audit (3+ files with same pattern)
    { "pattern": "string", "files": ["path"], "suggestedExtraction": "string" }
  ],
  "mutationTesting": {
    "ran": true,
    "tool": "stryker|mutmut|go-mutesting",
    "score": 75,
    "target": 70,
    "coverageGap": null | {        // set when runner installed but its config doesn't cover the changed scope
      "reason": "string",          // e.g. "runner config does not include changed files"
      "uncoveredFiles": ["path"],
      "remediation": "string"      // suggested config patch or one-shot config path
    },
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

`fix-findings` is re-entrant: the orchestrator may re-enter the loop AFTER `feature-acceptance` started when the operator's staging smoke-test surfaces regressions. Each entry into the loop appends a new dispatch with an explicit `iteration` number and a `reason` that records why the loop was opened. **Never sibling-key payloads** (`stagingRegressionFixes`, `stagingRegressionFixes2`, …) — that pattern is banned; use the array shape below.

**Topology contract (always-present step).** Whenever the prior `CODE_REVIEW` step recorded any finding (open or otherwise), a `STEP_<NN>_FIX_FINDINGS` step MUST be written to the audit trail — even when the fixes were applied inline by the code-review consolidator instead of via a dispatched fix-loop. Set `mode: "dispatched"` for the loop case and `mode: "inline-from-code-review"` when the code-review step absorbed the fixes; the second form lets retro-analysis treat both topologies uniformly. Skipping the FIX_FINDINGS step entirely (going straight from CODE_REVIEW to UPDATE_DOCS) is a contract violation — the resulting audit trail loses the fix dispatch graph.

**Dispatch sizing**. The loop MUST split a single dispatch when it would carry more than 8 findings, because long Edit-chains routinely truncate mid-flight. Split at any natural boundary (per-file, per-domain, per-severity); record each split as a separate `dispatches[]` entry with the same `iteration`.

```jsonc
{
  "mode": "dispatched" | "inline-from-code-review",
  "totalFindings": 5,
  "fixedFindings": 4,
  "skippedFindings": 1,
  "iterations": 1,
  "dispatches": [
    {
      "findingId": "F-1",
      "iteration": 1,
      "reason": "initial|staging-regression|post-deploy|operator-feedback",
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
  "anchorDocsAlwaysIncluded": [
    {
      "doc": "docs/CHANGELOG.md",
      "source": "repo-root-changelog | walk-up | repo-root-debts | user-visible-change",
      "disposition": "auto-included-fresh | deduped-vs-direct-ref | deduped-vs-mentions | deduped-vs-concept | skipped-no-user-visible-change | skipped-historical-archived"
    }
  ],
  "patches": [
    {
      "doc": "path",
      "reason": "string",
      "linesChanged": 12,
      "verdict": "applied|skipped|failed",
      "notes": "string (optional)"
    }
  ],
  "budgetUsed": 7,
  "budgetMax": 12,
  "budgetTier": "small" | "medium" | "large",
  "twoPassRun": { "directRef": true, "conceptLevel": true }
}
```

### `featureAcceptance`

```jsonc
{
  "mode": "autonomous" | "manual" | "hybrid",
  "modeNote": "string",
  "acceptanceCriteria": [
    { "id": "AC-1", "status": "verified|unverified|failed", "evidence": "string", "method": "test|inspect|metric",
      "rationale": "string"   // optional — required when an AC was split via the §"code-only" carve-out }
  ],
  "nfrVerifications": [
    { "id": "NFR-1", "status": "verified|partial|failed", "coversAcceptanceSignal": "pass|warn|block",  "evidence": "string", "measured": "string", "target": "string" }
  ],
  "successMetrics": [
    { "id": "M-1", "measured": 42, "target": 40, "status": "met|unmet" }
  ],
  "acRelaxations": [             // optional; populated when the operator relaxes an AC target at acceptance time
    { "acId": "AC-4", "originalTarget": "string", "relaxedTarget": "string",
      "rationale": "string", "source": "operator", "at": "<ISO>" }
  ],
  "operatorActionsRequested": [
    { "ac": "AC-1" | null,
      "kind": "deferred-post-merge" | "manual-verification" | "inherited-scope-adjustment",
      "description": "string",
      "at": "<ISO>",
      "resolved": false,
      "resolution": null
    }
  ]
}
```

**Verdict computation** — three-way, NOT binary:

1. Count `failed` checks: any `acceptanceCriteria[].status == "failed"`, any `nfrVerifications[].status == "failed"` OR (`status == "partial" && coversAcceptanceSignal == "block"`), any `successMetrics[].status == "unmet"`.
2. Count `pendingDeferred`: `operatorActionsRequested[]` entries with `resolved == false && kind == "deferred-post-merge"`.
3. Decide:
   - `failed > 0` → step `status: "STOPPED"` (a real check failed; remediation needed).
   - `failed == 0 && pendingDeferred > 0` → step `status: "PAUSED_PENDING_OPERATOR"` (the autonomous portion succeeded but the operator owes action). The orchestrator's `commit` phase still runs — it does not block. The truth-claim is honest: the deferred entries are NOT "verified", they are explicitly waiting on the operator.
   - `failed == 0 && pendingDeferred == 0` → step `status: "COMPLETED"`.

Never map a deferred-post-merge entry to `status: "verified"` with `method: "operator-deferral"` — that conflates "we proved it works" with "we'll observe it later" and silently inflates verification counts.

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
  │                   ├──(mode=autonomous)──► COMPLETED
  │                   │
  │                   └──(deferred-post-merge actions outstanding)──► PAUSED_PENDING_OPERATOR
  │
  ├──applicability.applicable=false──► SKIPPED
  └──stop condition────────────────► STOPPED
```

`PAUSED_PENDING_OPERATOR` is the honest verdict for steps that finished their automated work but still need the operator to perform an out-of-band check (deploy observation, staging smoke, manual verification). Use it in `feature-acceptance` per its payload's verdict rules; do not map deferred actions to `COMPLETED`.

## §5.1 Step timing contract (load-bearing)

Every step record MUST honour these rules so `elapsedMin` reflects real wall-clock time:

1. `startedAt` is stamped at the FIRST jq mutation of the step (when the skill flips status to `RUNNING` or appends the seed step). Never write `startedAt` for the first time at completion.
2. `completedAt` is stamped at the LAST jq mutation of the step (when status flips to `COMPLETED` / `STOPPED` / `PAUSED_PENDING_OPERATOR` / `SKIPPED`).
3. `elapsedMin` is derived: `(completedAt - startedAt) / 60`. Skills MAY compute and write it themselves at final write; the orchestrator MUST back-fill it for any step where it is `0` despite `completedAt > startedAt`.
4. Multi-pass writes inside a single skill turn (e.g. seed at t0, patch findings at t0+5min) MUST bump `completedAt` on every subsequent mutation per §10's `completedAt` invariant.

Skills that write only on completion (`startedAt == completedAt`, `elapsedMin: 0`) hide real cost from retro-analysis and break the orchestrator's roll-up. Pre-existing skills that don't yet honour this rule are bugs to fix, not a precedent to mirror.

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

**Rule**: no skill uses `Read` on `workflow.json`. Only `Bash(browzer workflow *)` (or `Bash(jq *)` for read-only cross-step queries during the migration window).

## §10 Atomic write pattern

```bash
jq --arg id "$STEP_ID" \
   --argjson update '<payload>' \
   --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '(.steps[] | select(.stepId==$id)) |= (. + $update | .completedAt = $now)
    | .updatedAt = $now
    | .currentStepId = $id
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Four guarantees:
1. Filter by `stepId` prevents cross-index writes.
2. `.tmp + mv` on same FS is atomic (POSIX) — concurrent readers never see partial state.
3. Top-level fields (`updatedAt`, `currentStepId`, `completedSteps`) refreshed in same op.
4. **`completedAt` bump invariant** — every mutation that touches a payload key under `featureAcceptance.*`, `codeReview.*`, `updateDocs.*`, `commit.*`, `fixFindings.*`, or `task.execution.*` MUST also set the owning step's `.completedAt = $now` in the same atomic op. Without this rule, multi-pass writes that follow the initial step write leave `completedAt` stuck at the first-write timestamp, producing `elapsedMin: 0` even when the step actually ran for many minutes (the orchestrator's roll-up reads `completedAt - startedAt` and silently produces zeros otherwise).

   The same invariant applies to multi-pass writes within a single skill turn: if Phase 6 writes the step at T=t0 and Phase 7 patches `findings[]` at T=t0+5min, the second jq must also bump `completedAt` to t0+5min. Skills are free to compute `elapsedMin` themselves at final write (per `subagent-preamble.md` §"Optional: self-populate `.elapsedMin`"), but they cannot omit the `completedAt` bump.

## §11 allowed-tools cluster

Base cluster for any skill touching `workflow.json`:

```yaml
allowed-tools: Bash(browzer workflow *), Bash(browzer *), Bash(date *)
```

During the migration window, the legacy pair is also accepted:

```yaml
allowed-tools: Bash(jq *), Bash(mv *), Bash(date *), Bash(browzer *)
```

Additions by role:
- Review-candidate skills: `AskUserQuestion`
- Skills writing source code: `Read`, `Write`, `Edit`
- Skills dispatching specialist agents: `Agent`
- `code-review`: `Agent`, `AskUserQuestion`, `Bash(find *)`, `Bash(grep *)`
- `feature-acceptance`: `Agent`, `AskUserQuestion`, plus any gate runner

**Validator extension** (`scripts/validate-frontmatter.mjs`): any skill whose `description` or `SKILL.md` body mentions `workflow.json` MUST declare EITHER `Bash(browzer workflow *)` (canonical) OR the legacy pair `Bash(jq *)` + `Bash(mv *)` (accepted during migration window). Violations fail `pnpm turbo test`.

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
