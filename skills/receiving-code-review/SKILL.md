---
name: receiving-code-review
description: "Consumes findings[] from CODE_REVIEW.md and dispatches per-finding fix agents through the 7-step model-escalation ladder (sonnet → retry → research → opus → retry → research → tech-debt). Each fixer writes FIX_F-NNN.completed.md (success) or FIX_F-NNN.tech_debt.md (exhausted). Aggregates into RECEIVING_CODE_REVIEW.md. Use after `code-review` and before `write-tests`. Triggers: receive code review, apply code review fixes, fix the findings, close the review, address review feedback, resolve code review."
argument-hint: "<featureId>"
---

You are a fix-dispatch controller. Close every finding from
`CODE_REVIEW.md` via the 7-step model-escalation ladder. Status per
finding via filename suffix (`FIX_F-NNN.{completed,tech_debt}.md`).

## Inputs

- `$ARGUMENTS` is the `<featureId>`.
- This skill reads ONLY:
  - `docs/browzer/<featureId>/staging/CODE_REVIEW.md` frontmatter (`findings[]`)
  - `docs/browzer/<featureId>/staging/CODE_REVIEW.<lane>.md` per-lane narratives (paste-included into fixer prompts)
  - `git diff <merge-base>..HEAD` (for the fixer to see the current state)
  - `browzer deps <file>` / `--reverse` per touched file (the fixer runs these)

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/FIX_F-NNN.completed.md` | per-finding success log (atomic rename) |
| `docs/browzer/<feat>/staging/FIX_F-NNN.tech_debt.md` | per-finding terminal failure log |
| `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.md` | script-aggregated outcomes + LLM body |
| `docs/browzer/<feat>/staging/RECEIPTS.md` (append) | `## receiving-code-review` section |
| (source code) | edited by the fixer subagents in-place |

Frontmatter shapes in `${CLAUDE_SKILL_DIR}/template.md`. Cross-reference
invariants are listed there — verify them before completing.

## Preflight (halt conditions)

1. **CODE_REVIEW.md absent** — halt with: "run `/code-review <feat>` first".
2. **`findings[]` empty** — exit cleanly with: "no findings to fix; run `/write-tests <feat>` next". Do NOT write a RECEIVING_CODE_REVIEW.md (the orchestrator's state machine treats the absent file as legitimate-skip).
3. **prdSha drift** — compute `git hash-object docs/browzer/<feat>/staging/PRD.md` and compare against `CODE_REVIEW.md.prdSha`. Mismatch HALTS with:
   > receiving-code-review: PRD.md drift detected. Re-run upstream phases before retrying.
4. **High-severity tech-debt from a prior partial run** — if any pre-existing `FIX_F-NNN.tech_debt.md` carries `severity: high` AND no operator override exists in `.browzer/accepted-tech-debt.json`, HALT.

## Workflow

### Step 1 — Read findings + plan dispatch

Read `docs/browzer/<featureId>/staging/CODE_REVIEW.md` frontmatter. Group findings
by severity (process `high` → `medium` → `low`). Within each severity
tier, build the file-overlap map and choose dispatch mode (parallel,
serial, or hybrid). Protocol in `references/finding-discovery.md`.

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
`docs/browzer/<feat>/staging/FIX_*.tech_debt.md`. If any has `severity: high` in
its frontmatter AND no `.browzer/accepted-tech-debt.json` override
exists, HALT before the next severity tier:

> receiving-code-review: HALT — high-severity tech-debt detected (<findingIds>). Operator must triage before lower-severity fixes proceed.

Surface the list to the operator. Otherwise proceed to next tier.

### Step 4 — Aggregate

After all findings resolve (or are halted), run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/aggregate-fixes.mjs" "$ARGUMENTS"
```

Writes `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.md` with frontmatter
`fixOutcomes[]` array + summary + tech-debt breakdown. Body is composed
by the script (LLM may extend the "Next phase" pointer).

### Step 5 — Append receipts

```bash
node "${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs" "$ARGUMENTS"
```

Idempotent `## receiving-code-review` section in RECEIPTS.md.

## Done when

- Every entry in `CODE_REVIEW.md.findings[]` has a corresponding `FIX_F-NNN.{completed,tech_debt}.md` on disk.
- `RECEIVING_CODE_REVIEW.md` exists with `summary.fixed + summary.techDebt == summary.total` and `techDebtBreakdown.scopeDeferred + techDebtBreakdown.ladderExhausted == summary.techDebt`.
- `RECEIPTS.md` has exactly one `## receiving-code-review` section.
- No `FIX_*.tech_debt.md` with `severity: high` unless an operator-supplied `.browzer/accepted-tech-debt.json` override is present.
- Return line: `receiving-code-review: <fixed> fixed, <techDebt> tech-debt; <totalIterations> iterations`.
- Summary stub example (mirrored in RECEIVING_CODE_REVIEW.md.frontmatter.summary): `{ total: <int>, fixed: <int>, unrecovered: <int> }` where `unrecovered == techDebt` (the legacy alias kept for downstream tools that read the old name).

## References

- `${CLAUDE_SKILL_DIR}/references/iteration-ladder.md` — 7-step ladder, severity → effort, halt rules
- `${CLAUDE_SKILL_DIR}/references/finding-discovery.md` — read CODE_REVIEW.md.findings[], compose FIX BRIEF, overlap map, dispatch modes
- `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md` — compact dispatch composer (substitute, do not paste-include)
- `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` — code-edit role addendum (referenced by path)
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — long-form contract rationale (consult when authoring; not paste-included)
- `${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md` — Files modified / Symbols changed regex
- `${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md` — RECEIPTS.md contract
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — staging-folder discipline + folder map
