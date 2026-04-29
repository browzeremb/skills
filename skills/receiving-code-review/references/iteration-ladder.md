# Iteration ladder — receiving-code-review Phase 3 + 4 + 5

## Phase 3 — Model selection (severity-proportional, haiku forbidden)

| Severity | Default model | Rationale |
|---|---|---|
| high | sonnet | reasoning + diff fluency |
| medium | sonnet | sonnet handles most medium fixes cleanly |
| low | sonnet | haiku forbidden — even cosmetic fixes regress on subtle invariants |

`haiku` is not allowed for fix dispatch under any condition. The code-review retros showed haiku missing tenant-scoping invariants on "obvious" cosmetic finds; the cost of the regression dwarfs the haiku savings.

### Escalation ladder (consecutive failures of the SAME finding)

| Failure count | Next dispatch |
|---|---|
| 1 | `sonnet` (initial) |
| 2 | `sonnet` (retry; agent often needs the failure trace it didn't have on attempt 1) |
| 3 | **research-then-sonnet** — dispatch a research agent (WebFetch + WebSearch + browzer search) to gather library/pattern docs, then re-dispatch the fix on `sonnet` with the research bundle |
| 4 | `opus` |
| 5 | `opus` (retry with failure trace from #4) |
| 6 | **research-then-opus** — second research pass, then re-dispatch on `opus` |
| 7 | **STOP**: log unrecovered finding under workflow.json + technical-debt doc (Phase 5); continue remaining findings; emit non-fatal warning |

The 7th failure does NOT abort the whole skill.

---

## Phase 4 — Fix-agent prompt template

Paste `references/subagent-preamble.md` §Step 0–5 verbatim, then append:

```
Role: <F.domain>-fix-agent.
Skill to invoke (BLOCKING — preamble Step 0): <F.assignedSkill>.
Iteration: <iteration> of 7.

Upstream code-review summary (read-only context — do NOT re-litigate findings):
<$CODE_REVIEW_SUMMARY>

Finding to close:
  id:           <F.id>
  severity:     <F.severity>
  category:     <F.category>
  file:         <F.file>
  line:         <F.line>
  description:  <F.description>
  suggestedFix: <F.suggestedFix>

Context bundle (read what you need before editing):
  - Forward deps:         /tmp/cr-deps-<slug>.json
  - Reverse deps (blast): /tmp/cr-rdeps-<slug>.json
  - Mentions (docs/entities): /tmp/cr-mentions-<slug>.json
  - Prior failure traces: <list iteration-level traces if iteration > 1>
  - Research bundle:      <path if research pass was triggered this iteration>

Scope: <F.file> ONLY (plus integration glue ≤15 lines elsewhere if absolutely required —
see preamble §Step 3 exception).

Contract:
  1. Read the file, then read the relevant deps/mentions before editing.
  2. Apply the fix. Do NOT widen scope. Do NOT author tests (write-tests does that next).
  3. Run scoped gates per the preamble §Step 4.
  4. Update workflow.json: append your dispatch to
     .steps[<STEP_ID>].receivingCodeReview.dispatches[] AND flip the
     finding's `status` on the upstream code-review step (look it up by F.id) to "fixed"
     when gates pass.
  5. Emit the one-line cursor per preamble §Step 5.
```

### Dispatch entry shape

```jsonc
{
  "findingId": "F-1",
  "iteration": 1,
  "reason": "initial" | "retry" | "research-then-sonnet" | "research-then-opus",
  "role": "<F.domain>-fix-agent",
  "skill": "<F.assignedSkill>",
  "model": "sonnet" | "opus",
  "status": "fixed" | "failed" | "skipped",
  "filesChanged": ["..."],
  "gatesPostFix": { "lint": "pass|fail", "typecheck": "pass|fail", "tests": "pass|fail" },
  "researchBundle": "<path if applicable>",
  "failureTrace": "<one-line if status == failed>",
  "startedAt": "<ISO>",
  "completedAt": "<ISO>"
}
```

Each new dispatch is appended via `browzer workflow patch` — never via `Read`/`Write`/`Edit` on `workflow.json`.

### Quality gates after each finding

```bash
# Owning packages of F.file + reverse-deps of F.file:
PKGS=<derive>
pnpm turbo lint typecheck test --filter="{$PKGS}"
```

If a gate goes red AFTER the fix lands, the finding does NOT count as fixed — re-enter the ladder.

### Banned dispatch-prompt patterns (fix agents)

Do NOT include in fix-agent prompts:
- Instructions to author tests (`write-tests` runs next and owns that).
- Requests to widen scope beyond `F.file` + ≤15 lines integration glue.
- "Guess the fix from training data" — `browzer deps` and `browzer search` must be consulted first.
- Instructions to bypass quality gates even when the fix seems trivial.

---

## Phase 5 — Unrecovered findings (zero-debt escape hatch)

If a finding fails all 7 iterations:

1. Mark dispatch `status: "failed"` and upstream finding `status: "blocked"`.
2. Append to `receivingCodeReview.unrecovered[]`:

   ```jsonc
   {
     "findingId": "F-3",
     "severity": "medium",
     "lastTrace": "<one-line>",
     "totalIterations": 7,
     "modelsTried": ["sonnet", "sonnet", "sonnet", "opus", "opus", "opus"],
     "researchPassesRun": 2,
     "loggedToTechDebt": "docs/TECHNICAL_DEBTS.md#F-3"
   }
   ```

3. **Tech-debt doc append.** Locate via `browzer search "technical debt" --json --save /tmp/td.json` (common paths: `docs/TECHNICAL_DEBTS.md`, `docs/TECH_DEBT.md`, `TECH_DEBT.md`, `docs/debts.md`). Append:

   ```markdown
   ## <F.id> — <F.category> — unrecovered code-review finding (<date>)

   **Severity**: <F.severity>
   **File**: <F.file>:<F.line>
   **Description**: <F.description>
   **Suggested fix (failed)**: <F.suggestedFix>
   **Last failure trace**: <one-line>
   **Models exhausted**: sonnet ×3, opus ×3 (with 2 research passes)
   **Workflow ref**: <FEAT_DIR>/workflow.json @ <STEP_ID>

   _Operator: pick this up manually. Reverting blast radius:
   `browzer deps "<F.file>" --reverse --json --save /tmp/td.json`._
   ```

   When no manifest found, set `loggedToTechDebt: null` and add to `globalWarnings[]`.

4. Continue with remaining findings — Phase 5 is non-fatal.
