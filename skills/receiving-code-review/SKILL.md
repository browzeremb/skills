---
name: receiving-code-review
description: "Consumes `codeReview.findings[]` from the previous CODE_REVIEW step and dispatches per-domain fix agents until EVERY finding (high → low) reaches `status: fixed`. Each fix agent receives the finding body, the source file, browzer deps + mentions, and the relevant skill from `finding.assignedSkill`. Zero-tech-debt contract: a clean run leaves no open finding behind. Use after `code-review` and before `write-tests`. Triggers: receive code review, apply code review fixes, fix the findings, close the review, fix-findings, address review feedback, resolve code review."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(npx *), Bash(jq *), Bash(mv *), Bash(date *), Bash(find *), Bash(grep *), Read, Write, Edit, AskUserQuestion, Agent
---

# receiving-code-review — close every finding before tests/docs

Runs AFTER `code-review` writes `codeReview.findings[]` and BEFORE `write-tests` / `update-docs` / `feature-acceptance` / `commit`. Reads the open findings, dispatches per-finding fix agents (severity-proportional models, never `haiku` for fixes), runs scoped quality gates after each batch, and writes `STEP_<NN>_RECEIVING_CODE_REVIEW` with every dispatch recorded. The contract is **zero technical debt**: when this skill returns `COMPLETED`, every finding is `status: fixed` (or explicitly logged with documented justification — see Phase 5).

Output contract: emit ONE confirmation line on success.

---

## Phase 0 — Prerequisites

Resolve `FEAT_DIR` from args or the newest `docs/browzer/feat-*/` and bind `WORKFLOW="$FEAT_DIR/workflow.json"`.

Derive the next monotonic step id:

```bash
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_RECEIVING_CODE_REVIEW"
```

Stamp `startedAt` BEFORE doing any work (per workflow-schema §5.1):

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
browzer workflow append-step --workflow "$WORKFLOW" <<EOF
{ "stepId": "$STEP_ID", "name": "RECEIVING_CODE_REVIEW", "status": "RUNNING",
  "applicability": { "applicable": true, "reason": "consume code-review findings" },
  "startedAt": "$NOW", "retryCount": 0,
  "skillsToInvoke": ["receiving-code-review"], "skillsInvoked": ["receiving-code-review"],
  "owner": null, "worktrees": { "used": false, "worktrees": [] },
  "warnings": [], "reviewHistory": [],
  "receivingCodeReview": { "iteration": 1, "dispatches": [] } }
EOF
```

Locate the upstream code-review step:

```bash
CODE_REVIEW_STEP=$(jq -r 'last(.steps[] | select(.name=="CODE_REVIEW") | .stepId) // empty' "$WORKFLOW")
[ -z "$CODE_REVIEW_STEP" ] && {
  echo "receiving-code-review: stopped at $STEP_ID — no upstream CODE_REVIEW step found"
  echo "hint: run code-review first"
  exit 1
}
```

## Phase 1 — Render the upstream code-review summary

Each fix agent gets the upstream review's compressed summary (mode, tier, scope, severity counts, themes) so it can fix in context, not in isolation:

```bash
CODE_REVIEW_SUMMARY=$(browzer workflow get-step "$CODE_REVIEW_STEP" --render code-review --workflow "$WORKFLOW")
```

If `--render code-review` is unavailable in the installed browzer CLI, fall back to a jq render of `codeReview.summary` + the top-3 highs.

## Phase 2 — Read open findings + classify

```bash
OPEN=$(browzer workflow query open-findings --workflow "$WORKFLOW")
TOTAL=$(jq 'length' <<< "$OPEN")
```

If `TOTAL == 0`, write a synthetic step with `dispatches: []` and `notes: "no findings to address"`, flip status to `COMPLETED`, and emit the success line — `code-review` already left the codebase clean.

Otherwise group by domain (use `finding.domain` from the upstream payload) and partition findings into **disjoint-file groups** so independent groups can run in parallel without worktree thrash. A group's files are disjoint when no file in group A appears in group B's `file` field. Cross-group sequential dispatch protects against merge collisions; parallel within-group is unsafe and is NOT used here.

Sort within each group by severity descending (`high` → `medium` → `low`) so the high-leverage fixes land first; later low-severity findings can sometimes be subsumed by a higher-severity refactor and skipped (see Phase 5).

## Phase 3 — Dispatch model selection (severity-proportional, never haiku for fixes)

| Severity | Default model | Rationale |
| -------- | ------------- | --------- |
| high     | sonnet        | reasoning + diff fluency |
| medium   | sonnet        | sonnet handles most medium fixes cleanly |
| low      | sonnet        | haiku is forbidden — even cosmetic fixes regress on subtle invariants |

`haiku` is not allowed for fix dispatch under any condition. The code-review retros showed haiku missing tenant-scoping invariants on "obvious" cosmetic finds; the cost of the regression dwarfs the haiku savings.

Escalation ladder fires automatically on consecutive failures of the SAME finding (Phase 4 records the iteration count):

| Failure count for finding F | Next dispatch |
| --------------------------- | ------------- |
| 1                           | `sonnet` (initial) |
| 2                           | `sonnet` (retry; the agent often needs the failure trace it didn't have on attempt 1) |
| 3                           | **research-then-sonnet** — dispatch a research agent (WebFetch + WebSearch + browzer search) to gather library/pattern docs, then re-dispatch the fix on `sonnet` with the research bundle in the prompt |
| 4                           | `opus` |
| 5                           | `opus` (retry with the failure trace from #4) |
| 6                           | **research-then-opus** — second research pass, then re-dispatch on `opus` |
| 7                           | **STOP**: log the unrecovered finding under workflow.json + technical-debt doc per Phase 5; continue with the remaining findings; emit a non-fatal warning at the end |

The 7th failure does NOT abort the whole skill — that would block other findings from closing. The contract is "zero-debt by default; every escape hatch is logged".

## Phase 4 — Execute (per-finding loop)

For each disjoint-file group (sequential between groups; sequential within the group too — fixes inside one group share files):

```
For each finding F in group, by severity desc:
  iteration = 0
  while iteration < 7:
    iteration += 1
    model       = pickModel(F, iteration)             # per Phase 3 ladder
    research    = (iteration in {3, 6})               # research pass before retry
    if research:
      dispatch research-agent → bundle = web/docs findings
    dispatch fix-agent(model, F, code-review-summary, bundle?, deps, mentions, skill = F.assignedSkill)
    record dispatch in receivingCodeReview.dispatches[]
    run scoped gates (lint/typecheck/test) on F.file + reverse-deps of F.file
    if gates green AND F.status flipped to fixed:
      break
    else:
      mark F.status = fixing; record failure trace; continue
  if iteration == 7 AND F.status != fixed:
    log unrecovered (Phase 5)
