---
name: receiving-code-review
description: "Consumes `codeReview.findings[]` from the previous CODE_REVIEW step and dispatches per-domain fix agents until EVERY finding (high → low) reaches `status: fixed`. Each fix agent receives the finding body, the source file, browzer deps + mentions, and the relevant skill from `finding.assignedSkill`. Zero-tech-debt contract: a clean run leaves no open finding behind. Use after `code-review` and before `write-tests`. Triggers: receive code review, apply code review fixes, fix the findings, close the review, fix-findings, address review feedback, resolve code review."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(npx *), Bash(jq *), Bash(mv *), Bash(date *), Bash(find *), Bash(grep *), Bash(source *), Read, Write, Edit, AskUserQuestion, Agent
---

# receiving-code-review — close every finding before tests/docs

Runs AFTER `code-review` writes `codeReview.findings[]` and BEFORE `write-tests` / `update-docs` / `feature-acceptance` / `commit`. Reads open findings, dispatches per-finding fix agents (severity-proportional models, never `haiku` for fixes), runs scoped quality gates after each batch, and writes `STEP_<NN>_RECEIVING_CODE_REVIEW` with every dispatch recorded. Contract: **zero technical debt** — when this skill returns `COMPLETED`, every finding is `status: fixed` (or explicitly logged).

Output contract: emit ONE confirmation line on success.

---

## References router

| Topic | Reference |
|---|---|
| Model selection table + escalation ladder | `references/iteration-ladder.md §Phase 3` |
| Fix-agent prompt template + dispatch entry shape + quality gates | `references/iteration-ladder.md §Phase 4` |
| Unrecovered finding policy + tech-debt doc append | `references/iteration-ladder.md §Phase 5` |
| Subagent preamble (paste into every fix-agent prompt) | `references/subagent-preamble.md` |
| Atomic jq helpers | `references/jq-helpers.sh` |
| Workflow step shapes | `references/workflow-schema.md` |

---

## Phase 0 — Prerequisites

```bash
source references/jq-helpers.sh   # provides seed_step, complete_step, truncation_audit

FEAT_DIR="${1:-$(ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -1)}"
WORKFLOW="$FEAT_DIR/workflow.json"

NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_RECEIVING_CODE_REVIEW"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Stamp `startedAt` BEFORE doing any work (per workflow-schema §5.1):

```bash
browzer workflow append-step --await --workflow "$WORKFLOW" <<EOF
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

## Phase 1 — Render upstream code-review summary

```bash
CODE_REVIEW_SUMMARY=$(browzer workflow get-step "$CODE_REVIEW_STEP" --render code-review --workflow "$WORKFLOW")
```

If `--render code-review` is unavailable, fall back to a jq render of `codeReview.summary` + the top-3 highs.

## Phase 2 — Read open findings + classify

```bash
OPEN=$(browzer workflow query open-findings --workflow "$WORKFLOW")
TOTAL=$(jq 'length' <<< "$OPEN")
```

If `TOTAL == 0`, write a synthetic step with `dispatches: []` and `notes: "no findings to address"`, flip status to `COMPLETED`, and emit the success line.

Otherwise group by domain (use `finding.domain`) and partition findings into **disjoint-file groups** so independent groups can run in parallel without worktree thrash. Sort within each group by severity descending (`high` → `medium` → `low`).

## Phase 3 — Dispatch model selection

See **`references/iteration-ladder.md §Phase 3`** for the model selection table and full escalation ladder (7 iterations: initial sonnet → retry sonnet → research-then-sonnet → opus → retry opus → research-then-opus → STOP).

## Phase 4 — Execute (per-finding loop)

See **`references/iteration-ladder.md §Phase 4`** for the fix-agent prompt template and dispatch entry shape.

