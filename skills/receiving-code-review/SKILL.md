---
name: receiving-code-review
description: "Consumes findings[] from review/CODE_REVIEW.md and dispatches per-finding fix agents through the 7-step model-escalation ladder (sonnet → retry → research → opus → retry → research → tech-debt). Each fixer writes fixes/F-NNN.completed.md (success) or fixes/F-NNN.tech_debt.md (exhausted). Aggregates into fixes/FIXES.md and in-place patches CODE_REVIEW.md.findings[].fixStatus; also writes the back-compat review/RECEIVING_CODE_REVIEW.md sidecar. Use after `code-review` and before `regression-guard`. Triggers: receive code review, apply code review fixes, fix the findings, close the review, address review feedback, resolve code review."
argument-hint: "<featureId>"
---

You are a fix-dispatch controller. Close every finding from
`review/CODE_REVIEW.md` via the 7-step model-escalation ladder. Status
per finding via filename suffix (`fixes/F-NNN.{completed,tech_debt}.md`).
The `FIX_F-` prefix is dropped — the `fixes/` subfolder gives the
namespace.

## Step 1 — Read CONFIG and clear regression-guard sentinel

Before any fixer dispatch, read `staging/CONFIG.md.tier` (this skill is
tier-agnostic; the value is recorded in the dispatch trace for telemetry).
Then **idempotently delete** any `staging/.regression-guard-rerun`
sentinel left over from the previous round (no error if absent). This
prevents the regression-guard loop from re-entering the same round via
a stale sentinel.

## Inputs