```

### Fix-agent prompt template

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
  - Forward deps:        /tmp/cr-deps-<slug>.json
  - Reverse deps (blast): /tmp/cr-rdeps-<slug>.json
  - Mentions (docs/entities): /tmp/cr-mentions-<slug>.json
  - Prior failure traces: <list iteration-level traces if iteration > 1>
  - Research bundle:     <path if research pass was triggered this iteration>

Scope: <F.file> ONLY (plus integration glue ≤15 lines elsewhere if absolutely required —
see preamble §Step 3 exception).

Contract:
  1. Read the file, then read the relevant deps/mentions before editing.
  2. Apply the fix. Do NOT widen scope. Do NOT author tests (write-tests does that next).
  3. Run scoped gates per the preamble §Step 4.
  4. Update workflow.json: append your dispatch to
     .steps[<this STEP_ID>].receivingCodeReview.dispatches[] AND flip the
     finding's `status` on the upstream code-review step (look it up by F.id) to "fixed"
     when gates pass.
  5. Emit the one-line cursor per preamble §Step 5.
```

### Recording each dispatch

Each dispatch entry conforms to:

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

After every fix lands, re-run scoped gates (NEVER repo-wide — see `references/subagent-preamble.md` §Step 2 for toolchain mapping):

```bash
# Owning packages of F.file ∪ reverse-deps of F.file:
PKGS=<derive>
pnpm turbo lint typecheck test --filter="{$PKGS}"
```

If a gate goes red AFTER the fix lands, the finding does NOT count as fixed — re-enter the iteration ladder.

## Phase 5 — Unrecovered findings (the zero-debt escape hatch)

If a finding fails 7 iterations (initial + 5 retries + 2 research passes) without closing:

1. Mark its dispatch `status: "failed"` and the upstream finding's `status: "blocked"`.
2. Append a `receivingCodeReview.unrecovered[]` entry:

   ```jsonc
   { "findingId": "F-3", "severity": "medium",
     "lastTrace": "<one-line>",
     "totalIterations": 7,
     "modelsTried": ["sonnet", "sonnet", "sonnet", "opus", "opus", "opus"],
     "researchPassesRun": 2,
     "loggedToTechDebt": "docs/TECHNICAL_DEBTS.md#F-3" }
   ```

3. **Tech-debt doc append**. If the repo carries a known tech-debt manifest (look up the path via `browzer search "technical debt" --json --save /tmp/td.json` and pick the highest-confidence hit; common paths: `docs/TECHNICAL_DEBTS.md`, `docs/TECH_DEBT.md`, `TECH_DEBT.md`, `docs/debts.md`), append:

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

   When no tech-debt manifest is found, set `loggedToTechDebt: null` and surface a workflow-level `globalWarnings[]` entry instead.

