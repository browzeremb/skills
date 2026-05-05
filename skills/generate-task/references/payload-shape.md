# `taskPlan` and per-task `task` payloads — shape

Copy-paste-ready templates for `generate-task` outputs. Mirrors
`#TaskPlan` and `#Task` in `references/workflow-schema.md`.

## TASK_PLAN step

```json
{
  "tasks": [
    {
      "taskId": "TASK_01_<SLUG>",
      "intent": "<one-sentence what + why>",
      "scope": ["packages/foo/src/bar.ts", "packages/foo/src/__tests__/bar.test.ts"],
      "explorer": {
        "filesProbed": ["..."],
        "skillsFound": [{ "skill": "<skill-id>", "rationale": "<why>" }],
        "domain": "infra-build|api|data|frontend|other"
      },
      "trivial": false,
      "invariants": [
        { "rule": "<machine-checkable invariant>", "source": "<test or audit script>" }
      ]
    }
  ]
}
```

## Per-task TASK_NN step

```json
{
  "task": {
    "taskId": "TASK_01_<SLUG>",
    "intent": "<sentence>",
    "scope": ["..."],
    "explorer": { /* as above */ },
    "trivial": false,
    "invariants": [ /* as above */ ]
  },
  "execution": {
    "filesChanged": ["..."],
    "scopeAdjustments": [],
    "gates": {
      "preChange":  { "lint": "pass", "typecheck": "pass", "test": "pass" },
      "postChange": { "lint": "pass", "typecheck": "pass", "test": "pass" }
    },
    "invariantsChecked": [
      { "rule": "<verbatim from task.invariants[].rule>", "source": "<...>", "status": "pass|fail|skip", "note": "<optional>" }
    ],
    "result": { "summary": "<one paragraph>", "skillsInvoked": ["<skill>"] }
  }
}
```

## Common drift

- `task.invariants[]` and `execution.invariantsChecked[]` are
  **arrays of structs**, not arrays of plain strings. CUE rejects
  bare strings.
- `gates.{preChange,postChange}.lint` is the enum `"pass" | "fail"
  | "skip"`. Free-form values like `"n/a (markdown-only)"` get
  rejected — use `"skip"` and explain in `result.summary`.
- `taskId` regex is `^TASK_[0-9]{2}_[A-Z0-9_]+$`.
- Domain enum is `infra-build | api | data | frontend | other` —
  no aliases.
