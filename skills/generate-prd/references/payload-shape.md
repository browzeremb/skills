# `prd` step — payload shape

Copy-paste-ready template for the `prd` payload on the `PRD` step.
Mirrors `#PRD` in `packages/cli/schemas/workflow-v1.cue` (the SSOT).

> **Source-of-truth check**: when this template drifts from the CUE
> schema, regenerate the field list with
> `browzer workflow describe-step-type PRD --json --workflow "$WORKFLOW"`.
> Any field NOT on that list is rejected by the post-mutation
> validator — never invent fields.

```json
{
  "title": "<short feature title>",
  "overview": "<one-paragraph problem statement>",
  "personas": [
    { "id": "P-1", "description": "<who they are + what they want>" }
  ],
  "objectives": ["<measurable outcome 1>", "<measurable outcome 2>"],
  "inScope": ["<concrete deliverable 1>"],
  "outOfScope": ["<explicit non-goal 1>"],
  "deliverables": ["<artefact 1>"],
  "functionalRequirements": [
    { "id": "FR-1", "text": "<requirement>", "priority": "must" }
  ],
  "nonFunctionalRequirements": [
    { "id": "NFR-1", "category": "performance", "target": "<measurable target, e.g. p95 < 200ms>" }
  ],
  "successMetrics": [
    { "id": "M-1", "metric": "<what is measured>", "target": "<value+unit, e.g. \"<200ms p95\">", "method": "<how it is measured>" }
  ],
  "acceptanceCriteria": [
    { "id": "AC-1", "text": "<criterion>", "bindsTo": ["FR-1"] }
  ],
  "risks": [
    { "id": "R-1", "text": "<risk>", "mitigation": "<how it's mitigated>" }
  ],
  "dependencies": { "internal": [], "external": [] },
  "assumptions": ["<assumption 1>"],
  "taskGranularity": "one-task-one-commit"
}
```

## Required vs optional (per CUE SSOT)

The CUE schema uses `*[] | [...#X]` — the field accepts a default
empty list OR a list of `#X` objects. Functionally:

- **Always required** (no default — must be present): `title`,
  `functionalRequirements`, `acceptanceCriteria`.
- **Has empty-list default** (omit to accept `[]`): `personas`,
  `objectives`, `inScope`, `outOfScope`, `deliverables`,
  `nonFunctionalRequirements`, `successMetrics`, `risks`,
  `assumptions`. Always populate them in production PRDs — empty is
  legal but unhelpful.
- **Has empty-string default**: `overview`, `taskGranularity`.
- **Optional struct**: `dependencies` (omit entirely if none).

## Element shape — every nested type

Every array field above carries a strict element shape (CUE
definition). Confirm the live shape via
`browzer workflow describe-step-type PRD --json` if in doubt — it
walks the SSOT recursively.

| Array | Element shape (`#X`) | Required keys | Optional keys |
|---|---|---|---|
| `personas[]` | `#Persona` | `id` (regex `^P-[0-9]+$`), `description` | — |
| `functionalRequirements[]` | `#FR` | `id` (regex `^FR-[0-9]+$`) | `text`, `description`, `priority` (`"must"` \| `"should"` \| `"could"`) |
| `nonFunctionalRequirements[]` | `#NFR` | `id` (regex `^NFR-[0-9]+$`), `target` | `text`, `description`, `category` |
| `successMetrics[]` | `#SuccessMetric` | `id` (regex `^M-[0-9]+$`), `metric`, `target`, `method` | — |
| `acceptanceCriteria[]` | `#AC` | `id` (regex `^AC-[0-9]+$`) | `text`, `description`, `bindsTo[]` (each `^FR-[0-9]+$`) |
| `risks[]` | `#Risk` | `id` (regex `^R-[0-9]+$`), `mitigation` | `text`, `description` |

`dependencies` is `#PRDDependencies = { external?: [...string], internal?: [...string] }`
— a struct with two optional string-array fields.

## Common drift (real failures from past sessions)

- **`personas[]` is NOT an array of strings.** It's an array of
  `{id, description}` objects. Validator emits
  `array-shape-mismatch: expected array of objects with fields {id, description}`.
- **`successMetrics[]` is NOT an array of strings, NOT
  `{name, rationale}`.** It's `{id, metric, target, method}`. The
  field is `metric` (what is measured), NOT `name`.
- **`risks[]` requires `mitigation`, NOT `severity`.** A risk
  without `mitigation` fails CUE.
- **`nonFunctionalRequirements[]` requires `target`** (the
  measurable threshold). `text`/`description`/`category` alone are
  insufficient — `target` is mandatory per `#NFR`.
- **`acceptanceCriteria[].bindsTo` ONLY accepts `^FR-[0-9]+$`
  IDs** — NFR / M / R / AC ids are rejected by CUE. Link non-FR
  references inside `text`/`description` prose, not in `bindsTo`.
- **No `userJourneys` field exists** in `#PRD`. Embed user
  journeys inside `overview` prose or `objectives[]`.
- **No `acceptanceCriteria[].verifyBy` field exists.** The
  verification method goes in `successMetrics[].method`, not on the
  AC itself.
- **`successMetrics[].target` is a string** (e.g.
  `"<200ms p95"`), NOT a number.
- **`taskGranularity` is a free string** (no enum). Convention:
  `"one-task-one-commit"` (default) or `"grouped-by-layer"`.

## Enum quick-reference (literal CUE values)

Use the literals BELOW verbatim — anything else is rejected.

| Field | Literal values |
|---|---|
| `personas[].id` | regex `^P-[0-9]+$` |
| `functionalRequirements[].id` | regex `^FR-[0-9]+$` |
| `functionalRequirements[].priority` | `"must"` \| `"should"` \| `"could"` |
| `nonFunctionalRequirements[].id` | regex `^NFR-[0-9]+$` |
| `acceptanceCriteria[].id` | regex `^AC-[0-9]+$` |
| `acceptanceCriteria[].bindsTo[]` | regex `^FR-[0-9]+$` (FR ids ONLY) |
| `successMetrics[].id` | regex `^M-[0-9]+$` |
| `risks[].id` | regex `^R-[0-9]+$` |
