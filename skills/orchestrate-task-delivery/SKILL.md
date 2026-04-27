---
name: orchestrate-task-delivery
description: "Master orchestrator for implementing any feature, bugfix, or refactor in a Browzer-indexed repo. Use proactively whenever the user wants to build, ship, fix, or refactor anything that touches more than a few files. Drives the full dev pipeline by chaining the per-phase skills (brainstorming when vague → PRD → task plan → execute → review → fix → update-docs → acceptance → commit). Resolves `config.mode` (autonomous vs review) at entry and writes the initial workflow.json skeleton. Grounds decisions in `browzer explore`/`search`/`deps` before touching code. Delegates all implementation to specialist subagents. Also trigger mid-workflow: 'execute TASK_03', 'update the docs', 'commit what I staged', 'ship this end-to-end', 'break this into tasks', 'run the first task'. Skip only for trivial ≤3-file read-only lookups."
allowed-tools: Bash(browzer *), Bash(git *), Bash(pnpm *), Bash(jq *), Bash(mv *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Read, Write, Edit, AskUserQuestion, Agent
---

# orchestrate-task-delivery — driver for the workflow pipeline

You orchestrate. You do not implement. Your job is **route → ground context → invoke the next skill → validate shape → move to the next phase**. Every phase writes a step to `docs/browzer/<feat>/workflow.json`; you read via `jq`, never `Read`.

`workflow.json` is the single source of truth. Skills chain without pause in `autonomous` mode and gate between phases in `review` mode.

Output contract: emit ONE confirmation line on success. One confirmation line at end-of-chain.

---

## Step 0 — Mode resolution (autonomous vs review)

Resolve `config.mode` before anything else. Order (per `references/workflow-schema.md` §7.1):

1. **Explicit in invocation args** — `Skill(orchestrate-task-delivery, "mode: autonomous; <rest>")` or `mode: review`. Take it verbatim.
2. **Inherited from workflow.json** — if `$FEAT_DIR/workflow.json` exists and `.config.mode` is set (re-entering mid-flow), keep it.
3. **Terminal prompt** — `AskUserQuestion`:

   ```
   Before proceeding:
     (a) autonomous — skills chain with no pauses, no .md generated
     (b) review — gate between skills; you approve/adjust each output
   ```

Write the resolved value to `.config.mode` + `.config.setAt` immediately via jq (not via `Read`/`Write`/`Edit`):

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq --arg mode "$MODE" --arg now "$NOW" \
   '.config.mode = $mode | .config.setAt = $now | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

### Mid-flow mode switch

If invoked with `"mode: switch-to-autonomous"` or `"mode: switch-to-review"`, additionally set `.config.switchedFrom` + `.config.switchedAt`. Future phases respect the new mode; historical `reviewHistory[]` entries stay untouched.

---

## Step 1 — Initialize feat dir + workflow.json

Resolve `FEAT_DIR` from args (`feat dir: <path>`) or create a new one:

```bash
FEAT_DIR="docs/browzer/feat-$(date -u +%Y%m%d)-<slug>"
mkdir -p "$FEAT_DIR"
WORKFLOW="$FEAT_DIR/workflow.json"
```

If `$WORKFLOW` does not exist, seed the v1 top-level skeleton per `references/workflow-schema.md` §2. Required top-level fields: `schemaVersion: 1`, `featureId`, `featureName`, `featDir`, `originalRequest`, `operator`, `config`, `startedAt`, `updatedAt`, `totalElapsedMin: 0`, `currentStepId: null`, `nextStepId: null`, `totalSteps: 0`, `completedSteps: 0`, `notes: []`, `globalWarnings: []`, `steps: []`.

### Corruption recovery

On entry, clean up any partial writes from prior sessions:

```bash
find "$FEAT_DIR" -name 'workflow.json.tmp' -delete
```

`.tmp` is not authoritative; removing it is safe. If `$WORKFLOW` itself is malformed (`jq empty "$WORKFLOW"` returns non-zero), STOP and emit a stop line with hint `jq empty workflow.json to validate`.

---

## Step 2 — Browzer context (cap 3-4 content queries)

Before dispatching the first skill, ground in the repo. Cap at 3-4 total content queries (`browzer search` / `browzer explore`) per routing turn. `browzer deps`, `browzer status`, `browzer mentions` don't count — they're structural probes.

```bash
browzer status --json                                               # sanity + staleness
browzer explore "<one noun from operator request>" --json --save /tmp/orch-explore.json
browzer search "<topic>" --json --save /tmp/orch-search.json
```

If the index is stale (`workspace.lastSyncCommit` > ~10 commits behind HEAD, or any browzer call emits `⚠ Index N commits behind`), surface exactly one line and proceed:

> ⚠ Browzer index is N commits behind HEAD. Recommended: `browzer sync`. Continuing — outputs may reflect stale reality.

Don't auto-run `sync-workspace`; don't block.

---

## Step 3 — Pipeline

Phases run in this order. Each writes a step to `workflow.json`; the orchestrator reads the step via `jq` to validate, then chains to the next.

| # | Step name | Skill | Parallel? |
| - | --------- | ----- | --------- |
| 0 | BRAINSTORMING (optional) | `brainstorming` | no |
| 1 | PRD | `generate-prd` | no |
| 2 | TASKS_MANIFEST + N × TASK | `generate-task` | no |
| 3 (per task) | TASK (execution payload) | `execute-task` | yes, when `tasksManifest.parallelizable[]` |
| 4 | CODE_REVIEW | `code-review` | no |
| 5 | FIX_FINDINGS | internal loop (§3.5) | yes per finding |
| 6 | UPDATE_DOCS | `update-docs` | no |
| 7 | FEATURE_ACCEPTANCE | `feature-acceptance` | no |
| 8 | COMMIT | `commit` | no |

**Chain contract.** After each skill's tool_result, immediately invoke the next phase's `Skill(...)` in the same response turn, unless a Step 6 stop condition fires. Quote-then-`Skill(...)` in one response is the pattern; quote-alone is the anti-pattern. The only valid terminal turns are:

1. Final success: `orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>`.
2. Explicit stop: `orchestrate-task-delivery: stopped at <stepId> — <reason>` + `hint: <next step>`.
3. One-question clarification budget allowed per flow.

### Phase 0 — Brainstorming (conditional)

Invoke `brainstorming` ONLY when input is vague. Heuristics:

- < 20 words AND no file path, persona, or verb-object pair.
- Starts with "what if" / "could we" / "would it be cool if".
- Names a capability with no success signal ("add X").

Else skip and chain to Phase 1.

### Phase 1 — PRD

`Skill(skill: "generate-prd", args: "feat dir: $FEAT_DIR")`. This skill does NOT auto-chain — the orchestrator drives the next phase.

### Phase 2 — Task manifest + per-task steps

`Skill(skill: "generate-task", args: "feat dir: $FEAT_DIR")`. Produces `STEP_03_TASKS_MANIFEST` + `STEP_04_TASK_01 … STEP_NN_TASK_MM` with Explorer + Reviewer payloads.

### Phase 3 — Execute each task

Read the manifest:

```bash
TASKS=$(jq -r '.steps[] | select(.name=="TASKS_MANIFEST") | .tasksManifest.tasksOrder[]' "$WORKFLOW")
PARALLEL=$(jq -c '.steps[] | select(.name=="TASKS_MANIFEST") | .tasksManifest.parallelizable' "$WORKFLOW")
```

For each task in order:

- **Sequential case**: `Skill(skill: "execute-task", args: "TASK_N; feat dir: $FEAT_DIR")`. Wait for COMPLETED before the next.
- **Parallel case**: for each group in `parallelizable[]`, dispatch all tasks in ONE response turn via `Task(..., isolation: "worktree")`. See Step 5 for worktree rendezvous.

#### Heuristic — when worktree-isolated parallel beats sequential

Worktree isolation costs ~30s of setup per branch (clone, install, baseline). Use parallel ONLY when at least ONE of the following holds for the `parallelizable[]` group:

- **≥ 3 tasks** in the group — wall-time amortizes the setup overhead.
- **≥ 15 in-scope files** total across the group — each task is non-trivial enough to dominate the setup cost.
- **≥ 1 task expected to run longer than ~30s** of agent work (long test suites, multi-package refactors, anything calling `pnpm turbo lint typecheck test`).
- **Pure-removal carve-out (mirrors `generate-task` Rule 7b):** ≥ 2 pure-removal tasks (deletion-only, no surviving glue beyond i18n keys, route tables, constants) AND combined deletions exceed 1000 LoC. Pure removals have no install/build cost and the conflict surface is just constants/i18n — `git merge` resolves it cleanly. The wall-clock saving compounds across the group even at 2 tasks.

For groups smaller than this threshold (e.g. 2 disjoint tasks of ≤5 files each), prefer **sequential** Skill invocations — the wall-clock cost of setting up two worktrees outweighs whatever overlap you'd get from running them at the same time. Document the choice in `tasksManifest.parallelStrategy` so the audit trail captures intent: `"worktrees" | "sequential" | "sequential (under heuristic threshold)" | "worktrees (pure-removal carve-out)"`.

Trivial-task fast path: if `.task.trivial == true`, `execute-task` uses the ≤15-line integration glue path, skips the test-specialist dispatch, and goes directly to aggregation. The orchestrator still invokes `execute-task` — the fast path lives inside that skill.

### Phase 4 — Code review

After ALL task steps complete, `Skill(skill: "code-review", args: "feat dir: $FEAT_DIR")`. Writes `STEP_<NN>_CODE_REVIEW` with `findings[]`. Always prompts operator for dispatch mode + review tier (§10.5 of the spec) — those prompts run regardless of `config.mode`.

### Phase 5 — Fix-findings (internal loop, NOT a standalone skill)

See Step 3.5 below. Writes `STEP_<NN>_FIX_FINDINGS`.

### Phase 6 — Update docs

`Skill(skill: "update-docs", args: "feat dir: $FEAT_DIR")`. Uses `browzer mentions` + direct-ref + concept-level signals. Writes `STEP_<NN>_UPDATE_DOCS`.

### Phase 7 — Feature acceptance

`Skill(skill: "feature-acceptance", args: "feat dir: $FEAT_DIR")`. Always prompts autonomous/manual (regardless of `config.mode`). Verifies PRD AC / NFR / metrics. If any fails → step STOPPED; the orchestrator stops the chain and hints back to fix-findings or execute-task.

### Phase 8 — Commit

`Skill(skill: "commit", args: "feat dir: $FEAT_DIR")`. Writes `STEP_<NN>_COMMIT` with the SHA. In review mode, `commit` renders `commit.jq` and loops on operator edits before firing the git commit.

---

## Step 3.5 — fix-findings internal loop

Not a standalone skill — orchestrator-owned loop that consumes `codeReview.findings[]` from the previous step.

1. **Read open findings**:
   ```bash
   FINDINGS=$(jq -c '.steps[] | select(.name=="CODE_REVIEW") | .codeReview.findings[] | select(.status=="open")' "$WORKFLOW")
   ```

2. **Dispatch per finding**:
   For each finding, dispatch an `Agent` with:
   - Role = `finding.domain`.
   - Skill = `finding.assignedSkill` (the path that `code-review` captured via `/find-skills`).
   - Model = severity-proportional (high=sonnet+, low=haiku).
   - Prompt = finding body + target file/line + suggestedFix + invariants from PRD. Paste `references/subagent-preamble.md` §Step 1-5 verbatim.
   - Isolation = `worktree` when findings touch disjoint files; sequential otherwise.

   Collect each dispatch's result into `fixFindings.dispatches[]` per schema §4. Every dispatch carries an `iteration` (monotonic per fix-findings re-entry) and a `reason` that records why the loop opened — `initial` for the first pass, `staging-regression` when the operator reports a bug from a staging smoke-test, `post-deploy` for prod follow-up, `operator-feedback` for anything else:
   ```jsonc
   { "findingId": "F-1",
     "iteration": 1,
     "reason": "initial",
     "role": "fastify-backend",
     "skill": ".claude/skills/owasp-security-review",
     "model": "sonnet", "status": "done|failed|skipped",
     "filesChanged": ["..."] }
   ```

3. **Quality gates + blast-radius regression** — always scoped to the affected package set, never repo-wide (see `references/subagent-preamble.md` §Step 2 for the contract + toolchain mapping):
   ```bash
   # Union of all files changed by fixes + prior task executions:
   CHANGED=$(jq '[.steps[] | select(.name=="TASK" or .name=="FIX_FINDINGS") | ..? | .filesChanged? // .files? | .modified? // [], .created? // []] | flatten | unique' "$WORKFLOW")

   # Compute blast-radius set:
   for F in $CHANGED; do
     browzer deps "$F" --json --save "/tmp/fix-deps-$(basename $F).json"
     browzer deps "$F" --reverse --json --save "/tmp/fix-rdeps-$(basename $F).json"
   done

   # Owning packages (pnpm --filter example — translate per toolchain):
   PKGS=$(echo "$BLAST_SET" | <derive owning packages>)

   # Run gates scoped — NOT `pnpm turbo lint typecheck test` without a filter:
   pnpm turbo lint typecheck test --filter="{$PKGS}"
   # Yarn: yarn lint <paths> && yarn tsc --noEmit   |   Nx: nx affected:<target>
   # Go: go vet ./<pkgs>/... && go test ./<pkgs>/...
   ```

   If progressive-tracking tooling (betterer, knip baseline, etc.) is wired into the repo's `lint` script, note in `fixFindings.notes` and consider running it CI-only — do not add the overhead to the fix-findings loop.

4. **Record**:
   - `fixFindings.qualityGates`: `{ lint, typecheck, tests }`.
   - `fixFindings.regressionTests`: `{ blastRadiusFiles, testsRun, testsPassed, testsFailed, duration }`.
   - If regression surfaces new failures: set step `status: STOPPED`, emit hint referencing failing test(s).

5. **Write STEP_<NN>_FIX_FINDINGS** via jq + mv.

**Idempotency**: re-invocation after a failure re-reads `codeReview.findings[]`, skips `status=="fixed"`, reprocesses `status=="fixing"` or `"open"`. No double-fixing.

**Re-entry from feature-acceptance**: when the operator's staging smoke-test surfaces a regression mid-`feature-acceptance`, the orchestrator may re-enter `fix-findings` even though the step was previously COMPLETED. On re-entry:

1. Bump `fixFindings.iterations` (`+= 1`).
2. Append the new dispatches to the SAME `fixFindings.dispatches[]` array (NOT to a sibling key like `stagingRegressionFixes` — that pattern is banned).
3. Stamp every new dispatch with `iteration: N` and a `reason` from the enum above.
4. After the new dispatches land, re-run `feature-acceptance` from Phase 2 — do not jump to commit until the operator re-approves.

---

## Step 4 — Validate skill output

After every `Skill(...)` tool_result, read the just-written step via jq:

```bash
LAST=$(jq -r '.currentStepId' "$WORKFLOW")
STATUS=$(jq -r --arg id "$LAST" '.steps[] | select(.stepId==$id) | .status' "$WORKFLOW")
```

- `COMPLETED` → chain to the next phase.
- `AWAITING_REVIEW` → review mode is driving; the skill's internal loop is running. Wait for the skill to return a final status.
- `STOPPED` → stop the chain; emit stop line + hint.
- `SKIPPED` → chain to the next phase.

Also validate the payload schema matches `references/workflow-schema.md` §4 for the step's `name`. If the payload is malformed (missing required keys), append `globalWarnings[]` and re-dispatch once; on second failure, STOP.

For any new jq mutation in this orchestrator (or for future skills you author), prefer the helpers in `references/jq-helpers.sh` over rolling another inline `jq | mv` block — `seed_step`, `complete_step`, `append_review_history`, `bump_completed_count`, and `validate_regression` are the sanctioned shapes and they enforce the contracts (atomic rename, regression-diff diffing, completed-count integrity) uniformly across the pipeline. Source the file once at the top of any new bash section: `source references/jq-helpers.sh`.

---

## Step 5 — Parallel dispatch (worktree rendezvous)

When `tasksManifest.parallelizable[][]` fires (and meets the heuristic above), or `fix-findings` dispatches to disjoint findings, follow the four-step claim → isolate → merge → freeze protocol documented in `references/worktree-rendezvous.md`:

1. Pre-dispatch claim — main worktree marks each step's `owner` and flips `status: "RUNNING"`.
2. In-worktree — each subagent operates only on steps it owns; never touches another worktree's slice.
3. Rendezvous — main worktree patches each owned step back via `jq | mv` (replacement, not merge).
4. Completed steps are immutable — re-runs require an explicit `retryCount` bump.

The full snippets, owner-string conventions, and failure-mode table live in [`references/worktree-rendezvous.md`](references/worktree-rendezvous.md). Read that file when actually firing a parallel dispatch — sequential flows skip this entirely.

---

## Step 6 — Stop conditions

Stop the chain (emit stop line) when any of these fire:

- **3-strike external failure**: a non-skill tool (git, pnpm, browzer CLI) fails 3 times for the same reason.
- **Feature-acceptance verdict STOPPED**: one or more AC/NFR/metrics failed. Hint to fix-findings or execute-task remediation.
- **Operator abort**: operator replies with "stop" / "abort" / "cancel" to any gate prompt.
- **Schema corruption**: `jq empty "$WORKFLOW"` fails, or a step's payload fails schema §4 shape check twice.

Stop line shape:

```
orchestrate-task-delivery: stopped at <stepId> — <one-line cause>
hint: <single actionable next step>
```

---

## Step 7 — Completion

On success (all 9 phases COMPLETED), backfill the elapsed-time fields BEFORE printing the success line. The per-step `.elapsedMin` and the top-level `.totalElapsedMin` exist in the schema but no upstream skill is required to populate them — the orchestrator owns the roll-up so the audit trail captures wall-time per phase plus the end-to-end total.

```bash
jq '
  ((.startedAt | fromdateiso8601) as $start
   | (.updatedAt | fromdateiso8601) as $end
   | .totalElapsedMin = (($end - $start) / 60 | floor))
  | .steps |= map(
      if (.startedAt and .completedAt) then
        ((.startedAt | fromdateiso8601) as $s
         | (.completedAt | fromdateiso8601) as $e
         | .elapsedMin = (($e - $s) / 60 | floor))
      else . end)
' "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

Then print the success line:

```
orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>
```

Compute `<elapsedMin>` as the freshly-written `.totalElapsedMin`. Extract `<SHA>` from the COMMIT step's `commit.sha`.

**Banned from chat output**: phase-by-phase summaries, tasks tables, HANDOFF quotes, subagent transcripts, "Next steps" block. All of that lives in `workflow.json`.

---

## Mode-specific chain contract

### autonomous (`config.mode == "autonomous"`)

- No pauses between skills (except the code-review + feature-acceptance always-ask prompts, which fire regardless).
- No `.md` rendered.
- Skills chain directly.

### review (`config.mode == "review"`)

- Each review-candidate skill (§7.3 of the spec: brainstorming, generate-prd, generate-task, update-docs, commit; hybrid: code-review, feature-acceptance) flips its step to `AWAITING_REVIEW`, renders its `.jq` template, enters its internal gate loop.
- The skill returns COMPLETED only after operator approval. The orchestrator does NOT drive the review loop itself — each skill owns its gate.
- Operator adjustments translate to jq ops on the step's payload. Appended to `reviewHistory[]`.

---

## Tool usage discipline

- **`workflow.json` mutation**: ALWAYS `jq | mv` (atomic rename). NEVER `Read` / `Write` / `Edit` on `workflow.json`.
- **Parallel dispatch**: literal — N `Task(...)` or `Agent(...)` calls in a single response turn. Announcing "3 parallel agents" and sending 1 call is a protocol violation.
- **Subagent preamble**: paste `references/subagent-preamble.md` §Step 1-5 verbatim into every dispatched agent's prompt.
- **Browzer first**: before touching any library/framework/config you didn't author, run `browzer search` → then Context7 if browzer has no coverage.

---

## Non-negotiables

- **Output language: English.** All workflow.json fields in English. Conversational wrapper follows operator's language.
- No application code. You are the orchestrator.
- No silent skips of phases. If a phase is genuinely n/a (e.g. no TASK steps because the PRD is pure docs), the skipped step is recorded with `status: SKIPPED` and `applicability.applicable: false`.
- No inline gate-failure fixes. Dispatch a fix agent via fix-findings.
- No parallel edits of the same file without worktree isolation.
- `commit` is the last phase. Don't chain to `sync-workspace` — that's a separate ops concern.

---

## Invocation modes

- **Direct feature request** — operator says "add X", "implement Y", "build Z". Route through Step 0 mode prompt → Phase 0/1/2/… in order.
- **Mid-flow entry** — operator says "execute TASK_03", "update the docs", "commit what I staged". Resolve `FEAT_DIR` from context, jump to the named phase. Inherit `config.mode` from workflow.json.
- **Quality-only rerun** — operator says "re-run code-review after iteration". Invoke the named phase standalone; each skill re-enters and writes a new step (with a new NN index).

---

## Related skills and references

- `brainstorming`, `generate-prd`, `generate-task`, `execute-task`, `test-driven-development`, `write-tests`, `code-review`, `update-docs`, `feature-acceptance`, `commit` — the pipeline.
- `references/workflow-schema.md` — authoritative schema. READ FIRST before any jq filter.
- `references/subagent-preamble.md` — paste into every dispatched agent's prompt.
- `references/renderers/*.jq` — per-step markdown renderers invoked in review mode.
- `sync-workspace` — separate skill; re-indexes the workspace after merge. Not part of this pipeline.
