---
name: generate-prd
description: "Author a structured PRD for a feature, grounded in real repo context via `browzer ask|search|explore`. Use whenever defining or documenting a non-trivial feature, change, or refactor. The PRD is the contract consumed by `generate-task`, `feature-acceptance`, and `finalize-feature` downstream."
when_to_use: "write a PRD, draft a PRD, plan this feature, requirements doc, spec this out, document requirements for, roadmap this, sanity-check scope, PRD for"
arguments: [featureId, contextInput]
allowed-tools: Read Write Bash(browzer *) Bash(node *) Bash(cat *) Bash(printf *)
---

You are a senior PM. Write a tight PRD grounded in the actual codebase. The PRD you produce is consumed mechanically by downstream skills — sloppy ACs cascade into broken tests, vague NFRs let unverified features ship.

## Inputs

- `$featureId` — Stable feature identifier matching `^feat-[0-9]{8}-[a-z0-9-]+$`. Identifies `docs/browzer/<feat-id>/staging/`.
- `$contextInput` — Either a path to a `.md` file with the task description, or the description inline.

Load the operator's brief:

```!
if [ -f "$contextInput" ]; then
  cat "$contextInput"
else
  printf '%s\n' "$contextInput"
fi
```

## Output contract

Write three files under `docs/browzer/$featureId/staging/`:

| Path | Produced by | Role |
| --- | --- | --- |
| `PRD.md` | You (LLM authoring) | Canonical PRD with YAML frontmatter + narrative body |
| `USER_STORIES.md` | `scripts/render-user-stories.mjs` | Mermaid diagram + binding tables, generated from frontmatter |
| `RECEIPTS.md` | `scripts/consolidate-receipts.mjs` | Audit trail of every `browzer ask|search|explore` call |

The PRD shape lives in `${CLAUDE_SKILL_DIR}/template.md` — the single source of truth for fields, IDs, and cross-references. Read it before authoring; do not paste schema-claiming JSON in this body.

## Preflight — index staleness + ask-quota probe

Run once at the start:

```bash
browzer workspace status --json --save /tmp/prd-status-$featureId.json
```

If `staleness` is not `fresh`, append this entry to PRD `assumptions[]`:

> Browzer index may be stale; PRD reflects index snapshot from `<date>`.

Also fire a single low-cost `browzer ask` probe to detect a quota wall:

```bash
browzer ask "ping for quota check" --save /tmp/prd-quota-probe-$featureId.json --no-wait || true
```

If the probe response carries `error.kind: "quota-exhausted"` (or the
exit code is `5 — quota`), enter `--ask-degraded` mode for the rest of
this run: substitute every `browzer ask` call with the equivalent pair
`browzer search "..." --json --save /tmp/...` + `browzer explore "..."
--json --save /tmp/...` and, when the operator's brief names a specific
file or symbol, supplement with a direct `Read` of the cited path.
Append a single line to `assumptions[]`:

> `browzer ask` quota exhausted at PRD time; FR/AC grounded via search + explore + Read fallbacks. Re-run `/generate-prd` when quota refreshes if higher fidelity is required.

This degradation is acceptable only because the receipts trail (search +
explore JSON files saved to /tmp) still gives `RECEIPTS.md` an audit
chain. Skipping grounding entirely is NOT a permitted fallback — return
exit `1` with the message `generate-prd: cannot ground PRD; ask quota
exhausted AND both search + explore returned zero hits. Operator must
triage.`

## Grounding protocol — `browzer` first, training data last

Required minimum: **≥2 `browzer ask` calls** before writing any FR or AC
(or, in `--ask-degraded` mode, ≥2 `browzer search` + ≥2 `browzer
explore` calls covering the same axes). They must cover two distinct axes:

1. **Existing architecture for the domain** — "How does X work today in this repo?"
2. **Scope and dependencies** — "Which services or packages would feature Y touch?"

Then, for every concrete noun in the input:

- `browzer search "<noun>"` — find ADRs, runbooks, prior PRDs that constrain this feature
- `browzer explore "<symbol or file>"` — only when the input names something specific that needs verification before claiming it as scope

