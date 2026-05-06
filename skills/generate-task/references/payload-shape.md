# `taskPlan` and per-task `task` payloads — shape

Copy-paste-ready templates for `generate-task` outputs. Mirrors
`#TaskBrief` (in `#TasksManifest`) and `#TaskExecution` / `#TaskExplorer`
/ `#TaskExecutionResult` from the workflow CUE SSOT (`workflow-v1.cue`,
re-emitted as `references/workflow-schema.md`).

> **Authoritative schema reminder.** When a field name, enum value, or
> shape disagrees between this template and `references/workflow-schema.md`,
> the schema wins — this file is illustrative. Run
> `browzer workflow describe-step-type TASKS_MANIFEST` /
> `… describe-step-type TASK` for the live field spec.

## TASKS_MANIFEST step (top-level shape)

`#TasksManifest.tasks[]` is an OPTIONAL `[...#TaskBrief]` summary. Per-task
detail lives in the dedicated `TASK` steps; the manifest carries only
ordering + dependency-graph + parallelizable groups.

```jsonc
{
  "tasksManifest": {
    "totalTasks": 3,
    "tasksOrder": ["TASK_01", "TASK_02", "TASK_03"],
    "dependencyGraph": {
      "TASK_01": [],
      "TASK_02": ["TASK_01"],
      "TASK_03": ["TASK_01"]
    },
    "parallelizable": [["TASK_02", "TASK_03"]],
    "tasks": [
      {
        "taskId": "TASK_01",
        "title": "<one-sentence outcome>",
        "suggestedModel": "sonnet",
        "trivial": false,
        "skillsFound": ["<skill-id>"],
        "scope": ["<path>", "<path>"],
        "dependsOn": []
      }
    ]
  }
}
```

## Per-task TASK_NN step (`#TaskExecution` payload)

The TASK step's `task` field is a `#TaskExecution` struct. It carries
the canonical `#TaskExplorer` (Pass 1) and `#TaskReviewer` (Pass 2)
payloads, plus a final `#TaskExecutionResult` written by `execute-task`.

```jsonc
{
  "task": {
    "title": "<sentence>",
    "scope": ["<path>", "<path>"],
    "dependsOn": [],
    "invariants": [
      { "rule": "<machine-checkable invariant>", "source": "<test or audit script>" }
    ],
    "acceptanceCriteria": [
      { "id": "T-AC-1", "bindsTo": ["AC-3"], "description": "<copied from PRD AC>" }
    ],
    "suggestedModel": "sonnet",
    "trivial": false,
    "explorer": {
      "model": "haiku",
      "filesModified": ["<path>"],
      "filesToRead":   ["<path>"],
      "domains":       ["<free-form-string>"],
      "skillsFound": [
        { "domain": "<free-form-string>", "skill": "<skill-id>", "relevance": "high" }
      ]
    },
    "reviewer": {
      "model": "sonnet",
      "additionalContext": "",
      "skipTestsReason": null,
      "testSpecs": [
        { "testId": "T-1", "file": "<path>", "type": "green",
          "description": "<assertion>", "coverageTarget": "<AC-id or invariant>" }
      ]
    },
    "execution": {
      "gates": {
        "baseline":   { "lint": "pass", "typecheck": "passed in 12s", "tests": "pass" },
        "postChange": { "lint": "pass", "typecheck": "passed in 11s", "tests": "pass" },
        "regression": []
      },
      "files": {
        "created":  ["<path>"],
        "modified": ["<path>"],
        "deleted":  []
      },
      "scopeAdjustments": [],
      "agents": [
        { "role": "<domain>-specialist", "skill": "<skill-id>",
          "model": "sonnet", "status": "completed",
          "startedAt": "<RFC3339>", "completedAt": "<RFC3339>",
          "skillsLoaded": ["<skill-id>"], "notes": "<optional>" }
      ],
      "invariantsChecked": [
        { "rule": "<verbatim from task.invariants[].rule>", "source": "<...>",
          "status": "passed", "note": "<optional>" }
      ],
      "nextSteps": "<one paragraph; use \"; \" between bullets — see §JSON serialisation below>"
    }
  }
}
```

## Field-level common drift (audit before emitting)

The CUE validator rejects payloads that drift on these eight points.
Run through this checklist before every `append-step` / `patch`.

### 1. `taskId` regex — `^TASK_[0-9]{2}$`

Per `#TaskBrief.taskId` and `#TaskStep.taskId`. Slug suffixes
(`TASK_01_explorer`) are NOT accepted.

