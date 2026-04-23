---
name: generate-task
description: "Step 2 of 6 in the dev workflow (generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace). Reads the PRD from `docs/browzer/feat-<date>-<slug>/PRD.md` (the folder `generate-prd` created) and decomposes it into mergeable, PR-sized engineering tasks written as `TASK_NN.md` siblings in the same folder. Writes TASK_NN.md files + activation-receipt.json; emits a single-line confirmation per the output contract. Hands off downstream skills by path. Uses `browzer explore`/`deps`/`search` to map requirements to real files and surface repo invariants. Enforces layer order (shared types → data → server → workers → client → tests → docs), orphan-free rule, ~30-file soft cap, forward-only dependencies, merge-safety. Use when user says 'break this PRD into tasks', 'generate tasks', 'plan the implementation', 'split this into PRs', 'decompose this spec', 'how should I sequence this', or right after `generate-prd` finishes. Triggers: 'break into tasks', 'split into PRs', 'decompose this spec', 'task plan', 'task breakdown', 'sequence the work', 'how should I sequence this', 'decompose into tasks', 'plan the PRs'."
allowed-tools: Bash(browzer *), Bash(git *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(date *), Read, Write
---

# generate-task — decompose a PRD into ordered, executable tasks

Step 2 of 6: `generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace`. Reads the PRD from `docs/browzer/feat-<date>-<slug>/PRD.md` (the folder `generate-prd` created), assembles a numbered task list, and **persists each spec as a `TASK_NN.md` sibling in that same folder** — the file is the durable artefact. Downstream skills (`execute-task`, `orchestrate-task-delivery`) route by path reference, not by scanning chat history.

Output contract: `../../README.md` §"Skill output contract". This skill emits **one confirmation line** on success; no summary tables, no inline task bodies, no "Next steps" blocks.

You are a staff engineer breaking a spec into mergeable PR-sized tasks for **the repo this skill is invoked from**. You don't assume framework, monorepo shape, or test runner — you discover them. Every task must be directly runnable by `execute-task` with zero additional discovery.

## Inputs

- **Primary:** feat folder path `docs/browzer/feat-<date>-<slug>/` — passed as arg by `generate-prd`'s chain contract (e.g. `feat dir: docs/browzer/feat-20260420-user-auth-device-flow`), or recoverable from the last `generate-prd` turn in chat. Read `PRD.md` inside it.
- **Fallback 1:** user invokes `generate-task` alone. List existing folders via `ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -5` and ask which one (or accept a path arg). If none exist, call `Skill(skill: "generate-prd")` first.
- **Fallback 2:** user pastes a free-form description without running `generate-prd`. Call `Skill(skill: "generate-prd")` first — don't decompose against a shapeless request.

Bind the resolved path to `FEAT_DIR` for the rest of the skill. Every file you write goes under `$FEAT_DIR/`.

## Step 1 — Read PRD, extract atoms

`Read $FEAT_DIR/PRD.md` — the on-disk copy is the source of truth, not chat context. Extract in this order:

1. Functional requirements (§7) — numbered, atomic.
2. Acceptance criteria (§13) — drive per-task success criteria.
3. Non-functional requirements (§8) — scope each NFR to the task(s) that touch it.
4. Scope includes/excludes (§4) — excludes are hard constraints.
5. Repo surface (§ header) — paths the PRD already identified.
6. Repo conventions (§14) — carry forward into per-task constraints.

If the file is missing or sections are empty, say so and call `generate-prd` to complete it. Don't guess.

## Step 2 — Map requirements to real code (browzer)

For each touched area, query browzer **before** assigning files. This is what makes decomposition accurate, not aspirational.

**Staleness gate (run first).** Same three-signal protocol as `generate-prd` Step 1:

1. `browzer status --json` → `workspace.lastSyncCommit` is a SHA → diff via `git rev-list --count <sha>..HEAD`. Most precise.
2. `lastSyncCommit` is `null`/missing → fire warning unconditionally with `N = unknown`.
3. Any later browzer call writes `⚠ Index N commits behind. Run \`browzer sync\`.` to stderr → if not yet surfaced this turn, surface now using the `N` from stderr.

If drift > ~10 commits (or `N = unknown`), surface exactly one line and proceed:

> ⚠ Browzer index is N commits behind HEAD. Recommended: invoke `Skill(skill: "sync-workspace")` before continuing for higher-fidelity context. Continuing anyway — file paths and `importedBy` lists may be stale.

Don't auto-run `sync-workspace`. Don't block. Surface once per skill invocation. If surfaced, append `; ⚠ index N commits behind HEAD` to the confirmation line at the end.

```bash
browzer status --json 2>&1                      # capture lastSyncCommit; keep stderr for signal 3
git rev-parse HEAD                              # for diff in signal 1

# What exists in each touched surface? — 2>&1 so signal 3 is observable
browzer explore "<area keyword>" --json --save /tmp/task-explore-<area>.json 2>&1

# For files likely modified, what imports them? (blast radius)
browzer deps "<path/from/explore.ts>" --reverse --json --save /tmp/task-deps.json 2>&1

# Architecture docs constraining the solution
browzer search "<topic>" --json --save /tmp/task-search.json 2>&1

# Surface repo invariants if PRD didn't list them
browzer search "invariants conventions CLAUDE" --json --save /tmp/task-conventions.json
```

Cap browzer queries at **4–5 total**. From results, extract per target file:

- Exact path (never invent — use what `explore` returned).
- `exports` / `imports` / `importedBy` — decides who consumes a new symbol and which task owns the consumer.
- Line ranges for the function/block the task will touch.
- From `search`: any "must" / "never" / "always" / "invariant" phrasing → per-task constraints (Rule 6).

If browzer returns nothing for a critical area, note as task-level assumption ("file does not yet exist — task creates it") — don't fabricate a path matching plausible folder convention.

**Invariant fallback** (when conventions search returns empty): the doc index may not cover the target repo's `CLAUDE.md`-style docs. Fall back to direct reads:

1. `Read('CLAUDE.md')` at repo root.
2. `Read('AGENTS.md')` and `Read('CONTRIBUTING.md')` if present.
3. For each path under `apps/<name>/...` or `packages/<name>/...` returned by `explore`, attempt `Read('apps/<name>/CLAUDE.md')` / `Read('packages/<name>/CLAUDE.md')`. Stop after 5 successful reads.

For every file read, scan for "must" / "never" / "always" / "invariant" / "MUST" / "NEVER" and surface matching lines as candidate invariants. Cite with file path + line range, identical to `browzer search` citation format.

If neither browzer search nor fallback surfaces anything, only then state at top of task list: "No repo invariant document detected — tasks inherit only generic rules."

## Step 3 — Group atoms into tasks

Apply rules in order. Rule 1 wins over Rule 2, etc.

**Rule 1 — Layer order.** Lower layers ship before higher consumers:

1. **Shared / foundation** — cross-cutting types, constants, env helpers, i18n keys, feature flags.
2. **Contracts** — job/message/queue schemas, event shapes, API contract types.
3. **Data layer** — schema, migrations, ORM models, indexes.
4. **Domain / core logic** — pure business logic consumed by multiple surfaces.
5. **Server / API** — routes, handlers, controllers, server actions.
6. **Async / workers** — background jobs, schedulers, consumers, cron.
7. **Client / UI** — components, pages, hooks, state.
8. **Tests** — unit → integration → e2e.
9. **Observability + docs** — traces, metrics, dashboards, runbooks, README/CLAUDE.md updates.
10. **Edge / ingress** — CDN, gateway, reverse-proxy. Last so public surface only turns on when everything behind it is ready.

Skip layers that don't exist in this repo. No workers → skip 6. No separate gateway → merge 10 into 5.

**Rule 2 — ~30-file soft cap per task.** If a natural group exceeds 30, split on the boundary one layer up/down. Treat as a signal to split, not a hard limit — a cohesive 32-file task beats two artificial half-tasks.

**Rule 3 — Orphan-free.** A new symbol (type, schema, route, job name, i18n key, flag) ships in the same task as its first consumer, **or** in an earlier task that a later task explicitly depends on. Never the reverse.

**Rule 4 — Merge-safe on main.** Each task, merged in order, leaves the repo runnable: quality gates pass, no broken imports, no orphaned migrations, no UI pointing at routes that don't exist (use feature flags).

**Rule 5 — Forward dependencies only.** Task N may only depend on tasks with index < N.

**Rule 6 — Repo invariants as per-task constraints.** Every "must" / "never" / "always" / "invariant" surfaced by Step 2 gets carried into the Non-functional section of every task touching that area. Don't paraphrase — quote and cite (e.g. `CLAUDE.md §5`). Look for: cross-cutting invariants, security/authz patterns, contract patterns between services, test/quality-gate requirements, compliance constraints. If repo has no such doc, state once at top: "No repo invariant document detected." Don't fabricate invariants.

**Rule 7 — Delivered value per task.** Each task ends with something demoable: passing test, curl against new endpoint, rendered page behind flag, CLI flag that runs. Reject "types added with no consumer in same task".

**Rule 8 — Merging is the default; splitting requires justification.** The ~30-file cap in Rule 2 is the UPPER bound. This rule governs the LOWER bound AND the default disposition:

- **Target median files-per-task: ≥ 10. Preferred: ≥ 15** for non-trivial feature sets (PRDs with ≥15 total files in scope).
- **When two same-package tasks are both under the ~30-file soft cap, merge them unless one of the split-preserving conditions below holds.** Default is merge, not split.

Split-preserving conditions (at least ONE must hold to keep two tasks separate that would otherwise merge under the cap):

- (a) **Incompatible invariants**: the two scopes touch different invariant families (e.g. one is billing/quota, one is auth/session) where mixing would widen the blast radius on a regression.
- (b) **Different suggested-model tier**: one task needs `opus` (novel, high-uncertainty work), the other `haiku` (deterministic boilerplate). Ceremony cost differs; merging forces the whole task onto the more expensive tier.
- (c) **Opposite reversibility profiles**: one is reversible (code edit, flag toggle), the other is not (destructive migration, data delete). Keeping them split means the irreversible half can land alone and be validated before the other ships.
- (d) **Merged scope would exceed the ~30-file soft cap.**

**Cross-layer merges require a feature-flag gate.** A task that touches both `server/api` and `client/UI` (Rule 1 layers 5 and 7), or `data` and `server/api` (layers 3 and 5), must declare the feature flag name in its Implementation notes so partial landing (e.g. migration + API ship before UI unmasks) still satisfies Rule 4 (merge-safe on main). If no feature-flag boundary is available, DO NOT merge across layers.

**Trivial-solo exception.** If a task's scope is < 3 files AND no same-layer neighbour exists to merge into, keep the task solo and mark it with the trivial flag (next section) so downstream execution skips per-task ceremony overhead.

Rationale: the per-task execution ceremony (TDD → execute → verify → commit) has a fixed floor cost per task regardless of scope — subagent dispatch, baseline capture, blast-radius check, separate commit. That overhead only pays off when a task carries ≥10 files OR a unique invariant. A longer list of 3-file atoms burns the same overhead for strictly less value per task. When a feature's task set ends up with >30% tasks flagged trivial, the PRD should have been scoped differently — surface that to the operator rather than emit the set.

**The trivial flag.** Add a task-level flag `**Trivial:** true` in the task header (see template) to signal that downstream execution can skip the per-task ceremony: `execute-task` / `orchestrate-task-delivery` use an inline edit path, no TDD red-green cycle, no mutation-testing verification, no separate `update-docs` call. Valid ONLY when the task spec is: single layer, single package, ≤3 files, no cross-invariant, deterministic outcome (rename, constant split, one-line config, regex replacement). Default: `**Trivial:** false`. Never add the flag to tasks touching authz, billing, migrations, or any file the repo's invariant document (CLAUDE.md / AGENTS.md / equivalent) names as "invariant-bearing".

## Step 4 — Write files to disk

Before writing any `TASK_NN.md`, ensure the feat folder's `.meta/` subdir exists and write the activation receipt. `$FEAT_DIR` itself already exists (created by `generate-prd`) — you only need `.meta/`.

```bash
mkdir -p "$FEAT_DIR/.meta"
```

**Activation receipt** — write to `$FEAT_DIR/.meta/activation-receipt.json` immediately after `mkdir`:

```json
{
  "skill": "generate-task",
  "invokedAt": "<ISO 8601 timestamp at invocation>",
  "featDir": "<$FEAT_DIR, e.g. docs/browzer/feat-20260420-user-auth-device-flow>",
  "taskCount": <integer N, the number of TASK_NN.md files about to be written>,
  "invariantSource": "<path to CLAUDE.md / AGENTS.md / etc., or \"none\" if not detected>",
  "baseline": "pending"
}
```

Purpose: post-hoc evidence that `generate-task` actually ran (vs. simulated inline by a caller who read SKILL.md but never invoked `Skill(skill: "generate-task")`). A retro or test harness can `ls docs/browzer/feat-*/.meta/activation-receipt.json` to distinguish real runs from simulations. The orchestrator (or whoever runs the baseline handshake) updates `baseline` to `"green"` / `"red"` / `"skipped"` once the gate resolves; until then it reads `"pending"`. Re-invoking `generate-task` against the same `$FEAT_DIR` overwrites the receipt — expected, idempotent.

For each task, assemble its full block using the template below, then **Write** it to `$FEAT_DIR/TASK_NN.md` (one file per task, `NN` zero-padded to two digits). File-first is the contract; do NOT emit task bodies to chat.

### Task block template (on-disk shape)

```markdown
# Task plan for [Feature name]

**Workflow stage:** generate-task (2/6) · previous: `generate-prd` · next: `execute-task`
**PRD source:** `<$FEAT_DIR/PRD.md>` · **Repo surface:** [paths from PRD header]
**Invariant source:** [path(s) from `browzer search`, or "none detected"]

---

## TASK_01 — [imperative title]

**Layer:** [shared | contracts | data | core | api | workers | client | tests | observability | docs | edge]
**Depends on:** [TASK_XX, or "none"]
**Trivial:** [true | false] — if true, downstream execution skips per-task ceremony (TDD/verify/separate docs update). See Rule 8 for when this is valid.
**Suggested model for `execute-task`:** [haiku | sonnet | opus] — [one-line reason]

### Scope — files (~30 soft cap)

| File | Action | Purpose | Source |
| ---- | ------ | ------- | ------ |
| `<exact/path/from/browzer>.ts` | create | What this file contains | n/a (new) |
| `<exact/path/from/browzer>.ts` | modify | What changes (lines 42–78) | `browzer explore` |

**Total: N files.**

### Success criteria

- [ ] 1. [Binary, testable — maps 1:1 to a PRD requirement or acceptance criterion]
- [ ] 2. [...]

### Non-functional requirements (scoped to this task)

- **Performance:** [concrete target, or `inherit from PRD §8`]
- **Security / authz:** [specific rule applied here, quoted from invariant doc]
- **Observability:** [what this task must emit]
- **Accessibility:** [only if UI — WCAG level + specifics]
- **Scalability / tenancy:** [or `n/a`]

### Repo invariants carried by this task

- [Quote of rule] — source: [file §]
- Or: `n/a — task touches no area with stated invariant.`

### Verification plan

**Baseline (before changes):** discover quality gates from `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`/`Makefile`/CLAUDE.md. Common shapes:

- Type check command — record pass/fail.
- Lint command — record pass/fail.
- Unit test command — record pass/fail + count.
- Build command — record pass/fail + bundle size if frontend.
- Domain-specific: `curl -sSI <endpoint>`, screenshot, schema snapshot, current metric.

**Post-change:** all baseline commands must pass at least as well. Add one check per success criterion (1:1) with exact command/request/UI action. Include any PRD perf benchmark.

**MCP checks (only if applicable):** note browser MCPs (playwright/chrome-devtools) for UI verification, or shell-only fallback.

### Implementation notes for `execute-task`

- **Sub-area:** [database, endpoints, queues, security, components, pages, ui/ux, a11y, perf, shared, test, docker, review, …]
- **Skills to load in subagents:** [matching skills installed alongside this plugin; omit if unknown]
- **Patterns to mirror:** [file paths + line ranges from `browzer explore`]
- **Reuse hints:** [existing helper/component/hook in this repo]

### Pre-execution verification (optional)

Use ONLY when task scope rests on an assumption `execute-task` MUST verify before dispatching — typically when Step 2 surfaced evidence work may already be shipped, or a file you assumed exists/doesn't-exist is actually the opposite. Format as 3-tuple:

- **Assumption:** [the claim, e.g. "`saveItemsBatch` does not yet exist in `item-store.ts`"]
- **Verify via:** [exact command, e.g. "`Read('src/store/item-store.ts')` — search for `saveItemsBatch`"]
- **If holds → proceed.** If fails → [concrete adjustment, e.g. "drop file X from Scope; reduce success criterion 2 to no-op verification"]

If no assumption needs verification, write `n/a — task scope is exact` and skip. Don't use for routine "subagent reads CLAUDE.md" — that's already part of `execute-task` Phase 1.

---

## TASK_02 — ...

[Same block shape. Repeat per task.]
```

**Model guidance for the `Suggested model` column:**

- **haiku-tier**: doc rewrites, runbook / new `.md` file writes, append-only doc edits, single-file deterministic regen, 1-file reformat, single-symbol lookups, "verify this commit landed" one-shots, inline glue extracted per the <15-line cap.
- **sonnet** (default): implementation, migration, route, test, single-service refactor.
- **opus**: multi-service refactor, security audit, novel bug whose root cause is non-obvious after 15 minutes of direct investigation.

## Validation before finalizing

Reject any task that fails:

- [ ] `$FEAT_DIR/TASK_NN.md` exists for every task (file-handoff sanity check — no skipped writes).
- [ ] `$FEAT_DIR/.meta/activation-receipt.json` exists.
- [ ] File count within ~30 soft cap (or justified exception).
- [ ] No file path appears in more than one task (silent edit conflict killer).
- [ ] Every "create" has its first consumer in same task or explicitly later task that depends on it.
- [ ] Every Task N's `depends on` contains only numbers < N.
- [ ] Baseline includes at minimum: type check, lint, test — using actual commands.
- [ ] Every success criterion is single testable assertion, not a bucket.
- [ ] Every invariant from Step 2 relevant to a task's scope is stated on that task.
- [ ] Layer order holds (no consumer before producer; no client-only task preceding the API it consumes unless behind a flag).

Reject the **whole task set** (not just one task) if any of the tiered thresholds below trips:

- [ ] **Total files ≥ 15 AND median files-per-task < 10 AND more than 50% of tasks are not flagged `Trivial: true`.** Typical case. Rule 8 was not applied aggressively enough — most PRDs of this size should consolidate to ≥10 files per task. Merge eligible tasks under Rule 8's default-merge rule and re-validate.
- [ ] **Total files ≥ 45 AND median files-per-task < 15.** Large PRDs should consolidate even further — median 15+ is the preferred target for feature sets of this size. If one of the split-preserving conditions (a-d) applies to every pair you might merge, state it inline so the operator can review before emitting.
- [ ] **More than 30% of tasks carry `Trivial: true`.** Scoping signal, not a Rule 8 violation: the PRD is a bag of loose trivial changes that should have been one task (or one ops ticket), not decomposed. Surface to the operator before emitting.

Fix in place before emitting. If can't fix without losing scope, say which PRD requirement causes the conflict and ask user.

## Output contract

After all files are written and validated, emit **one line**:

```
generate-task: wrote <N> TASK_NN.md files under <$FEAT_DIR>/; receipt at <$FEAT_DIR>/.meta/activation-receipt.json
```

With staleness warning (if the index drift gate fired in Step 2):

```
generate-task: wrote <N> TASK_NN.md files under <$FEAT_DIR>/; receipt at <$FEAT_DIR>/.meta/activation-receipt.json; ⚠ index N commits behind HEAD
```

On failure:

```
generate-task: failed — <one-line cause>
hint: <single actionable next step>
```

Nothing else. No summary table. No inline task bodies. No "Next steps" block. The operator reads task specs from disk; the orchestrator (`orchestrate-task-delivery`) picks up `$FEAT_DIR` from this confirmation line.

## Chain contract

If user replies "go" / "run 01" / "start" / "implement the first task", call `Skill(skill: "execute-task", args: "TASK_01 — spec at $FEAT_DIR/TASK_01.md")` (expand `$FEAT_DIR` to the literal path) so the next skill doesn't need to scan chat history.

## Non-negotiables

- **Output language: English.** Render task specs (headers, citations, scope tables, verification plans) in English regardless of operator's language. Conversational wrapper follows operator's language.
- Task specs are written to `$FEAT_DIR/TASK_NN.md` (one file per task) alongside the `PRD.md` from `generate-prd`. The files are the source of truth — never re-embed task bodies in chat.
- No "implementation details" belonging in `execute-task` (no code, no full function bodies, no exact SQL — paths, line ranges, one-line purpose).
- Don't invent paths — if `explore` found nothing, say "file to be created" and mark convention-based with a note.
- Don't over-split. Rule 8 is load-bearing: two same-layer/same-constraint/same-package tasks under cap = one task. When in doubt, merge — a task set of right-sized tasks always beats a longer list of atoms because the per-task ceremony has a fixed floor that dominates the actual work cost on trivial tasks.
- Don't invent invariants. If neither `browzer search` nor fallback surfaces it, don't impose it.

## Related skills

- `generate-prd` — previous step; source of the spec.
- `execute-task` — next step; runs one task end-to-end.
- `update-docs`, `commit`, `sync-workspace` — close out workflow once `execute-task` is green.
- `orchestrate-task-delivery` — master router that drives the full chain.
