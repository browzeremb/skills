# `brainstorming` step — payload shape

Copy-paste-ready template for the `brainstorming` payload on the
`BRAINSTORMING` step. Mirrors `#Brainstorming` in
`references/workflow-schema.md` — kept here so authors don't grep
the full schema for one shape.

```json
{
  "rounds": [
    {
      "round": 1,
      "question": "<one focused question, grounded in browzer explore/search>",
      "answer": "<operator's verbatim reply>",
      "askedAt": "<RFC3339>",
      "answeredAt": "<RFC3339>"
    }
  ],
  "outcome": "<one-paragraph synthesis: persona, success signal, scope edges>",
  "researchSpawned": false
}
```

## Required vs optional

- **Required**: `rounds` (≥1 entry), `outcome`.
- **Optional**: `researchSpawned` (default `false`).

## Common drift

- Payload key is `brainstorming` (with `-ing`), NOT `brainstorm`.
- `askedAt` / `answeredAt` are RFC3339 strings, not epoch ints.
- `outcome` is plain string, not a struct.

## Enum quick-reference (literal CUE values)

Use the literals BELOW verbatim — anything else is rejected by `cue vet`.

| Field | Literal values |
|---|---|
| `researchFindings[].confidence` | `"high"` \| `"med"` \| `"low"` (NOT `"medium"` — that's the `Finding.severity` form) |
| `warnings[].kind` | open string — field is named `kind`, NOT `level` |

> **Schema-level reminder.** The fields the CUE actually expects are
> `questionsAsked` (int), `researchRoundRun` (bool), `dimensions`
> (#BrainstormDimensions), `researchFindings`, `assumptions`,
> `openRisks`, `decision` — see `references/workflow-schema.md`
> §`#Brainstorming` for the full per-field spec. The skeleton above
> is a minimal narrative form; the canonical structured shape lives
> in the schema reference.

## Append-step skeleton

```bash
PAYLOAD=$(cat <<'EOF'
{ "stepId": "$STEP_ID", "name": "BRAINSTORMING", "status": "RUNNING",
  "applicability": { "applicable": true, "reason": "vague request" },
  "startedAt": "$NOW", "retryCount": 0,
  "skillsToInvoke": ["brainstorming"], "skillsInvoked": ["brainstorming"],
  "owner": null, "worktrees": { "used": false, "worktrees": [] },
  "warnings": [], "reviewHistory": [],
  "brainstorming": { "rounds": [], "outcome": "", "researchSpawned": false } }
EOF
)
echo "$PAYLOAD" | browzer workflow append-step --await --workflow "$WORKFLOW"
```
