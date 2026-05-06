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

## Phase 4 — Fix-agent prompt template (slim — ≤500 tokens per dispatch)

Paste `references/subagent-preamble.md` §Step 0–5 verbatim, then append the slim
dispatch body below. The dispatcher passes IDS + paths; the fix-agent reads the
finding body itself via `browzer workflow get-step --field`.

> **Why slim.** Inlining the finding body (≈400 tokens × N findings) duplicates
> data already in `workflow.json` and goes stale when the operator edits the
> payload. Passing the `findingId` keeps the source of truth at one place and
> drops per-dispatch budget by ~3-4×.

```
Role: <F.domain>-fix-agent.   Iteration: <n>/7.   Workflow: $WORKFLOW.
Finding ID: <F-N>             Code-review step ID: $CODE_REVIEW_STEP

First action (BLOCKING — preamble Step 0): Skill('<F.assignedSkill>').

Read your finding body — single source of truth lives in workflow.json:
  browzer workflow get-step "$CODE_REVIEW_STEP" \
    --field ".codeReview.findings[] | select(.id == \"<F-N>\")" \
    --workflow "$WORKFLOW"

Read the context bundle (paths, NOT inlined blobs):
  depsPath:     /tmp/cr-deps-<slug>.json
  rdepsPath:    /tmp/cr-rdeps-<slug>.json
  mentionsPath: /tmp/cr-mentions-<slug>.json
  failureTraces (iteration > 1): see receivingCodeReview.dispatches[].failureTrace
  researchBundle (iteration ∈ {3,6}): <path or empty>

Scope: <F.file> ONLY (≤15-line glue exception per preamble §Step 3).

Contract:
  1. Read file → deps/mentions → apply fix. Do NOT author tests.
  2. Run scoped gates per preamble §Step 4.
  3. Append dispatch to .steps[<RCR_STEP_ID>].receivingCodeReview.dispatches[]
     AND flip the upstream finding's `status` to "fixed" via
     `browzer workflow set-finding-status` when gates pass.
  4. Emit the one-line cursor per preamble §Step 5.
```

When the project ships a renderer at `references/renderers/finding.jq`, prefer
`browzer workflow get-step --render finding` over the raw `--field` form for
agent ergonomics; the field-projection form is the canonical fallback.

For a multi-finding round-trip (e.g. promoting 8 findings from `fixing` to
`fixed` after one parallel wave), use the bulk verb instead of N
`set-finding-status` calls:
`browzer workflow set-finding-statuses --batch '<json-array>'`.

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
# Run the same lint+typecheck+test command captured in codeReview.baseline.command,
# scoped to $PKGS. Examples:
#   monorepo (pnpm + turborepo):  pnpm exec turbo lint typecheck test --filter="{$PKGS}"
#   monorepo (yarn workspaces):   yarn workspaces foreach --include="{$PKGS}" run check
#   single-package node — three separate invocations:
#     npm run lint
#     npm run typecheck
#     npm test
#   go module — two invocations:
#     go vet ./...
#     go test ./...
"$BASELINE_CMD" 2>&1 | tee /tmp/rcr-gate.log
```

If a gate goes red AFTER the fix lands, the finding does NOT count as fixed — re-enter the ladder.

### Banned dispatch-prompt patterns (fix agents)

Do NOT include in fix-agent prompts:
- Instructions to author tests (`write-tests` runs next and owns that).
- Requests to widen scope beyond `F.file` + ≤15 lines integration glue.
- "Guess the fix from training data" — `browzer deps` and `browzer search` must be consulted first.
- Instructions to bypass quality gates even when the fix seems trivial.

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