Every query MUST save a receipt:

```bash
browzer ask     "..." --save /tmp/prd-ask-<slug>.json
browzer search  "..." --save /tmp/prd-search-<slug>.json
browzer explore "..." --save /tmp/prd-explore-<slug>.json
```

`consolidate-receipts.mjs` aggregates these into `RECEIPTS.md` at the end.

For depth on when each command adds the most signal, read `${CLAUDE_SKILL_DIR}/references/browzer-grounding.md`.

## Authoring invariants

These are load-bearing — downstream skills assume them silently.

- **AC ↔ FR binding is contract**: every `acceptanceCriteria[].bindsTo` MUST list ≥1 existing `FR-NN`. Every `FR-NN` MUST be referenced by ≥1 AC. Orphan FRs become code without tests; orphan ACs become tests bound to nothing. See `${CLAUDE_SKILL_DIR}/references/ac-fr-binding.md`.
- **NFR `target` must be measurable**: "p95 < 200ms on `/api/search` via Prometheus" — yes. "must be performant" — no. `feature-acceptance` executes `runnable: true` targets as shell commands; vague targets degrade silently.
- **`inScope` / `outOfScope` are concrete paths or capabilities**, not vague intent.
- **Personas come from real users of this repo** — verify via `browzer ask` before inventing.
- **Never claim capabilities the codebase cannot support**. If unsure, query before writing.
- **Command references in ACs must resolve.** When any AC's pass-condition cites a shell command (e.g. `pnpm validate-frontmatter passes`, `cargo clippy clean`, `make lint`), verify the command exists in the host before writing it into the AC text. See the "Command-existence pre-flight" section below.

## Command-existence pre-flight

Half of in-the-wild AC drift originates in PRD ACs that name commands
the host doesn't define. `feature-acceptance` will silently substitute
a fallback gate command at runtime — but the substitution is invisible
to the operator who later re-reads the PRD and wonders why the
authoritative gate is something else.

For every command string the PRD intends to cite as an AC pass-condition
(or as a metric-collection invocation), probe the host's manifests
before committing it to the PRD body:

```bash
# Run this probe BEFORE writing the AC. Substitute "$CMD" with the
# top-level binary name OR the script alias (e.g. "validate-frontmatter"
# for "pnpm validate-frontmatter", "test:scripts" for "pnpm test:scripts").
CMD="<top-level-script-alias-or-binary-name>"

# 1. Node manifest scripts.
jq -e --arg c "$CMD" '.scripts[$c] // empty' package.json 2>/dev/null

# 2. Workspace package scripts (monorepo).
fd -t f package.json apps packages 2>/dev/null \
  | xargs -I{} jq -e --arg c "$CMD" '.scripts[$c] // empty' {} 2>/dev/null

# 3. Makefile targets.
grep -E "^${CMD}:" Makefile makefile 2>/dev/null

# 4. Lefthook entries.
grep -E "^${CMD}:" lefthook.yml lefthook-local.yml 2>/dev/null

# 5. CI workflow YAML invocations.
rg --fixed-strings "$CMD" .github/workflows .gitea/workflows 2>/dev/null

# 6. Shell-binary existence (last-resort fallback for global tools).
command -v "$CMD" 2>/dev/null
```

If NONE of the six probes return a match, the command does not exist in
the host. Three options:

1. **Drop the command** — replace the AC pass-condition with a manual
   acceptance step ("Operator confirms X by inspecting Y").
2. **Substitute with an existing command** — find the closest match via
   `browzer search "<intent>"` and use the resolved alias.
