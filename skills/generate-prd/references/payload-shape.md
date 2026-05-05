# `prd` step — payload shape

Copy-paste-ready template for the `prd` payload on the `PRD` step.
Mirrors `#PRD` in `references/workflow-schema.md`.

```json
{
  "personas": ["<persona-1>", "<persona-2>"],
  "userJourneys": ["<short journey 1>", "<short journey 2>"],
  "functionalRequirements": [
    { "id": "FR-1", "text": "<requirement>", "priority": "must|should|could" }
  ],
  "nonFunctionalRequirements": [
    { "id": "NFR-1", "text": "<requirement>", "priority": "must|should|could", "metric": "<measurable>" }
  ],
  "acceptanceCriteria": [
    { "id": "AC-1", "text": "<criterion>", "bindsTo": ["FR-1"], "verifyBy": "test|inspect|metric" }
  ],
  "successMetrics": [
    { "id": "M-1", "name": "<metric>", "target": "<value+unit>", "rationale": "<why>" }
  ],
  "dependencies": { "internal": [], "external": [] },
  "outOfScope": ["<explicit non-goal 1>"]
}
```

## Required vs optional

- **Required**: `personas`, `acceptanceCriteria`, `successMetrics`.
- **Optional but recommended**: `userJourneys`, `functionalRequirements`,
  `nonFunctionalRequirements`, `dependencies`, `outOfScope`.

## Common drift

- `acceptanceCriteria[].bindsTo` ONLY accepts `^FR-[0-9]+$` IDs. NFR
  IDs are rejected by CUE — link NFRs in `acceptanceCriteria[].text`
  prose, not in `bindsTo`.
- `id` patterns are strict: `FR-N`, `NFR-N`, `AC-N`, `M-N` (no
  lane prefixes).
- `successMetrics[].target` is a string (e.g. `"<200ms p95"`), not
  a number.

## Enum quick-reference (literal CUE values)

Use the literals BELOW verbatim — anything else is rejected by `cue vet`.

| Field | Literal values |
|---|---|
| `personas[].id` | regex `^P-[0-9]+$` |
| `functionalRequirements[].id` | regex `^FR-[0-9]+$` |
| `functionalRequirements[].priority` | `"must"` \| `"should"` \| `"could"` |
| `nonFunctionalRequirements[].id` | regex `^NFR-[0-9]+$` |
| `acceptanceCriteria[].id` | regex `^AC-[0-9]+$` |
| `acceptanceCriteria[].bindsTo[]` | regex `^FR-[0-9]+$` (FR ids ONLY — NFR ids are rejected) |
| `successMetrics[].id` | regex `^M-[0-9]+$` |
| `risks[].id` | regex `^R-[0-9]+$` |
| `warnings[].kind` | open string — field is named `kind`, NOT `level` |
