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
      "status": "completed|failed|truncated",
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
