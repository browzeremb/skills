---
name: code-review
description: "Post-implementation team review of a feature's diff. Spawns 4 mandatory parallel reviewer lanes (senior-engineer, software-architect, qa, regression-tester) plus optional domain specialists discovered via /find-skills. Each lane writes CODE_REVIEW.<lane>.md; the dispatcher aggregates into CODE_REVIEW.md frontmatter via scripts/aggregate-findings.mjs. Read-only — receiving-code-review applies fixes next. Triggers: code review, review this feature, audit my changes, review the diff, post-implementation review, team review, peer review, find issues in this PR."
argument-hint: "<featureId>"
---

You are a code-review fan-out controller. Spawn 4 mandatory reviewer lanes
in parallel, gather per-lane findings, aggregate.

## Inputs

- `$ARGUMENTS` is the `<featureId>` matching `^feat-\d{8}-[a-z0-9-]+$`.
- The **SKILL body** (what you, the LLM, read) reads ONLY:
  - `docs/browzer/<featureId>/staging/REVIEW_CONTEXT.md` (script-rendered; carries diff + dep + symbols + `skillsFound[]`)
  - `docs/browzer/<featureId>/staging/TASK_*.completed.md` execution logs (frontmatter only — for the dispatch brief)
  - per-lane `CODE_REVIEW.<lane>.md` files (after lanes return)
- The **pre-render script** (`scripts/render-review-context.mjs`) reads
  upstream artefacts on the SKILL body's behalf so the body never needs
  to: `git diff <merge-base>..HEAD`, every `TASK_*.completed.md` body,
  `browzer deps --reverse <file>` per file, and
  `EXPLORATION.md.frontmatter.domains[].skillsFound[]` (aggregated into
  `REVIEW_CONTEXT.md.frontmatter.skillsFound[]`).
- This SKILL body NEVER reads `PRD.md`, `EXPLORATION.md`, or
  `workflow.json` directly. The pre-render script's reads do not violate
  closure — they are how the body's input artefact (`REVIEW_CONTEXT.md`)
  gets composed.

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/REVIEW_CONTEXT.md` | script-rendered (diff + deps + symbols) |
| `docs/browzer/<feat>/staging/CODE_REVIEW.<lane>.md` (× 4 + N) | LLM-authored per-lane reports |
| `docs/browzer/<feat>/staging/CODE_REVIEW.md` | script-aggregated findings frontmatter + LLM-authored body |
| `docs/browzer/<feat>/staging/REGRESSION_RESULTS.md` | regression-tester sidecar (optional) |
| `docs/browzer/<feat>/staging/RECEIPTS.md` (append) | `## code-review` section, idempotent |

Frontmatter shapes in `${CLAUDE_SKILL_DIR}/template.md`. Cross-reference
invariants are listed there — read the template before writing
`CODE_REVIEW.md` body.

## Preflight (halt conditions)

Before any review work:

1. **failed.md halt** — glob `docs/browzer/<featureId>/staging/TASK_*.failed.md`. If any match, HALT with:
   > code-review: cannot review — N task(s) failed. Triage each and re-run `/execute-task <feat> <taskId>` before retrying. Failed: <list>

2. **prdSha drift halt** — compute `git hash-object docs/browzer/<featureId>/staging/PRD.md` and compare against `prdSha` in every consumed `TASK_*.completed.md`. Mismatch HALTS with:
   > code-review: PRD.md was edited after task execution (sha drift). Re-run `/scope-feature <feat>` and `/generate-task <feat>` before retrying. Drift: TASK_XX carries prdSha=<old>, current PRD.md is <new>.

Both halts are documented in `references/diff-discovery.md`.

## Workflow

### Step 1 — Render REVIEW_CONTEXT.md

```bash
node "${CLAUDE_SKILL_DIR}/scripts/render-review-context.mjs" "$ARGUMENTS"
```

The script reads `git diff <merge-base>..HEAD`, parses every
`TASK_*.completed.md` execution log via the regex contracts in
`${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md`, and
runs `browzer deps --reverse` per changed file. Output:
`docs/browzer/<featureId>/staging/REVIEW_CONTEXT.md` (frontmatter +
human-readable body).

### Step 2 — Sensitive-path gate

Read `docs/browzer/<featureId>/staging/REVIEW_CONTEXT.md.frontmatter.changedFiles[].path`. For each file, evaluate the predicate at `${CLAUDE_PLUGIN_ROOT}/references/sensitive-paths.md` (globs + token-introduction rules).

