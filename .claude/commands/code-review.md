---
name: code-review
description: "Post-implementation team review of a feature's diff. Spawns 4 mandatory agents in parallel — senior-engineer (cyclomatic complexity, DRY, clean code, best practices), software-architect (system design, race conditions, clean architecture, caching, performance), qa (regressions, edge cases, butterfly-effect breakage), regression-tester (runs scoped tests over modified files + their browzer deps) — plus domain specialists discovered via /find-skills. Every agent gets the diff + browzer deps (forward + reverse) + browzer mentions and may run browzer explore to detect prior art / duplication. Read-only — `receiving-code-review` applies fixes next. Triggers: code review, review this feature, audit my changes, review the diff, post-implementation review, team review, peer review, find issues in this PR."
argument-hint: "feat dir: <path>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(npx *), Bash(jq *), Bash(mv *), Bash(date *), Bash(find *), Bash(grep *), Read, Write, Edit, AskUserQuestion, Agent
---

# code-review — team review for the shipped feature

Runs AFTER all TASK steps complete and BEFORE `receiving-code-review` / `write-tests` / `update-docs` / `feature-acceptance` / `commit`. Spawns 4 mandatory parallel agents + domain specialists and records findings into `workflow.json` at `STEP_<NN>_CODE_REVIEW`. Applies zero corrections — `receiving-code-review` consumes the findings next.

**Every agent receives**: the diff, `browzer deps` (forward + reverse) for each changed file, `browzer mentions` reverse traversal, and permission to run `browzer explore` to detect prior art. This context is non-negotiable — butterfly-effect bugs are invisible without the dep + mentions snapshot.

Output contract: emit ONE confirmation line on success.

## References router