- `$ARGUMENTS` is the `<featureId>`.
- This skill reads ONLY:
  - `docs/browzer/<featureId>/staging/CONFIG.md` (frontmatter — tier + round counter)
  - `docs/browzer/<featureId>/staging/review/CODE_REVIEW.md` frontmatter (`findings[]`, including new round-2/3 findings emitted by regression-guard)
  - `docs/browzer/<featureId>/staging/review-lanes/CODE_REVIEW.<lane>.md` per-lane narratives (paste-included into fixer prompts)
  - `git diff <merge-base>..HEAD` (for the fixer to see the current state)
  - `browzer deps <file>` / `--reverse` per touched file (the fixer runs these)

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/fixes/F-NNN.completed.md` | per-finding success log (atomic rename); no `FIX_F-` prefix |
| `docs/browzer/<feat>/staging/fixes/F-NNN.tech_debt.md` | per-finding terminal failure log |
| `docs/browzer/<feat>/staging/fixes/FIXES.md` | aggregate index (primary output of `aggregate-fixes.mjs`) |
| `docs/browzer/<feat>/staging/review/RECEIVING_CODE_REVIEW.md` | back-compat sidecar (semantically a subset of FIXES.md; will be retired once finalize-feature switches over) |
| `docs/browzer/<feat>/staging/review/CODE_REVIEW.md` | in-place patched by aggregator — each `frontmatter.findings[].fixStatus` filled from the matching fix file |
| (source code) | edited by the fixer subagents in-place |

Frontmatter shapes in `${CLAUDE_SKILL_DIR}/template.md`. Cross-reference
invariants are listed there — verify them before completing.

## Preflight (halt conditions)

1. **CODE_REVIEW.md absent** — halt with: "run `/code-review <feat>` first".
2. **`findings[]` empty** — exit cleanly with: "no findings to fix; orchestrator state machine routes around receiving-code-review AND regression-guard, straight to `/feature-acceptance <feat>`." Do NOT write FIXES.md or RECEIVING_CODE_REVIEW.md (the state machine treats absent files as legitimate-skip).
3. **prdSha drift** — when `CONFIG.tier != express`, compute `git hash-object docs/browzer/<feat>/staging/planning/PRD.md` and compare against `CODE_REVIEW.md.prdSha`. Mismatch HALTS with:
   > receiving-code-review: PRD.md drift detected. Re-run upstream phases before retrying.
   When `CONFIG.tier == express`, no PRD exists; skip this check.
4. **High-severity tech-debt from a prior partial run** — if any pre-existing `fixes/F-NNN.tech_debt.md` carries `severity: high` AND no operator override exists in `.browzer/accepted-tech-debt.json`, HALT.
5. **HIGH-severity gate (operator visibility)** — when `CODE_REVIEW.md.frontmatter.severityCounts.high > 0` AND none of the following overrides is present, HALT before dispatching any fixer:
   - `.browzer/auto-apply-high.json` exists in the host (persistent operator opt-in for this repo)
   - `$ARGUMENTS` carries the literal flag `--approve-high` (single-session opt-in)
   - `CODE_REVIEW.md.frontmatter.severityPromotions` equals `severityCounts.high` (every HIGH was auto-promoted by the success-metric crossref, not lane-graded — in that case the operator already saw the promotions in the CODE_REVIEW.md body and the orchestrator continues)

   The HALT message MUST be:

   > receiving-code-review: `<N>` HIGH findings detected. Operator approval required before dispatching fixers. Review `docs/browzer/<feat>/staging/review/CODE_REVIEW.md` then either:
   >   (a) create `.browzer/auto-apply-high.json` (persistent), OR
   >   (b) re-invoke `/receiving-code-review <feat> --approve-high` (single-session).

   Rationale: HIGH findings are usually architectural / correctness-class
   work where the fix path is non-obvious. Auto-dispatching fixers
   without operator visibility means architectural decisions land
   without review. RETRO §2.4 + §3.13 documents the operator-side
   symptom (HIGH findings applied silently). The override files make
   the autonomous flow opt-in rather than opt-out.

## Workflow

### Step 1 — Read findings + plan dispatch

Read `docs/browzer/<featureId>/staging/review/CODE_REVIEW.md` frontmatter. Group findings
by severity (process `high` → `medium` → `low`). Within each severity
tier, build the file-overlap map per `references/finding-discovery.md`
and partition findings into **disjoint clusters** + **contested clusters**:

- A finding's **edit set** is the union of its `pinsFiles[]`. Two findings
  are in the same cluster when their edit sets intersect; otherwise they
  are file-disjoint.
- **Disjoint clusters** — every finding in a different cluster touches a
  non-overlapping file set. Dispatch ALL of them in parallel via multiple
  `Agent({ run_in_background: true })` calls in the same turn. The fixer
  contract emits its per-finding file as soon as its ladder resolves, so
  parallel dispatch does not need to coordinate post-merge.
- **Contested clusters** — findings within the same cluster MUST serialize.
  Process them sequentially within the cluster; dispatch the next one only
  when the prior FIX_*.completed.md is on disk (file-presence gate).

Pre-dispatch clustering is enforced by tool. Run `node ${CLAUDE_PLUGIN_ROOT}/skills/receiving-code-review/scripts/cluster-findings.mjs <findingsJson> --out <clustersJson>` before any fixer dispatch; consume the cluster manifest to batch coupled findings into the same dispatch wave.

### Step 2 — Dispatch fixers per finding

For each finding, compose a dispatch prompt using the compact template
at `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`:

- **Block 1 — role lead line**: `You are a post-review fixer for finding <findingId> in feature <featureId>. Close the finding through the escalation ladder.`
- **Block 2 — compact invariants**: substitute the seven-invariant template, filling `{{skills}}` from the finding's `assignedSkill` (single-element array; empty when null), `{{files}}` from `finding.pinsFiles[]`, `{{out-of-scope}}` from every other changed file (the fixer stays inside the finding's pinned files unless integration glue ≤15 LOC requires otherwise).
- **Block 3 — code-subagent addendum** (path reference only): one line directing the subagent to `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md`. Do NOT paste-include the file.
- **Block 4 — FIX BRIEF**: paste-include the canonical FIX BRIEF (see `references/finding-discovery.md` for shape), which carries the finding verbatim + the relevant excerpt from the corresponding `CODE_REVIEW.<lane>.md` body section.
- **Block 5 — return-shape footer**: the fixer return-shape line from the compact template ("Write FIX_<id>.completed.md or .tech_debt.md; return ONE LINE: fixer: <id> <fixed|tech_debt>; ladder=<N>; model=<sonnet|opus|null>").

Do NOT paste-include `subagent-preamble.md` or the corresponding
`CODE_REVIEW.<lane>.md` body section in its entirety — the relevant
slice belongs in the FIX BRIEF.

Spawn with:

```
Agent(
  subagent_type: "browzer:fixer",
  model: <sonnet for ladder steps 1-3, opus for 4-6>,
  effort: <xhigh/max for high severity, high/xhigh for medium/low>,
  prompt: <composed>,
)
```

The fixer subagent walks the 7-step ladder per
`${CLAUDE_SKILL_DIR}/references/iteration-ladder.md` and emits the
per-finding file as soon as its ladder resolves (binding
emit-on-completion contract — see `${CLAUDE_PLUGIN_ROOT}/agents/fixer.md`).

### Step 3 — Post-wave halt check

After each severity-tier wave completes, glob
`docs/browzer/<feat>/staging/fixes/F-*.tech_debt.md`. If any has `severity: high` in
its frontmatter AND no `.browzer/accepted-tech-debt.json` override
exists, HALT before the next severity tier:

> receiving-code-review: HALT — high-severity tech-debt detected (<findingIds>). Operator must triage before lower-severity fixes proceed.

Surface the list to the operator. Otherwise proceed to next tier.

### Step 4 — Aggregate

After all findings resolve (or are halted), run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/aggregate-fixes.mjs" "$ARGUMENTS"
```

