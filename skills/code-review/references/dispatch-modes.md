# dispatch-modes — parallel-with-consolidator vs agent-teams

## Mode selection

| Flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Available modes                      |
| ------------------------------------------- | ------------------------------------ |
| `"1"`                                       | Both modes; Prompt 1 fires           |
| unset / any other value                     | `parallel-with-consolidator` only; Prompt 1 skipped |

---

## parallel-with-consolidator

Default dispatch. N agents run in parallel, one consolidator merges findings.

### Consolidator: in-line is the default for small + medium scopes

For `SCOPE_TIER ∈ {small, medium}`, the consolidator's job (cross-lane dedup, severity normalisation,
contract-violation audit, `severityCounts` derivation) is mechanical jq-merge work. Dispatching a
separate sonnet agent costs ~30k tokens + ~120s wall-clock for output the orchestrator can compute
inline in seconds. **Default to in-line consolidation** for these tiers; reserve a dispatched
consolidator agent for `large` only, where qualitative synthesis (theme extraction, blast-radius
narrative, conflict resolution) earns its cost.

Record the choice on every run:

```jsonc
"consolidator": { "mode": "in-line" | "dispatched-agent", "reason": "string" }
```

Acceptable reasons: `"scope tier ≤ medium → mechanical merge"`, `"scope tier large → qualitative synthesis"`,
or an explicit operator override.

### Dispatch steps

1. Baseline captured in Phase 1 (reused or fresh-run per code-review Phase 1).
2. **Pre-compute the per-agent context bundle** (one-shot before dispatch):

   ```bash
   for F in $CHANGED; do
     SLUG=$(echo "$F" | tr '/' '_')
     browzer deps "$F"           --json --save "/tmp/cr-deps-$SLUG.json"
     browzer deps "$F" --reverse --json --save "/tmp/cr-rdeps-$SLUG.json"
     browzer mentions "$F"       --json --save "/tmp/cr-mentions-$SLUG.json"
   done
   ```

   Reference these paths in each agent's prompt — do NOT inline the JSON. Agents read what they
   need. Agents do not re-run `browzer deps` for files in `CHANGED` (they may run `browzer explore`
   for prior-art lookups).

3. Dispatch N agents in ONE response turn — N `Agent(...)` tool uses. Cap each reviewer at 10
   findings. Paste `references/subagent-preamble.md` §Step 0-5 verbatim into each prompt, then:

   ```
   Role: <role name>.
   Scope: <file slice assigned to this role>.
   Invariants: <PRD NFRs + task invariants relevant to this role>.

   Context bundle (read before reviewing):
     - Diff:                git diff $BASE_REF...HEAD -- <scope files>
     - Forward deps:        /tmp/cr-deps-<slug>.json (one per changed file)
     - Reverse deps (blast): /tmp/cr-rdeps-<slug>.json (one per changed file)
     - Mentions (docs/entities): /tmp/cr-mentions-<slug>.json (one per changed file)
     - Prior-art lookup:    you MAY run `browzer explore "<symbol/behaviour>"`

   Stay in your lane: own only <category-from-ownership-table>. Cross-lane noise
   lowers consensus score and burns tokens.

   Contract: return findings as JSON matching
     { id, domain, severity, category, file, line, description,
       suggestedFix, assignedSkill, status: "open" }
   Also include top-level `skillsLoaded: ["<path>", ...]`.
   Do NOT alter any code or test file.
   ```

4. Each agent's FIRST tool call MUST be `Skill(<top recommendedMembers[].skill for this lane>)`.
   Reviewing without loading the lane skill is a contract violation; the consolidator drops findings
   from agents whose `skillsLoaded[]` is empty.

5. **Consolidator pass:**
   - **Small/medium (in-line)** — merge findings inline: dedupe, normalise severity, resolve
     conflicts, set `crossLaneOverlap: true`, write `codeReview.findings[]` directly via jq + mv.
   - **Large (dispatched)** — one sonnet `Agent` AFTER all role agents return. Same merge, plus
     qualitative synthesis paragraph: dominant themes, highest-leverage fix order, cross-cutting risks.
   - Enforce Step-0 contract: `skillsLoaded[]` non-empty when lane listed at least one skill. On
     violation: drop findings, add `contractViolations[]`, re-dispatch once. If still violated,
     surface and proceed.

