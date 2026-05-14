# AC ↔ FR binding — authoring guide

ACs are the load-bearing contract between `generate-prd` and the downstream pipeline. `generate-task` derives `TASK_NN.acceptanceCriteria[].bindsTo` directly from PRD ACs. `feature-acceptance` executes ACs as the final gate. If ACs are sloppy, tests skip what should be covered and acceptance passes features that aren't actually done.

## Three invariants

1. **Every AC binds ≥1 FR.** An AC with empty `bindsTo` is orphaned — it doesn't prove any requirement.
2. **Every FR is bound by ≥1 AC.** An FR with no AC is code without a test.
3. **AC text is testable.** Not aspirational ("should be fast"), not implementation ("clicks the button"). State a verifiable outcome.

## Phrase ACs as Given/When/Then

Template:

> Given `<preconditions>`, when `<action>`, then `<observable outcome>`.

Examples:

> Given a logged-in user, when they POST `/api/search` with valid params, then they receive 200 with a JSON payload conforming to schema `<X>`.

> Given the browzer index is fresh, when the operator runs `browzer explore "..." --limit 3 --json`, then stdout JSON has at most 3 entries in the result array.

The Given/When/Then structure forces the AC to name:
- A precondition (sets up the system state)
- A trigger (the operator/system action)
- An observable result (what a test can assert)

Skip any of the three and the AC becomes hand-wavy.

## Anti-patterns

| Bad AC | Why | Fix |
|---|---|---|
| "Users can log in" | Restates the FR; not testable as written | Given/when/then on the login flow's observable result |
| "The system should be performant" | Vague; NFR territory, not AC | Move to NFR with measurable target |
| "User clicks the green button" | Implementation, not outcome | "user is authenticated" — keep UI-agnostic |
| "Tests pass" | Tautological | Name the behavior the test proves |
| "Error handling works" | Unverifiable in the abstract | "When the upstream API returns 503, the request fails with `503` and the message is logged at WARN" |

## One AC, multiple FRs?

Allowed but rare. Use when a single observable outcome proves multiple requirements (e.g., one AC covers both FR-01 "endpoint exists" and FR-02 "endpoint returns correct shape"). Don't force it — separate ACs are usually clearer.

## How `generate-task` consumes ACs

The downstream `generate-task` skill:

1. Groups tasks by FR (sometimes by AC cluster when multiple FRs share scope)
2. Copies `AC-NN.bindsTo` into `TASK_NN.acceptanceCriteria[].bindsTo` so the task knows which FRs it must prove
3. Uses AC text as Explorer query input (`browzer explore "<noun from AC>"`) to find the files that touch each AC

ACs with vague text degrade the Explorer pass: queries get noisy hits, tasks get misrouted scope. Specific ACs produce focused queries.

## How `feature-acceptance` consumes ACs

`feature-acceptance` enumerates every AC and verifies it against the implemented feature. ACs phrased imperatively ("the system must X") force the gate to interpret intent. ACs phrased as Given/When/Then are directly runnable as test scenarios.

When `runnable: true` lives on an NFR (not AC), `feature-acceptance` executes the NFR `target` as a shell command. ACs themselves are not currently auto-runnable.

## Sanity check before writing the PRD body

Before declaring the PRD done, scan the frontmatter:

- For each `functionalRequirements[]` entry: does ≥1 `acceptanceCriteria[]` have this FR in `bindsTo`?
- For each `acceptanceCriteria[]` entry: does `bindsTo` reference only IDs that exist in `functionalRequirements[]`?

If either check fails, fix before writing the PRD body. The skill does not validate this automatically — discipline lives here.
