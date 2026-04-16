---
name: task
description: "Step 2 of dev workflow (prd → task → execute → commit → sync). Decomposes a PRD (already in conversation, from `prd` skill or pasted) into an ordered list of mergeable, PR-sized engineering tasks directly executable by the `execute` skill. Uses `browzer explore`/`deps`/`search` to map each PRD requirement to real files and surface repo invariants from `CLAUDE.md`/ADRs. Enforces layer-ordered grouping (shared types → data → server → workers → client → tests → docs), orphan-free rule (producers ship with consumers), ~30-file soft cap per task, forward-only dependencies, merge-safety (each task leaves repo runnable). Use when user says 'break this PRD into tasks', 'generate tasks', 'plan the implementation', 'split this into PRs', 'give me a task list', 'decompose this spec', 'how should I sequence this work', or right after `prd` finishes. Also for informal requirement lists — call `prd` first if a proper spec is missing. Emits an inline numbered task list (no file writes) with per-task scope, dependencies, success criteria, verification plan, NFRs — direct input for `execute`."
allowed-tools: Bash(browzer *), Bash(git *), Read
---

# task — decompose a PRD into ordered, executable tasks (inline)

Step 2 of `prd → task → execute → commit → sync`. Reads the PRD from conversation context and emits a numbered task list **in chat**. The next skill (`execute`) picks one task and runs it. Nothing written to disk.

You are a staff engineer breaking a spec into mergeable PR-sized tasks for **the repo this skill is invoked from**. You don't assume framework, monorepo shape, or test runner — you discover them. Every task must be directly runnable by `execute` with zero additional discovery.

## Inputs

- **Primary:** PRD emitted by `prd` skill earlier in this conversation.
- **Fallbacks:** (1) user pastes/links a PRD, (2) free-form description. In both cases call `Skill(skill: "prd")` first — don't decompose against a shapeless request.

## Step 1 — Read PRD, extract atoms

In this order:

1. Functional requirements (§7) — numbered, atomic.
2. Acceptance criteria (§13) — drive per-task success criteria.
3. Non-functional requirements (§8) — scope each NFR to the task(s) that touch it.
4. Scope includes/excludes (§4) — excludes are hard constraints.
5. Repo surface (§ header) — paths the PRD already identified.
6. Repo conventions (§14) — carry forward into per-task constraints.

If any are missing, say so and call `prd` to complete it. Don't guess.

## Step 2 — Map requirements to real code (browzer)

For each touched area, query browzer **before** assigning files. This is what makes decomposition accurate, not aspirational.

**Staleness gate (run first).** Same three-signal protocol as `prd` Step 1:

1. `browzer status --json` → `workspace.lastSyncCommit` is a SHA → diff via `git rev-list --count <sha>..HEAD`. Most precise.
2. `lastSyncCommit` is `null`/missing → fire warning unconditionally with `N = unknown`.
3. Any later browzer call writes `⚠ Index N commits behind. Run \`browzer sync\`.` to stderr → if not yet surfaced this turn, surface now using the `N` from stderr.

If drift > ~10 commits (or `N = unknown`), surface exactly one line and proceed:

> ⚠ Browzer index is N commits behind HEAD. Recommended: invoke `Skill(skill: "sync")` before continuing for higher-fidelity context. Continuing anyway — file paths and `importedBy` lists may be stale.

Don't auto-run `sync`. Don't block. Surface once per skill invocation.

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

## Step 4 — Emit the task list (inline, this exact structure)