| Topic | Reference |
| ----- | --------- |
| regression-tester role brief + Phase 5.0 non-collapsible carve-out + regressionRun shape | `references/regression-tester.md` |
| Category ownership table + severity rules + crossLaneOverlap semantics | `references/severity-matrix.md` |
| parallel-with-consolidator + agent-teams full dispatch contract | `references/dispatch-modes.md` |
| Mandatory member role briefs (senior-engineer, software-architect, qa) | `references/mandatory-members.md` |
| Subagent preamble (paste verbatim into every dispatched agent's prompt) | `references/subagent-preamble.md` |
| workflow.json schema (`codeReview`, `cyclomaticAudit`, `regressionRun`) | `references/workflow-schema.md` |
| jq helpers (seed_step, complete_step, append_review_history, bump_completed_count, validate_regression) | `references/jq-helpers.sh` |

## Banned dispatch-prompt patterns

Never use these in any agent prompt or inline jq:

- `Read workflow.json` / `Edit workflow.json` / `Write workflow.json` — use `browzer workflow *` only.
- `Read docs/browzer/<feat>/<doc>` — use `browzer workflow get-step --field <jqpath>` or `--render <template>`.
- Dispatching regression-tester inline as part of a collapsed in-line consolidation pass — see `references/regression-tester.md` Phase 5.0.
- `regressionRun.skipped: true` with `reason: "write-tests phase owns"` — that reason is misleading; the only valid skip is `"no-test-setup"`.
- Re-running `browzer deps` inside individual reviewer agents for files already in `CHANGED` — pre-compute once and share paths.

---

## Phase 0 — Prerequisites

```bash
TEAMS_FLAG=$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' ~/.claude/settings.json 2>/dev/null)
# Set to "1" → agentTeamsEnabled: true. Unset/other → false.
```

Resolve `FEAT_DIR` from args or newest `docs/browzer/feat-*/`. Bind `WORKFLOW="$FEAT_DIR/workflow.json"`.

Derive next step id:

```bash
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_CODE_REVIEW"
```

Stamp `startedAt` BEFORE doing any work (per workflow-schema §5.1):

```bash
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
seed_step "$STEP_ID" "CODE_REVIEW" "review"
```

## Phase 1 — Baseline (reuse upstream gates first)

```bash
REUSED=$(browzer workflow query reused-gates --workflow "$WORKFLOW")
```

For each gate present in `REUSED` AND covering the same affected package set, mark it `baseline.reusedGates[]` and skip the re-run. For any gate not covered, run it fresh:

```bash
CHANGED=$(browzer workflow query changed-files --workflow "$WORKFLOW" | jq -r '.[]')
PKGS=$(echo "$CHANGED" | awk -F/ '{print "@<scope>/"$2}' | sort -u | paste -sd,)
pnpm turbo lint typecheck test --filter="{$PKGS}" 2>&1 | tail -30
```

Record under `codeReview.baseline` (source: `"workflow-json"` | `"fresh-run"` | `"hybrid"`). When every gate is reusable, set `source: "workflow-json"` and proceed.

## Phase 2 — Scope + domain analysis

```bash
CHANGED=$(browzer workflow query changed-files --workflow "$WORKFLOW")
```

Classify each file by domain (Backend, Frontend/Web, Queue/Worker, RAG/Retrieval, Graph DB, Auth/Identity, Billing/Outbox, Security, Infra/Build, Testing, Performance, Observability). Weight each domain: **Heavy** (5+ files or core logic), **Medium** (2-4 files), **Light** (1 file).

For each Heavy domain, invoke `/find-skills <query>` and record the top-ranked skill in `codeReview.recommendedMembers[]`.

Domain taxonomy and `find-skills` queries: see `references/mandatory-members.md` §Phase 2 taxonomy.

## Phase 3 — Operator prompts

**Pre-registered skip path (autonomous mode + dispatch args):** if invocation args explicitly name `dispatchMode: <value>` AND `tier: <value>` AND `.config.mode == "autonomous"`, skip both prompts. Record `codeReview.preRegistered: true` and proceed.

**Prompt 1 — dispatch mode** (only if `agentTeamsEnabled`):

```
AskUserQuestion:
  Agent Teams is enabled. Dispatch mode?
    (a) agent-teams — dynamic team, round-table discussion
    (b) parallel-with-consolidator — N agents in parallel, 1 consolidator merges findings
```

If `agentTeamsEnabled: false`, skip and set `dispatchMode: "parallel-with-consolidator"` silently.

**Prompt 2 — review tier** (always, unless pre-registered):

Compute scope tier:

```bash
CHANGED_FILE_COUNT=$(git diff --name-only "$BASE_REF"...HEAD -- ':!*.lock' ':!*-lock.json' | wc -l | tr -d ' ')
SCOPE_TIER=$(case "$CHANGED_FILE_COUNT" in ([0-3]) echo small;; ([4-9]|1[0-5]) echo medium;; (*) echo large;; esac)
```

Per-agent token estimate: small ~5k | medium ~15k | large ~30k.

**Auto-default skip:** when `SCOPE_TIER == small` AND `heavyDomainCount == 1` AND `mediumDomainCount ≤ 2`, set `tier: "recommended"` silently and prompt only approve/customize. Record `codeReview.tierSelection: { mode: "auto", reason: "small + 1 heavy + ≤2 medium" }`.

Otherwise:

```
AskUserQuestion:
  Review tier? (SCOPE_TIER: <tier>; estimated tokens shown per option)
    (a) basic        — 4 mandatory members                         (~<calc_basic> tokens)
    (b) recommended  — mandatory + <N> recommended                 (~<calc_reco> tokens)
    (c) custom       — specify members explicitly
```

## Phase 4 — Team composition

See `references/mandatory-members.md` for full role briefs (senior-engineer, software-architect, qa).

See `references/regression-tester.md` for the regression-tester brief and **Phase 5.0 non-collapsible carve-out**.

See `references/severity-matrix.md` for category ownership and severity rules.

**Mandatory (always present, all four):** senior-engineer, software-architect, qa, regression-tester.

All four receive: diff, `browzer deps` (forward + reverse), `browzer mentions`, licence to run `browzer explore`.

**Recommended (operator-selected):** security (Auth/Security/Billing heavy), accessibility (Web heavy), domain specialists from `recommendedMembers[]`.

## Phase 5 — Execute

### Phase 5.0 — Regression-tester is non-collapsible

Read `references/regression-tester.md` in full. Even when the consolidator collapses for small/medium scope, the regression-tester MUST remain a separate non-collapsible dispatch. Required payload entry:

```jsonc
"regressionRun": { "skipped": false, ... }
```

`regressionRun.skipped: true` with `reason: "write-tests phase owns"` → reject the step (misleading reason). Only `reason: "no-test-setup"` is acceptable for a skip.

### Consolidator: in-line is the default for small + medium scopes

For small/medium tiers, consolidate inline (dedupe, normalise severity, `crossLaneOverlap`, `severityCounts`). Reserve dispatched consolidator for `large`. Record:

```jsonc
"consolidator": { "mode": "in-line" | "dispatched-agent", "reason": "string" }
```

### Dispatch

See `references/dispatch-modes.md` for the full `parallel-with-consolidator` and `agent-teams` contracts including degrade rules.

Always populate `severityCounts`:

```bash
SEVERITY_COUNTS=$(jq '[.findings[].severity] | group_by(.) | map({key:.[0],value:length}) | from_entries | {high:(.high//0),medium:(.medium//0),low:(.low//0)}' <<< "$CODE_REVIEW_PAYLOAD")
```

## Phase 6 — Write STEP_<NN>_CODE_REVIEW to workflow.json

```bash
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
complete_step "$STEP_ID" "$CODE_REVIEW_PAYLOAD"
bump_completed_count
```

Or use the full `browzer workflow append-step --await` form per workflow-schema §4 if creating a new step rather than completing a seeded one.

**Review gate (when `config.mode == "review"`):** flip status to `AWAITING_REVIEW`, render `references/renderers/code-review.jq`, enter Approve/Adjust/Skip/Stop loop per workflow-schema §7.

## Phase 7 — Zero corrections (handoff)

`code-review` NEVER alters code or tests.

```
AskUserQuestion:
  Review complete — <N> findings (H/M/L: <counts>).
  Proceed to receiving-code-review?
    (a) yes  (b) review findings first  (c) stop
```

## Phase 8 — Completion

Success:
```
code-review: updated workflow.json <STEP_ID>; findings <N>; status COMPLETED
```

Failure:
```
code-review: stopped at <STEP_ID> — <one-line cause>
hint: <single actionable next step>
```

**Banned from chat output:** findings list, cyclomatic tables, regression-run breakdowns. All data lives in the JSON.

---

## Non-negotiables

- No corrections applied. Read-only review.
- Mandatory members always present: senior-engineer, software-architect, qa, regression-tester.
- regression-tester is non-collapsible even when other lanes consolidate inline (see references/regression-tester.md).
- Every mandatory agent receives diff + `browzer deps --reverse` + `browzer mentions` + licence to run `browzer explore`.
- `workflow.json` mutated ONLY via `browzer workflow *`. Never with `Read`/`Write`/`Edit`.

---

## Invocation modes

- **Via `orchestrate-task-delivery`** — master pipeline invokes after all TASK steps complete.
- **Standalone** — operator invokes directly; writes a new CODE_REVIEW step.

---

## Related skills and references

- `execute-task` — runs before; produces the files this skill reviews.
- `receiving-code-review` — runs after; consumes `codeReview.findings[]`.
- `write-tests` — runs after `receiving-code-review`.
- `update-docs` — runs after `write-tests`.
- `feature-acceptance` — runs after update-docs.
- `references/regression-tester.md` — Phase 5.0 carve-out + regressionRun shape.
- `references/severity-matrix.md` — category ownership + severity rules.
- `references/dispatch-modes.md` — parallel-with-consolidator + agent-teams contracts.
- `references/mandatory-members.md` — role briefs (senior-engineer, software-architect, qa).
- `references/subagent-preamble.md` — paste verbatim into every dispatched agent's prompt.
- `references/workflow-schema.md` — authoritative schema.

## Render-template surface

Downstream skills consume a compressed summary via `browzer workflow get-step <step-id> --render code-review`. Emits one screen: mode, tier, scope, reviewers, severity counts, top-priority highs, themes.
