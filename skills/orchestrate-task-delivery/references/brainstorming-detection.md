# brainstorming-detection — Step 0 heuristic

The orchestrator decides BEFORE any `workflow.json` mutation whether the operator's input is saturated enough to produce a useful PRD. This decision lives in the orchestrator (not in `generate-prd`), because:

1. The detection result drives whether the orchestrator dispatches `brainstorming` BEFORE `generate-prd` — the call site needs to know.
2. Routing inside `generate-prd` (the prior design) hid the decision and forced `generate-prd` to re-enter itself, which made the call graph hard to trace and impossible to skip in mid-flow entries.

## The signal set

Score the operator's verbatim request against these dimensions. Each present dimension gives a +1 saturation point.

| Dimension | What counts as present |
|-----------|------------------------|
| Persona | A specific user / role / customer named (`for premium users`, `for the on-call engineer`, `the accounting team`, `external API consumers`). Generic mentions like "users" or "people" do NOT count. |
| Success signal | A measurable outcome (`reduce p95 latency to <300ms`, `cut error rate by 50%`, `pass all 12 acceptance tests`, `users can complete checkout in <3 clicks`). |
| Concrete scope | A real path / module / endpoint / package name (`apps/<service>`, `POST /v1/<route>`, `<package>/<file>.ts`). Generic capability names like "the API" or "the dashboard" do NOT count. |
| File / endpoint / bug ref | A direct anchor into the codebase: file path with extension, endpoint route, error message, log line, issue number. |

## Vague triggers (negative signals)

The presence of ANY of these phrases adds 1 ambiguity point:

- "what if we…", "could we…", "would it be cool if…"
- "we need to add…", "we should…", "I think we…"
- "I'm thinking about…", "I'm wondering if…", "talvez", "acho que poderia"
- "let's explore", "let's brainstorm" (explicit invitation)
- Single-noun capability names with no verb: "webhooks", "billing", "auth"

## Decision rule

Compute `saturation = sum(present dimensions)` (0–4) and `ambiguity = sum(vague triggers present)` (0–N).

```
BRAINSTORMING_NEEDED = (saturation < 2) OR (ambiguity >= 1) OR (word_count < 25 AND saturation < 3)
```

Edge cases:

- Mid-flow entry (`execute TASK_03`, `update the docs`, `commit`) → `BRAINSTORMING_NEEDED=no` regardless. The operator is naming a specific phase; brainstorming would be redundant.
- Explicit invocation arg `skip-brainstorming` → `BRAINSTORMING_NEEDED=no`.
- Explicit invocation arg `force-brainstorming` → `BRAINSTORMING_NEEDED=yes`.
- Operator request includes a path to a PRD-shaped document (`docs/<somewhere>.md` with `## Personas` / `## Success metrics`) → `BRAINSTORMING_NEEDED=no`.

## Worked examples

| Request | Persona | Success | Scope | File ref | Vague | Decision |
|---------|---------|---------|-------|---------|-------|----------|
| "add a webhooks endpoint to apps/api so external consumers get order events with <500ms delivery latency" | ✓ external consumers | ✓ <500ms | ✓ apps/api | (route TBD) | none | NO |
| "what if we added webhooks to the API?" | ✗ | ✗ | ✗ | ✗ | "what if" | YES |
| "we need to add billing" | ✗ | ✗ | ✗ | ✗ | "we need" | YES |
| "fix the bug in src/auth/session.ts:142 where session.expiresAt is null after refresh" | ✗ | (implicit fix) | ✓ src/auth/session.ts | ✓ line 142 | none | NO (saturation 2 + concrete file ref) |
| "make the dashboard faster" | ✗ | ✗ ("faster" is not measurable) | ✗ ("the dashboard" generic) | ✗ | none | YES |

## Persisting the decision

Step 0 does NOT write to `workflow.json` (it does not exist yet). Carry the decision as a shell binding:

```bash
BRAINSTORMING_NEEDED="yes"  # or "no"
```

If `yes`, the orchestrator dispatches `brainstorming` in Step 2 (after Step 1's `init`). If `no`, Step 2 is a no-op and the loop continues directly to Step 3.

## Why this lives in the orchestrator (not in generate-prd)

Two reasons:

1. **Brainstorming runs BEFORE config setup.** If the input is vague, asking the operator to pick `mode` and `testExecutionDepth` is premature — the brainstorming session may surface scope changes that affect those answers. Detection in `generate-prd` (the prior design) put brainstorming AFTER config, in the wrong order.
2. **Mid-flow entry needs a clear skip path.** "execute TASK_03" should never trigger brainstorming, period. Putting the heuristic at the top of the orchestrator makes the skip a single conditional. Putting it inside `generate-prd` required `generate-prd` to know whether the orchestrator was calling it from Phase 1 or from a mid-flow re-entry — leaky abstraction.