### 2. `task.invariants[]` and `execution.invariantsChecked[]` are arrays of structs

Bare strings are rejected. Use `{ rule, source }` for `invariants[]`
and `{ rule, source, status, note }` for `invariantsChecked[]`.

### 3. `task.explorer.skillsFound[]` is `[...#SkillFound]`, not `[...{skill, rationale}]`

`#SkillFound` is `{ domain: string, skill: string, relevance: "high" | "med" | "low" }`.
The fields are **`domain` + `skill` + `relevance`** (default `"med"`)
— not `{skill, rationale}`. Empty array (`[]`) is allowed when the
explorer found no matches; null is NOT.

`#TaskBrief.skillsFound[]` (the manifest's per-task summary), in
contrast, is `[...string]` — just a flat list of skill ids. Don't
confuse the two surfaces.

### 4. `task.explorer.domains` is `[...string]`

Free-form list of strings. Any taxonomy in `references/explorer-pass.md`
(`fastify-backend`, `nextjs-web`, etc.) is an authorial convention used
to assign domains, NOT a schema-enforced enum.

### 5. `gates.{baseline,postChange}` row enum

`#GateRow` is:

```cue
{
  lint?:      "pass" | "fail" | "skip"
  typecheck?: string  // free-form (e.g. "passed in 12s", "failed: 3 errors")
  tests?:     string  // free-form
  ...
}
```

Only `lint` is enum-bound. `typecheck` and `tests` accept free-form
strings — but `"pass" | "fail" | "skip"` is the documented convention
for binary outcomes. Reserve free-form text for additional context
(`"passed in 12s"`, `"3 of 47 tests skipped"`). Free-form values like
`"n/a (markdown-only)"` are accepted by the schema but `"skip"` is
preferred — explain in `nextSteps` instead.

The composite shape is `{ baseline: #GateRow, postChange: #GateRow,
regression: [...#RegressionRow] }` per `#TaskGates`. **There is no
`preChange` field** — the historical name was retired in schema v1.

### 6. `execution.files` (composite) vs split `filesModified`/`filesCreated`/`filesDeleted`

`#TaskExecutionResult` exposes BOTH a composite `files: #TaskFiles`
(`{created, modified, deleted}`) AND three optional flat arrays
(`filesModified`, `filesCreated`, `filesDeleted`). They are NOT a
union — both surfaces validate independently and a payload may
populate one, the other, or both.

The composite `files: { created, modified, deleted }` is the canonical
shape preferred by downstream skills (`code-review`, `update-docs`).
Use the flat arrays only when retro-fitting an older payload that
already split them. **Do NOT emit a `filesChanged: [...string]` field
— it is not part of the schema and the validator will reject it.**

### 7. `execution.nextSteps` is `*"" | string`, not `result: { summary, skillsInvoked }`

The execution result's free-form summary lives in `nextSteps: string`
(default `""`). There is no `result: { summary, skillsInvoked }`
sub-object. Skills invoked are recorded per-agent under
`execution.agents[].skill` (one entry per dispatched agent, with
its own `model` / `status` / `startedAt` / `completedAt` /
`skillsLoaded`). Roll the per-agent values into the step's top-level
`skillsInvoked` list via the canonical jq pattern:

```jq
.skillsInvoked = ([.task.execution.agents[]?.skill] | map(select(.)))
```

Do this in the same `patch` that writes `task.execution`, so the two
surfaces stay aligned.

### 8. `agents[].status` enum

`#TaskAgent.status` is `"pending" | "running" | "completed" | "failed"`.
Anything else (`"done"`, `"success"`, `"complete"`, `"in-progress"`)
is rejected. The canonical happy-path value is `"completed"`.

`agents[].model` is `*null | "haiku" | "sonnet" | "opus"`. Free-form
model strings (`"claude-sonnet-4-6"`) are rejected — pass the tier,
not the SKU.

## JSON serialisation — string fields with newlines

`jq -n` interprets `\n` inside double-quoted string literals as a
**literal newline byte**, not as the JSON escape `\\n`. The daemon's
JSON parser then rejects the resulting payload with
`json: error calling MarshalJSON for type json.RawMessage: invalid character '\n' in string literal`
because raw newlines inside a JSON string are not valid JSON.

Two safe patterns when emitting multi-line content:

```bash
# Preferred — collapse newlines to "; " (one-line, parser-safe).
OUTPUT_LINE=$(printf '%s' "$MULTI_LINE" | tr '\n' ';' | sed 's/;/; /g')

# When the literal newline must survive — escape the backslash so jq
# emits the JSON escape sequence, not a raw byte.
OUTPUT_LINE='line one\\nline two'
echo "$OUTPUT_LINE" | jq -n --arg s "$OUTPUT_LINE" '{ note: $s }'
```

The same advice applies to `--arg "key=value"` payloads when the value
crosses newlines: prefer single-line collapse, or write the bulky JSON
to a temp file and inline-read it via `--argjson "key=$(cat $FILE)"`
so the shell never has to escape the value at all. (`browzer workflow
patch` does NOT support a `--argjsonfile` flag — read the file in via
command substitution as shown.)

<!-- # samples-eval: skip — shell command substitution `$(cat …)` cannot be replayed by the test harness -->
```bash
PAYLOAD_FILE=$(mktemp -t step-payload.XXXXXX.json)
jq -n --arg msg "<one-line text>" '{ note: $msg }' > "$PAYLOAD_FILE"
browzer workflow patch \
  --argjson "patch=$(cat "$PAYLOAD_FILE")" \
  --jq '. + $patch'
rm -f "$PAYLOAD_FILE"
```

> **Cross-reference:** the `browzer workflow patch` cobra parser also
> requires single-token `--arg "name=value"` form (space-separated
> jq-native `--arg name value` is rejected). See the patch verb in
> `references/pipeline-phases.md` for the failure mode + recovery hint.

## Enum quick-reference (literal CUE values)

Use the literals BELOW verbatim — anything else is rejected by `cue vet`.

| Field | Literal values |
|---|---|
| `taskId` | regex `^TASK_[0-9]{2}$` (no slug suffixes) |
| `acceptanceCriteria[].id` | regex `^T-AC-[0-9]+$` |
| `acceptanceCriteria[].bindsTo[]` | regex `^AC-[0-9]+$` |
| `task.suggestedModel` | `"haiku"` \| `"sonnet"` \| `"opus"` (NOT model SKUs like `"claude-sonnet-4-6"`) |
| `task.explorer.model` | `"haiku"` \| `"sonnet"` \| `"opus"` (or null) |
| `task.explorer.skillsFound[]` | shape: `{ domain: string, skill: string, relevance }`. **NO `rationale`/`name`/`path` fields.** |
| `task.explorer.skillsFound[].relevance` | `"high"` \| `"med"` \| `"low"` (NOT `"medium"` — that's for `Finding.severity`). Default `"med"`. |
| `task.reviewer.model` | `"haiku"` \| `"sonnet"` \| `"opus"` (or null) |
| `task.reviewer.testSpecs[].testId` | regex `^T-[0-9]+$` |
| `task.reviewer.testSpecs[].type` | `"green"` (only literal accepted today) |
| `execution.gates.{baseline,postChange}.lint` | `"pass"` \| `"fail"` \| `"skip"` (typecheck/tests are free-form strings) |
| `execution.gates.regression[].result` | `"pass"` \| `"fail"` \| `"skip"` |
| `execution.agents[].model` | `"haiku"` \| `"sonnet"` \| `"opus"` (or null) |
| `execution.agents[].status` | `"pending"` \| `"running"` \| `"completed"` \| `"failed"` (NOT `"done"`/`"success"`/`"complete"`/`"in-progress"`) |
| `execution.invariantsChecked[].status` | `"passed"` \| `"failed"` (NOT `"pass"`/`"fail"`) |
| `execution.scopeAdjustments[].kind` | `"spec-relaxation"` \| `"scope-expansion"` \| `"scope-reduction"` \| `"no-op-refactor"` \| `"out-of-scope-fix"` \| `"deferred-to-followup"` |
| `task.additionalContext.changes[].kind` (if object form) | `"corrected"` \| `"added"` \| `"dropped"` |
| `warnings[].kind` | open string — field is named `kind`, NOT `level` |

## Debugging CUE shape failures

If `append-step` / `append-steps` / `patch` exits with `array-shape-mismatch: <field> expected array of objects with fields {…}` (CLI message class introduced PR 2 — see `../../generate-prd/references/payload-shape.md` §"Common drift" for canonical examples across step types), the field expects nested objects, not strings or scalars. Introspect the live shape via:

```bash
browzer workflow describe-step-type TASKS_MANIFEST --json --save /tmp/tasks-manifest-schema.json
browzer workflow describe-step-type TASK            --json --save /tmp/task-schema.json
```

The `--save` route keeps the 10–20 KB schema dump out of the chat — `jq '.fields[] | select(.name=="explorer")'` reads it back when you need a specific subtree (e.g. drilling into `task.explorer.skillsFound[]`).