```
For each disjoint-file group (sequential between groups; sequential within group):
  For each finding F in group, by severity desc:
    iteration = 0
    while iteration < 7:
      iteration += 1
      model    = pickModel(F, iteration)        # per iteration-ladder.md §Phase 3
      research = (iteration in {3, 6})
      if research: dispatch research-agent → bundle = web/docs findings
      dispatch fix-agent(model, F, code-review-summary, bundle?, deps, mentions, skill=F.assignedSkill)
      record dispatch in receivingCodeReview.dispatches[]
      run scoped gates (lint/typecheck/test) on F.file + reverse-deps
      if gates green AND F.status flipped to fixed: break
      else: mark F.status = fixing; record failure trace; continue
    if iteration == 7 AND F.status != fixed: log unrecovered (Phase 5)
```

Each dispatch is appended via `browzer workflow patch` — never via `Read`/`Write`/`Edit`.

## Phase 5 — Unrecovered findings (zero-debt escape hatch)

See **`references/iteration-ladder.md §Phase 5`** for the full `unrecovered[]` entry shape and tech-debt doc append template. Phase 5 is non-fatal — the skill continues with remaining findings.

## Phase 6 — Final write

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
browzer workflow patch --workflow "$WORKFLOW" --jq \
  --arg id "$STEP_ID" --arg now "$NOW" \
  '(.steps[] | select(.stepId==$id)) |= (
     .status = "COMPLETED"
     | .completedAt = $now
     | .elapsedMin = ((($now | fromdateiso8601) - (.startedAt | fromdateiso8601)) / 60 | floor)
     | .receivingCodeReview.summary = {
         total:       (.receivingCodeReview.dispatches | length),
         fixed:       ([.receivingCodeReview.dispatches[] | select(.status == "fixed")] | length),
         unrecovered: ((.receivingCodeReview.unrecovered // []) | length)
       })
   | .updatedAt = $now'
```

`unrecovered > 0` does NOT flip status to `STOPPED`. STOPPED is reserved for Phase 0 abort cases.

## Phase 7 — Completion (one line)

```
receiving-code-review: updated workflow.json <STEP_ID>; <N> findings fixed; status COMPLETED
```

With unrecovered:

```
receiving-code-review: updated workflow.json <STEP_ID>; <N> fixed, <M> unrecovered; status COMPLETED; ⚠ see receivingCodeReview.unrecovered + tech-debt log
```

Failure (Phase 0 only):

```
receiving-code-review: stopped at <STEP_ID> — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output**: per-finding diff summaries, dispatch tables, gate logs. The audit trail is in `workflow.json`.

---

## Idempotency

Re-invocation re-reads `open-findings` and skips `status == "fixed"`. Findings still `open` or `fixing` re-enter the ladder, resuming from the last recorded `iteration` value (cumulative attempts respect the 7-iteration cap). Each re-entry bumps `receivingCodeReview.iteration`.

## Re-entry from feature-acceptance

1. Bump `receivingCodeReview.iteration` (`+= 1`).
2. Append new dispatches to the SAME `dispatches[]` array.
3. Stamp every new dispatch with `iteration: N` and `reason` from `{"initial", "retry", "research-then-sonnet", "research-then-opus", "staging-regression", "post-deploy", "operator-feedback"}`.
4. After dispatches land, re-run `feature-acceptance` from Phase 2 — do not jump to commit until operator re-approves.

---

## Non-negotiables

- **Output language: English.** Conversational wrapper follows operator's language.
- **Zero technical debt by default.** Every finding closes or gets logged; silent skips are forbidden.
- **No haiku for fixes.** Sonnet minimum on every fix dispatch.
- **Read-only on upstream code-review step.** Only `findings[].status` flips to `fixed`/`blocked`.
- **No new tests authored here.** `write-tests` runs next.
- **Disjoint-group sequential dispatch.** Within-group parallel is forbidden; across-group parallel only with worktree isolation.
- `workflow.json` mutated ONLY via `browzer workflow *` CLI subcommands.

---

## Related skills and references

- `code-review` — runs before; produces the `findings[]` this skill consumes.
- `write-tests` — runs after; authors green tests + runs mutation testing.
- `update-docs` — runs after `write-tests`.
- `feature-acceptance` — runs after `update-docs`.
- `references/subagent-preamble.md` — paste into every dispatched fix-agent's prompt.
- `references/workflow-schema.md` — authoritative schema.
- `references/iteration-ladder.md` — model selection, escalation ladder, prompt template, Phase 5 policy.