Writes (single-writer aggregation):
- `docs/browzer/<feat>/staging/fixes/FIXES.md` — primary index with frontmatter `fixOutcomes[]` array + summary + tech-debt breakdown.
- `docs/browzer/<feat>/staging/review/RECEIVING_CODE_REVIEW.md` — back-compat sidecar (will be retired once finalize-feature switches over to FIXES.md).
- In-place patch of `staging/review/CODE_REVIEW.md.frontmatter.findings[].fixStatus` so downstream readers (judge, finalize) can see the closure status without joining files.

## Done when

- Every entry in `review/CODE_REVIEW.md.findings[]` has a corresponding `fixes/F-NNN.{completed,tech_debt}.md` on disk.
- `fixes/FIXES.md` exists with `summary.fixed + summary.techDebt == summary.total` and `techDebtBreakdown.scopeDeferred + techDebtBreakdown.ladderExhausted == summary.techDebt`.
- `review/CODE_REVIEW.md.frontmatter.findings[].fixStatus` is populated for every finding (in-place patch by `aggregate-fixes.mjs`).
- No `fixes/F-*.tech_debt.md` with `severity: high` unless an operator-supplied `.browzer/accepted-tech-debt.json` override is present.
- Return line: `receiving-code-review: <fixed> fixed, <techDebt> tech-debt; <totalIterations> iterations`.
- Summary stub (mirrored in FIXES.md.frontmatter.summary): `{ total: <int>, fixed: <int>, unrecovered: <int> }` where `unrecovered == techDebt` (legacy alias kept for downstream tools).

## PRD_AMENDMENTS rule

When a finding's fix requires adding, removing, or rewording an acceptance criterion or functional requirement in the PRD — rather than changing source code — do NOT attempt to edit `planning/PRD.md` directly. The file is frozen after `generate-prd` places the `.prd-frozen` marker. This rule applies only to standard/full tiers; in `CONFIG.tier == express` there is no PRD and the orchestrator's inline `## PRD-compact` heading in `planning/BRIEF.md` is the operator's domain — fixers do not patch it.

Instead, append to `staging/planning/PRD_AMENDMENTS.md`:

1. If `planning/PRD_AMENDMENTS.md` does not yet exist, create it with a minimal header.
2. Append one section per finding that requires a PRD change:
   ```markdown
   ## Amendment for finding <findingId>

   **AC / FR affected:** <id or plain description>
   **Change:** <what was wrong> → <corrected wording>
   **Rationale:** <one sentence linking this amendment to the review finding>
   ```
3. Record in `fixes/F-NNN.completed.md` that the fix was applied via PRD_AMENDMENTS.md (not via source edit).

The `prdSha` hash that downstream phases use for drift detection is computed from both files concatenated (`PRD.md` + `PRD_AMENDMENTS.md` when present). This rule is defined in `${CLAUDE_PLUGIN_ROOT}/references/phase-frontmatter.md` — read that file for the exact concatenation contract before computing or comparing any `prdSha`.

## References

- `${CLAUDE_SKILL_DIR}/references/iteration-ladder.md` — 7-step ladder, severity → effort, halt rules
- `${CLAUDE_SKILL_DIR}/references/finding-discovery.md` — read CODE_REVIEW.md.findings[], compose FIX BRIEF, overlap map, dispatch modes
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer (substitute, do not paste-include)
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-invariants.md` — operative invariants upstream source; read once per dispatch wave, never paste-included
- `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` — code-edit role addendum (referenced by path)
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (consult when authoring; not paste-included)
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — Files modified / Symbols changed regex
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — staging-folder discipline + folder map
- `${CLAUDE_PLUGIN_ROOT}/references/phase-frontmatter.md` — prdSha computation rule (PRD.md || PRD_AMENDMENTS.md concatenation contract)
