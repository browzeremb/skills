<!-- AUTO-GENERATED:sync-skill-templates START — DO NOT EDIT BY HAND -->

# Schema reference — `COMMIT`

Auto-generated from `packages/cli/schemas/workflow-v1.cue` via
`scripts/packages/cli/sync-skill-templates.mjs`. Do not edit by hand —
the lefthook pre-push gate regenerates this file when the CLI schema
or related Go sources change.

## Canonical scaffold

> **Note:** the scaffold below is the **BODY** for `save-step` (positional phase arg). Do NOT wrap it in `{ "name": "...", "applicability": "...", ... }`. Write only the inner payload object — `save-step` takes the phase name as a positional argument and locates the step in `workflow.json`.

CUE-validated example shape — emit a payload matching this contract
to `staging/<PHASE>.json` (or `.md` for PRD).

```json
{
  "conventionalType": "feat",
  "subject": ""
}
```

## Field reference

| Path | Required | Type | Regex/Enum | Description |
| --- | --- | --- | --- | --- |
| `backfillSha` |  | *null | =~"^[a-f0-9]{7,40}$" | `^[a-f0-9]{7,40}$` |  |
| `body` |  | string |  |  |
| `conventionalType` | ✓ | string | `build` \| `chore` \| `ci` \| `docs` \| `feat` \| `fix` \| `perf` \| `refactor` \| `revert` \| `style` \| `test` |  |
| `prePushAudits` |  | array |  |  |
| `prePushAuditsRun` |  | array |  |  |
| `prePushAuditsRun[]` | ✓ | string |  |  |
| `prePushAudits[].durationMs` |  | int |  |  |
| `prePushAudits[].exitCode` | ✓ | int |  |  |
| `prePushAudits[].name` | ✓ | string |  |  |
| `prePushAudits[].output` |  | string |  |  |
| `prePushAudits[].source` | ✓ | string | `husky` \| `lefthook` \| `operator` |  |
| `pushAttempts` |  | array |  |  |
| `pushAttempts[].amendUsed` |  | bool |  |  |
| `pushAttempts[].attemptedAt` | ✓ | string |  |  |
| `pushAttempts[].bypassReason` |  | *null | string |  |  |
| `pushAttempts[].bypassedAudits` |  | array |  |  |
| `pushAttempts[].bypassedAudits[]` | ✓ | string |  |  |
| `pushAttempts[].lefthookBypassed` |  | bool |  |  |
| `pushAttempts[].noVerifyPassed` |  | bool |  |  |
| `pushAttempts[].previousFailure` |  | *null | string |  |  |
| `pushAttempts[].retryCount` |  | int |  |  |
| `pushAttempts[].sha` | ✓ | string | `^[a-f0-9]{7,40}$` |  |
| `scope` |  | string |  |  |
| `sha` |  | string | `^[a-f0-9]{7,40}$` |  |
| `subject` | ✓ | string |  |  |
| `trailers` |  | array |  |  |
| `trailers[]` | ✓ | string |  |  |

<!-- AUTO-GENERATED:sync-skill-templates END -->