6. Always populate `severityCounts` before writing the step:

   ```bash
   SEVERITY_COUNTS=$(jq '
     [.findings[].severity] | group_by(.)
     | map({key: .[0], value: length}) | from_entries
     | { high: (.high // 0), medium: (.medium // 0), low: (.low // 0) }
   ' <<< "$CODE_REVIEW_PAYLOAD")
   ```

---

## agent-teams (when `dispatchMode: "agent-teams"`)

Uses Claude Code's Agent Teams feature — a team lead + N teammates with shared context, task list,
and direct messaging. Teammates round-table, challenge each other, and converge through dialogue.

**Do not implement this branch by spawning N parallel `Agent(...)` calls + a consolidator** — that
is the parallel branch. Operator intent is the contract.

### Setup and dispatch

1. **Pre-flight (mandatory)** — confirm Agent Teams is usable:
   - `claude --version` ≥ `2.1.32`
   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` resolves at runtime
   - If either check fails, follow the degrade contract below.

2. **Spawn the team in ONE turn.** Template:

   ```text
   Create an agent team to review this feature. The team lead is me. Spawn
   <N> teammates with these roles (use subagent definitions where named):
     - senior-engineer    (Stay in lane: cyclomatic / DRY / clean code / style)
     - software-architect (Stay in lane: race conditions / clean architecture / caching / performance)
     - qa                 (Stay in lane: edge cases / butterfly-effect / regression review)
     - regression-tester  (Stay in lane: run scoped tests over modified files + reverse-deps; do NOT alter tests)
     - <each recommended member>

   Each teammate's spawn prompt: subagent preamble §Step 0-5 + lane-specific skill list +
   round-table contract. Require plan approval before any teammate reads the diff. After initial
   findings, every teammate MUST send at least one challenge or confirmation to a peer in an
   adjacent lane. Lead synthesizes from converged dialogue, NOT initial reports.
   No teammate may write to workflow.json directly.
   ```

3. **Drive convergence.** Monitor the shared task list. If two teammates flag the same lane, the
   lead messages the off-lane teammate to drop the cross-lane finding. If a teammate goes idle
   without posting a peer-challenge, nudge via direct message.

4. **Synthesize.** AFTER all teammates post at least one peer message AND dialogue reaches a
   stable round, apply the category-ownership table to produce `codeReview.findings[]`. Record:

   ```jsonc
   "agentTeam": {
     "teamId": "<id>",
     "teammates": [{ "name": "senior-engineer", "model": "sonnet", "lane": "..." }, ...],
     "roundTrips": <int>,      // teammate-to-teammate messages; 0 = contract violation
     "convergedAt": "<ISO>",
     "planApprovals": [{ "teammate": "qa", "approved": true, "at": "<ISO>" }]
   }
   ```

   `roundTrips: 0` → `contractViolations[]: { mode: "agent-teams", reason: "no round-table dialogue observed" }` → stop at `STOPPED`.

5. **Clean up the team** after synthesis write succeeds. Record `agentTeam.cleanedUpAt: "<ISO>"`.

### Degrade contract

The **only** acceptable trigger for downgrading to `parallel-with-consolidator` is Agent Teams
runtime being UNREACHABLE (version too old, env var unresolved, hard spawn error).

**Cost-saving heuristics are NOT a valid trigger.** If the runtime believes parallel would be cheaper,
it MUST prompt the operator BEFORE downgrading:

```
AskUserQuestion:
  agent-teams selected, but for this scope (<files> files, <lines> lines)
  parallel-with-consolidator is estimated <X>k tokens cheaper. Proceed
  with agent-teams or downgrade?
    (a) keep agent-teams      (b) downgrade to parallel
```

When runtime IS unreachable:
- Tell the operator: `agent-teams unavailable — degrading to parallel-with-consolidator`
- Record `dispatchMode: "agent-teams-degraded-to-parallel"` (NOT plain `parallel-with-consolidator`)
- Set `degrade: { from: "agent-teams", reason: "<specific cause: version | env-var | spawn-error>", at: "<ISO>" }` under `codeReview`
