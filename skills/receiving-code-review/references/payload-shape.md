# `receivingCodeReview` step — payload shape

Copy-paste-ready template for the `receivingCodeReview` payload on
the `RECEIVING_CODE_REVIEW` step. Mirrors `#ReceivingCodeReview` and
`#ReceivingDispatch` in `references/workflow-schema.md`.

```json
{
  "iteration": 1,
  "summary": { "total": 0, "fixed": 0, "unrecovered": 0 },
  "dispatches": [
    {
      "findingId": "F-1",
      "iteration": 1,
      "reason": "initial",
      "role": "fix-agent",
      "skill": "<skill-id from finding.assignedSkill>",
      "model": "sonnet|opus",
      "status": "fixed|failed|skipped",
      "startedAt": "<RFC3339>",
      "completedAt": "<RFC3339>"
    }
  ],
  "notes": ""
}
```

## Required vs optional

- **Required**: `iteration` (≥1), `summary` (with all 3 sub-keys),
  `dispatches`.
- **Optional**: `notes`.

## Common drift

- `summary` is REQUIRED at append-step time. Seed with `{ total: 0,
  fixed: 0, unrecovered: 0 }` and increment as fix-agents report.
  Omitting it fails CUE validation on the first mutation.
- Dispatch shape uses `findingId`, NOT `dispatchId` or `agentId`.
  Every dispatch carries: `findingId`, `iteration`, `reason`,
  `role`, `skill`, `model`, `status`, `startedAt`, `completedAt`.
- `findingId` regex is `^F-[0-9]+$`. One ID per dispatch. Range
  notation (e.g. dash-separated start/end pairs) is invalid — emit N
  separate dispatch entries when one fix-agent multiplexed many
  findings, each carrying its own concrete `F-NN` id.
- `iteration` is the per-finding retry counter (1..7 per the
  ladder), not a global step counter.

## Enum quick-reference (literal CUE values)

Use the literals BELOW verbatim — anything else is rejected by `cue vet`.

| Field | Literal values |
|---|---|
| `dispatches[].findingId` | regex `^F-[0-9]+$` — **ONE id per dispatch** (not a comma-list, not a range). For a batch update across many findings, call `browzer workflow set-finding-statuses --batch '<json-array>'` instead of dispatching N times. |
| `dispatches[].reason` | `"initial"` \| `"retry"` \| `"research-then-sonnet"` \| `"research-then-opus"` \| `"staging-regression"` \| `"post-deploy"` \| `"operator-feedback"` |
| `dispatches[].model` | `"sonnet"` \| `"opus"` |
| `dispatches[].status` | `"fixed"` \| `"failed"` \| `"skipped"` (NOT `"completed"`/`"truncated"`) |
| `unrecovered[].severity` | `"high"` \| `"medium"` \| `"low"` |
| `warnings[].kind` | open string — field is named `kind`, NOT `level` |

## Debugging CUE shape failures

If `append-step` / `patch` / `append-dispatch` exits with `array-shape-mismatch: <field> expected array of objects with fields {…}` (CLI message class introduced PR 2 — see `../../generate-prd/references/payload-shape.md` §"Common drift" for canonical examples across step types), the field expects nested objects, not strings or scalars. Introspect the live shape via:

```bash
browzer workflow describe-step-type RECEIVING_CODE_REVIEW --json --save /tmp/receiving-cr-schema.json
```

The `--save` route keeps the schema dump out of the chat — `jq '.fields[] | select(.name=="dispatches")'` reads it back when you need a specific subtree.