4. Continue with remaining findings — Phase 5 is non-fatal. The skill emits a success-with-warnings line at the end (Phase 7).

## Phase 6 — Final write

After every finding has been processed (fixed, blocked, or skipped):

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" --arg now "$NOW" \
  '(.steps[] | select(.stepId==$id)) |= (
     .status = (if (.receivingCodeReview.unrecovered // []) | length == 0
                then "COMPLETED" else "COMPLETED" end)
     | .completedAt = $now
     | .elapsedMin = ((($now | fromdateiso8601) - (.startedAt | fromdateiso8601)) / 60 | floor)
     | .receivingCodeReview.summary = {
         total:       (.receivingCodeReview.dispatches | length),
         fixed:       ([.receivingCodeReview.dispatches[] | select(.status == "fixed")] | length),
         unrecovered: ((.receivingCodeReview.unrecovered // []) | length)
       })
   | .updatedAt = $now'
```

Note: `unrecovered > 0` does NOT flip status to `STOPPED`. The skill completes; the warning surfaces in the success line. STOPPED is reserved for upstream-data corruption (Phase 0 abort cases).

## Phase 7 — Completion (one line)

Success (zero unrecovered):

```
receiving-code-review: updated workflow.json <STEP_ID>; <N> findings fixed; status COMPLETED
```

Success (with unrecovered):

```
receiving-code-review: updated workflow.json <STEP_ID>; <N> fixed, <M> unrecovered; status COMPLETED; ⚠ see receivingCodeReview.unrecovered + tech-debt log
```

Failure (Phase 0 only — corruption / missing CODE_REVIEW step):

```
receiving-code-review: stopped at <STEP_ID> — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output**: per-finding diff summaries, dispatch tables, gate logs. The audit trail is in `workflow.json`.

---

## Idempotency

Re-invocation after a partial failure re-reads `open-findings` and skips `status == "fixed"`. Findings still `open` or `fixing` re-enter the iteration ladder, but `iteration` resumes from the last recorded value (so cumulative attempts respect the 7-iteration cap across re-entries). Each re-entry bumps `receivingCodeReview.iteration` (the skill-level counter, not the per-finding one).

---

## Re-entry from feature-acceptance

When the operator's staging smoke-test surfaces a regression mid-`feature-acceptance`, the orchestrator may re-enter `receiving-code-review` even though the step was previously COMPLETED:

1. Bump `receivingCodeReview.iteration` (`+= 1`).
2. Append the new dispatches to the SAME `dispatches[]` array (NOT a sibling key).
3. Stamp every new dispatch with `iteration: N` and a `reason` from `{"initial", "retry", "research-then-sonnet", "research-then-opus", "staging-regression", "post-deploy", "operator-feedback"}`.
4. After dispatches land, re-run `feature-acceptance` from its Phase 2 — do not jump to commit until the operator re-approves.

---

## Non-negotiables

- **Output language: English.** All workflow.json fields in English. Conversational wrapper follows operator's language.
- **Zero technical debt by default.** Every finding closes or gets logged in both workflow.json AND the tech-debt doc; silent skips are forbidden.
- **No haiku for fixes.** Sonnet minimum on every fix dispatch. Research agents may use haiku for shallow lookups but MUST hand back to sonnet/opus for the actual fix.
- **Read-only on the upstream code-review step.** Only the `findings[].status` field flips to `fixed`/`blocked`. Severity, description, file, line stay frozen.
- **No new tests authored here.** `write-tests` runs next and owns green coverage + mutation testing.
- **Disjoint-group sequential dispatch.** Within-group parallel is forbidden because of file collision; across-group parallel is allowed only with worktree isolation (defer to operator unless 3+ groups).
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — the master pipeline invokes this skill AFTER `code-review` completes. The orchestrator then chains to `write-tests`, then `update-docs`, then `feature-acceptance`, then `commit`.
- **Standalone** — operator invokes directly to re-process findings after a partial run, or to re-process findings after a manual edit added new ones.

---

## Related skills and references

- `code-review` — runs before; produces the `findings[]` this skill consumes.
- `write-tests` — runs after; authors green tests for the final file set + runs mutation testing.
- `update-docs` — runs after `write-tests`.
- `feature-acceptance` — runs after `update-docs`.
- `references/subagent-preamble.md` — paste into every dispatched fix-agent's prompt.
- `references/workflow-schema.md` — authoritative schema (`receivingCodeReview`, `dispatches[]`, `unrecovered[]`).