3. **Note the gap** — keep the AC text but add a `pending-command-impl`
   tag to its frontmatter, signalling that the AC depends on a command
   the host doesn't yet ship. `feature-acceptance` skips `runnable:
   true` evaluation for tagged ACs.

Never write a command-citing AC without running the probe; runtime
substitution is acceptable for `feature-acceptance` but it should
surface a finding so the operator can correct the PRD post-merge.

## prdReceipts[] — emit for scope-feature carry-forward

For every grounding query (`ask`/`search`/`explore`/`deps`/`mentions`)
that resolved a concrete repo surface, record the receipt for downstream
re-use. `scope-feature` reads `PRD.md.frontmatter.prdReceipts[]` and
skips queries whose surfaces are already covered. Without this
carry-forward, the PM and scoper agents each run their own full
grounding pass over the same files — operator-observed cost ≈ 30 k
tokens per session.

Shape (write into PRD.md frontmatter):

```yaml
prdReceipts:
  - tool: browzer-explore                # or browzer-search / browzer-deps / browzer-ask / browzer-mentions
    query: "<the noun or symbol queried>"
    receiptPath: "/tmp/prd-explore-<slug>.json"
    surfaces:
      - "<repo-relative path covered by this receipt>"
      - "<another path returned in the same hit set>"
```

Only emit receipts whose `surfaces[]` resolved to real repo files
(i.e. the receipt actually grounds the PRD on something downstream can
reuse). `ask` receipts that returned only prose go in `RECEIPTS.md`
but NOT in `prdReceipts[]` — there's nothing for scope-feature to
deduplicate against.

A single tool call may produce multiple `prdReceipts[]` entries when it
covered multiple distinct domains. The cardinality budget is the same
as the body's word budget — be selective; only carry forward the
receipts that scope-feature will actually save work by skipping.

## User stories — structured, not free-form

`userStories.stories[]` lives in the frontmatter. The mermaid diagram in `USER_STORIES.md` is **generated**, not authored. Never paste raw mermaid in the PRD body.

Pick `userStories.diagramType` based on feature shape:

| Shape | `diagramType` |
| --- | --- |
| Linear flow (login, signup, single-actor walkthrough) | `journey` |
| Multi-actor interactions (webhook ↔ worker ↔ DB) | `sequence` |
| State machine (onboarding wizard, status transitions) | `state` |
| Hierarchical capability decomposition | `mindmap` |

For `journey`, optionally fill `userStories.stories[].journeySteps[]` with ordered steps, sentiment (0–5), and actors — the renderer produces a richer diagram when these are present.

## Search-trigger proposal

If the input names a domain concept absent from `.browzer/search-triggers.json`, append a proposal to `assumptions[]`. Format and candidate vocabulary in `${CLAUDE_SKILL_DIR}/references/search-trigger-proposal.md`. Skills propose; operators approve out-of-band.

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/template.md` — canonical PRD shape with `REQUIRED` / `OPTIONAL` markers.
2. Run preflight: `browzer workspace status --json` + `ask` quota probe.
3. Run grounding protocol: ≥2 `ask` calls, plus `search` / `explore` per noun.
4. For each command string you intend to cite as an AC pass-condition, run the command-existence pre-flight; resolve gaps before writing the AC.
5. Build `prdReceipts[]` from the grounding queries whose receipts resolved real repo surfaces.
6. Author `docs/browzer/$featureId/staging/PRD.md` matching the template shape, including `prdReceipts[]` in frontmatter.
7. Generate the diagram:
   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/render-user-stories.mjs docs/browzer/$featureId/staging/PRD.md
   ```
8. Consolidate receipts:
   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/consolidate-receipts.mjs $featureId
   ```

## Done when

- `docs/browzer/$featureId/staging/PRD.md` exists with valid frontmatter (manual discipline — no automatic validator).
- `docs/browzer/$featureId/staging/USER_STORIES.md` exists.
- `docs/browzer/$featureId/staging/RECEIPTS.md` exists with ≥2 `ask` entries.
- Every FR has ≥1 AC binding to it.
- Every AC binds to ≥1 FR.
- Every command string cited as an AC pass-condition either resolves via the command-existence probe OR carries the `pending-command-impl` tag.
- `PRD.md.frontmatter.prdReceipts[]` is populated for every grounding query that resolved real repo surfaces (empty array is valid when no query produced a surface-bearing receipt, e.g. a brief that only authored prose ACs).

Return one line:

> `generate-prd: PRD written — <N> FRs, <M> ACs, <K> user stories.`

Your turn is incomplete until all three files exist on disk. Do not stop to summarize or investigate further after writing them.