- **Match** → all 4 mandatory lanes run regardless of diff size or markdown-only heuristic.
- **No match** → if 100% of changed files are `*.md` / `*.mdx` AND total LOC delta ≤ 50, route to a single-reviewer fast lane (consolidator handling senior-engineer + qa). Otherwise standard 4-mandatory lanes.
- **Fail-closed**: if the predicate cannot be evaluated for any reason, set `sensitivePathGate.matched = true` with all changed files and run the 4 mandatory lanes.

Record the gate decision in the aggregate `CODE_REVIEW.md` frontmatter under
`sensitivePathGate`.

### Step 3 — Specialist lane discovery

Read `docs/browzer/<featureId>/staging/REVIEW_CONTEXT.md.frontmatter.skillsFound[]`
(populated by the pre-render script from
`EXPLORATION.md.domains[].skillsFound[]`). For each `relevance == "high"`
entry, add a parallel specialist lane named after the skill (e.g.
`fastify-best-practices`, `react-performance`).

When `skillsFound[]` is absent or empty in REVIEW_CONTEXT.md, run the 4
mandatory lanes only — do NOT fall back to re-reading EXPLORATION.md
directly. Re-running `scope-feature` is the right escalation if the
operator believes a domain skill should be discovered.

**Single-domain carve-out**: when `skillsFound[]` resolves to exactly one
single-domain that the 4 mandatory lanes already cover (`infra-build`,
`docs`, `testing`), skip find-skills entirely for these domains —
`find-skills` re-invocation is redundant when domainCount == 1 and the
domain is one of the well-covered set.

### Step 4 — Dispatch reviewer lanes in parallel

For each lane (mandatory + specialist), compose a dispatch prompt using
the compact template at
`${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`:

- **Block 1 — role lead line**: `You are the <lane> reviewer for feature <featureId>. Produce CODE_REVIEW.<lane>.md.`
- **Block 2 — compact invariants**: substitute the seven-invariant template, filling `{{skills}}` from `REVIEW_CONTEXT.skillsFound[]` filtered to the lane's relevance, `{{files}}` from `REVIEW_CONTEXT.changedFiles[]`, `{{out-of-scope}}` = `["*"]` (reviewers are read-only by definition).
- **Block 3 — review-subagent addendum** (path reference only): one line directing the subagent to `${CLAUDE_PLUGIN_ROOT}/references/preambles/review-subagent.md`. Do NOT paste-include the file.
- **Block 4 — lane persona**: paste-include the lane's persona block from `${CLAUDE_SKILL_DIR}/references/lane-personas.md` (this IS paste-included — it is the lane-specific guidance and has no path-reference shortcut).
- **Block 5 — compact REVIEW_CONTEXT brief**: a per-lane projection of `REVIEW_CONTEXT.md.frontmatter` containing ONLY the fields this lane reads:
  - All lanes: `diffBase`, `changedFiles[].path` (no body), `changedSymbols[]` shaped `<scope> <kind> <id>`.
  - senior-engineer + software-architect: also `reverseDeps[<file>]` keyed by file (top-5).
  - qa: also `reverseDeps[]` (full set, for butterfly probe).
  - regression-tester: also `baselineFailures[]` from REGRESSION_RESULTS.md.
  - domain specialists: only the subset of changedFiles touching the specialist's domain.

  This compact brief replaces the previous "paste the entire REVIEW_CONTEXT.md verbatim into every lane" pattern — the full document was ~13k tokens × 4 lanes = ~40k tokens of redundant context.

- **Block 6 — snapshot invariant directive** (one line, verbatim):

  > Snapshot invariant: the diff and dep receipts above were pre-computed from merge-base `<diffBase SHA>` and inlined for your lens. Do NOT re-run `git diff` or `browzer deps` independently — use the inlined snapshot. Re-running produces redundant calls and may return diverging results if the branch advances.

- **Block 7 — return-shape footer**: the code-reviewer return-shape line from the compact template.

Spawn with `Agent(subagent_type: "browzer:code-reviewer", model: opus, effort: high, prompt: <composed>)`. The total composed prompt per lane is now ≈ 4–6k tokens (vs ≈ 16k pre-change).