```markdown
# Task plan for [Feature name]

**Workflow stage:** task (2/5) · previous: `prd` · next: `execute`
**PRD source:** in-conversation (from `prd` skill) · **Repo surface:** [paths from PRD header]
**Invariant source:** [path(s) from `browzer search`, or "none detected"]

## Summary

| #   | Title | Layer | Files | Depends on | Key deliverable | Suggested model |
| --- | ----- | ----- | ----- | ---------- | --------------- | --------------- |
| 01  | …     | shared| N     | none       | …               | haiku/sonnet    |
| 02  | …     | data  | N     | 01         | …               | sonnet          |
| 03  | …     | api   | N     | 01, 02     | …               | sonnet          |

Total: K tasks, ~F files, layered per Rule 1.

---

## TASK_01 — [imperative title]

**Layer:** [shared | contracts | data | core | api | workers | client | tests | observability | docs | edge]
**Depends on:** [TASK_XX, or "none"]
**Suggested model for `execute`:** [haiku | sonnet | opus] — [one-line reason]

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

### Implementation notes for `execute`

- **Sub-area:** [database, endpoints, queues, security, components, pages, ui/ux, a11y, perf, shared, test, docker, review, …]
- **Skills to load in subagents:** [matching skills installed alongside this plugin; omit if unknown]
- **Patterns to mirror:** [file paths + line ranges from `browzer explore`]
- **Reuse hints:** [existing helper/component/hook in this repo]

### Pre-execution verification (optional)

Use ONLY when task scope rests on an assumption `execute` MUST verify before dispatching — typically when Step 2 surfaced evidence work may already be shipped, or a file you assumed exists/doesn't-exist is actually the opposite. Format as 3-tuple:

- **Assumption:** [the claim, e.g. "`saveItemsBatch` does not yet exist in `item-store.ts`"]
- **Verify via:** [exact command, e.g. "`Read('src/store/item-store.ts')` — search for `saveItemsBatch`"]
- **If holds → proceed.** If fails → [concrete adjustment, e.g. "drop file X from Scope; reduce success criterion 2 to no-op verification"]

If no assumption needs verification, write `n/a — task scope is exact` and skip. Don't use for routine "subagent reads CLAUDE.md" — that's already part of `execute` Phase 1.

---

## TASK_02 — ...

[Same block shape. Repeat per task.]
```

## Validation before finalizing

Reject any task that fails:

- [ ] File count within ~30 soft cap (or justified exception).
- [ ] No file path appears in more than one task (silent edit conflict killer).
- [ ] Every "create" has its first consumer in same task or explicitly later task that depends on it.
- [ ] Every Task N's `depends on` contains only numbers < N.
- [ ] Baseline includes at minimum: type check, lint, test — using actual commands.
- [ ] Every success criterion is single testable assertion, not a bucket.
- [ ] Every invariant from Step 2 relevant to a task's scope is stated on that task.
- [ ] Layer order holds (no consumer before producer; no client-only task preceding the API it consumes unless behind a flag).

Fix in place before emitting. If can't fix without losing scope, say which PRD requirement causes the conflict and ask user.

## Chain contract

After emitting:

> **Task plan ready (K tasks).** Invoke `execute` with task number (e.g. `execute TASK_01`) to implement first one. Tasks stay in conversation context — `execute` reads from here, no file handoff.

If user replies "go" / "run 01" / "start" / "implement the first task", call `Skill(skill: "execute")` with target task number.

## Invocation modes

- **Via `browzer` agent:** invoked automatically after `prd` completes or when user asks to plan an existing spec.
- **Standalone:** user invokes with PRD pasted/described inline. If no PRD present, call `Skill(skill: "prd")` first.

## Non-negotiables

- **Output language: English.** Render the task list (summary table, per-task blocks, headers, citations) in English regardless of operator's language. Conversational wrapper follows operator's language. Keeps `execute` consumption unambiguous.
- No file writes. Task list lives in chat.
- No "implementation details" belonging in `execute` (no code, no full function bodies, no exact SQL — paths, line ranges, one-line purpose).
- Don't invent paths — if `explore` found nothing, say "file to be created" and mark convention-based with a note.
- Don't over-split. Two same-layer/same-constraint/same-package tasks under cap = one task.
- Don't invent invariants. If neither `browzer search` nor fallback surfaces it, don't impose it.

## Related skills

- `prd` — previous step; source of the spec.
- `execute` — next step; runs one task end-to-end.
- `commit`, `sync` — close out workflow once `execute` is green.