The regression-tester lane is **non-collapsible**: it ALWAYS runs in
standard / sensitive-match flows; it MAY be skipped only in the
markdown-only fast lane (recorded as `gate: "all changed files are
markdown"` in its absent file's place, surfaced in CODE_REVIEW.md).

### Inline-return recovery (dispatcher fortification)

After every lane returns, glob `docs/browzer/<featureId>/staging/CODE_REVIEW.<lane>.md`
and verify that EACH lane you dispatched has its file on disk. When a
lane returned inline (i.e. its CODE_REVIEW.<lane>.md is absent but the
agent's stdout contains a `---`-bounded frontmatter block), DO NOT
silently skip the lane:

1. Extract the frontmatter + body verbatim from the agent's stdout.
2. Write it to `docs/browzer/<featureId>/staging/CODE_REVIEW.<lane>.md` via the
   Write tool — the dispatcher (this skill body, NOT the subagent) has
   the Write tool, so the operation always succeeds.
3. Record a single line in the aggregate `CODE_REVIEW.md` body's "Per-lane
   summary" subsection: `<lane> returned inline; dispatcher wrote
   CODE_REVIEW.<lane>.md from stdout.` This surfaces the contract drift
   so a future operator can investigate the per-run permission state.

When the agent's stdout does NOT contain a frontmatter block (no `---`
sentinel), treat the lane as failed: write a stub
`CODE_REVIEW.<lane>.md` carrying `findings: []` plus a `body:` field
explaining the dispatcher saw no parseable output, and continue.
Aggregation never blocks on a single lane.

### Step 5 — Aggregate findings

After all lane files land, run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/aggregate-findings.mjs" "$ARGUMENTS"
```

The script implements the preserve-all merge algorithm
(`references/finding-shape.md` documents it in full): groups by
`(file, line, ruleId)`, builds `mergedFrom[]`, assigns canonical
`F-NNN` IDs, populates `severityCounts`, never drops a finding.

The script writes the **frontmatter and verdict body** of
`docs/browzer/<featureId>/staging/CODE_REVIEW.md`. Your responsibility is to
extend the body with the per-lane summary, the orphan-findings
sub-section (when applicable), and the "Next phase" pointer per
`template.md`'s Section B body shape.

### Step 6 — Append receipts

```bash
node "${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs" "$ARGUMENTS"
```

Idempotent: re-runs produce exactly one `## code-review` section in
`RECEIPTS.md`. Contract in
`${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md`.

## Reviewer brief — closure intra-file

The dispatcher's per-lane prompt is the only context the reviewer sees.
Construct the brief verbatim — never link out to external paths. The
brief MUST include every field below; omitting any is a contract
violation:

```
REVIEWER BRIEF
  feature-id   : <feat>
  lane          : <lane-name>
  diff-range    : <diffBase SHA>..HEAD
  changed-files : <inlined from REVIEW_CONTEXT.md.changedFiles[]>
  changed-symbols: <inlined from REVIEW_CONTEXT.md.changedSymbols[]>
  reverse-deps  : <inlined per-file>
  skill-name    : <lane name when specialist; null otherwise>
```

Then paste-include the review-subagent preamble, the lane persona, and
the snapshot invariant directive. Then dispatch.

## Done when

- `REVIEW_CONTEXT.md` exists.
- Every dispatched lane has its `CODE_REVIEW.<lane>.md` on disk.
- `CODE_REVIEW.md` exists with frontmatter (script-populated) + body (LLM-authored).
- `RECEIPTS.md` has exactly one `## code-review` section.
- Return line on stdout: `code-review: <H> high, <M> medium, <L> low findings; gate=<pass|conditional|block>`.

The structured `findings[]` array in `CODE_REVIEW.md` is the canonical
handoff to `receiving-code-review`.

## References

- `${CLAUDE_SKILL_DIR}/references/lane-personas.md` — per-lane persona blocks (paste-included verbatim)
- `${CLAUDE_SKILL_DIR}/references/finding-shape.md` — `findings[]` schema, ID conventions, merge algorithm, pin discipline
- `${CLAUDE_SKILL_DIR}/references/butterfly-effect.md` — qa lane butterfly probe protocol (Phase 1 vs Phase 2 deferred)
- `${CLAUDE_SKILL_DIR}/references/diff-discovery.md` — merge-base resolution, halt rules
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer (substitute, do not paste-include)
- `${CLAUDE_PLUGIN_ROOT}/references/preambles/review-subagent.md` — review-lane role addendum (referenced by path, NOT paste-included)
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (consulted when authoring; not paste-included by this skill)
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — regex shapes the renderer parses
- `${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md` — RECEIPTS.md append contract
- `${CLAUDE_PLUGIN_ROOT}/references/sensitive-paths.md` — sensitive-path predicate (canonical)
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — staging-folder discipline + full layout map
