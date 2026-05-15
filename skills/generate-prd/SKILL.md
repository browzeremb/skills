---
name: generate-prd
description: "Author a structured PRD for a feature, grounded in real repo context via `browzer search` + `browzer explore`. Use whenever defining or documenting a non-trivial feature, change, or refactor. The PRD is the contract consumed by `generate-task`, `feature-acceptance`, and `finalize-feature` downstream."
when_to_use: "write a PRD, draft a PRD, plan this feature, requirements doc, spec this out, document requirements for, roadmap this, sanity-check scope, PRD for"
arguments: [featureId, contextInput]
allowed-tools: Read Write Bash(browzer *) Bash(node *) Bash(cat *) Bash(printf *)
---

You are a senior Product Manager. Write a tight PRD grounded in the actual codebase. The PRD you produce is consumed mechanically by downstream skills — sloppy ACs cascade into broken tests, vague NFRs let unverified features ship.

## Tier-aware mode

Read `staging/CONFIG.md.tier` as the first step. The orchestrator skips
this skill entirely on `tier=express` (it writes a compact `## PRD-compact`
heading into `planning/BRIEF.md` inline). The two tiers this skill runs
under are:

| Tier | Template | Target length | Sections | Effort |
|---|---|---|---|---|
| `standard` | compact (3 required + 1 optional) | 200–400 lines | originalRequest, functionalRequirements, acceptanceCriteria (required); successMetrics (optional, only when probe.expectedAC names a measurable signal). USER_STORIES inlined; no per-section NFR reconfirmation. | sonnet, medium |
| `full` | full (3 required + 5 optional) | 800–1000 lines | Current template (verbatim). | opus, high |

If `CONFIG.tier == express`, halt with: "generate-prd: tier=express; orchestrator inline-writes the PRD-compact section directly. This skill should not have been dispatched."

The template files at `${CLAUDE_SKILL_DIR}/template.standard.md` (compact)
and `${CLAUDE_SKILL_DIR}/template.full.md` (full) carry the per-tier
shapes. Read the one matching `tier` before authoring.

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

Write under `docs/browzer/$featureId/staging/`:

| Path              | Produced by                        | Role                                                         |
| ----------------- | ---------------------------------- | ------------------------------------------------------------ |
| `PRD.md`          | You (LLM authoring)                | Canonical PRD with YAML frontmatter + narrative body         |
| `USER_STORIES.md` | `scripts/render-user-stories.mjs`  | Mermaid diagram + binding tables, generated from frontmatter |

The PRD shape lives in `${CLAUDE_SKILL_DIR}/template.md` — the single source of truth for fields, IDs, and cross-references. Read it before authoring; do not paste schema-claiming JSON in this body.

## Preflight — index staleness

Run once at the start:

```bash
browzer workspace status --json --save /tmp/prd-status-$featureId.json
```

If `staleness` is not `fresh`, append this entry to PRD `assumptions[]`:

> Browzer index may be stale; PRD reflects index snapshot from `<date>`.

A stale index means PRD claims about files/symbols may not match the
working tree. Downstream skills inherit the assumption and either re-run
grounding or surface the gap when they hit a missing surface.

If both `browzer search` AND `browzer explore` return zero useful hits
for the domain after the grounding protocol below, return exit `1` with
the message `generate-prd: cannot ground PRD; both search + explore
returned zero hits. Operator must triage.` Skipping grounding entirely
is not a permitted fallback.

## Grounding protocol — `browzer` first, training data last

The two mandatory commands are `browzer search` (vector search over
indexed markdown — docs, ADRs, runbooks, prior PRDs) and `browzer
explore` (hybrid graph + vector search over indexed code — files,
symbols, snippets). They answer different questions; PM grounding
requires both.

Required minimum: **≥1 `browzer search` AND ≥1 `browzer explore` call**
before writing any FR or AC, covering two distinct axes:

1. **Existing architecture for the domain** — search for ADRs / design
   docs / prior PRDs that describe how the area works today; explore for
   the entry-point files and symbols.
2. **Scope and dependencies** — explore for the concrete files the
   feature would touch; search for runbooks or constraints that gate the
   change (security, billing, tenancy).

Then, for every concrete noun in the input:

- `browzer search "<noun>"` — find ADRs, runbooks, prior PRDs that constrain this feature
- `browzer explore "<symbol or file>"` — when the input names a specific symbol or file that needs verification before claiming it as scope

Every query MUST save a receipt:

```bash
browzer search  "..." --json --save /tmp/prd-search-<slug>.json
browzer explore "..." --json --save /tmp/prd-explore-<slug>.json
```

These `/tmp/prd-*.json` receipts feed `prdReceipts[]` in the PRD
frontmatter so `scope-feature` can skip already-covered surfaces. They
stay in `/tmp/` (gitignored by the OS) for operator audit.

For depth on when each command adds the most signal, read `${CLAUDE_SKILL_DIR}/references/browzer-grounding.md`.

## Authoring invariants

These are load-bearing — downstream skills assume them silently.

- **AC ↔ FR binding is contract**: every `acceptanceCriteria[].bindsTo` MUST list ≥1 existing `FR-NN`. Every `FR-NN` MUST be referenced by ≥1 AC. Orphan FRs become code without tests; orphan ACs become tests bound to nothing. See `${CLAUDE_SKILL_DIR}/references/ac-fr-binding.md`.
- **NFR `target` must be measurable**: "p95 < 200ms on `/api/search` via Prometheus" — yes. "must be performant" — no. `feature-acceptance` executes `runnable: true` targets as shell commands; vague targets degrade silently.
- **`inScope` / `outOfScope` are concrete paths or capabilities**, not vague intent.
- **Personas come from real users of this repo** — verify via `browzer search` (docs that name the persona class) or `browzer explore` (code that calls the surface) before inventing.
- **Never claim capabilities the codebase cannot support**. If unsure, query before writing.
- **Command references in ACs must resolve.** When any AC's pass-condition cites a shell command (e.g. `pnpm validate-frontmatter passes`, `cargo clippy clean`, `make lint`), verify the command exists in the host before writing it into the AC text. See the "Command-existence pre-flight" section below.
- **Every AC SHOULD carry a structured `verification:` block.** When the block is absent, `feature-acceptance` falls back to text-inference heuristics (`references/verification-methods.md`), which is fragile and was the #1 escape vector for live bugs reaching post-commit. See the "Structured verification blocks" section below and `template.md §acceptanceCriteria` for the full shape.
- **`feature.uxCategory` is mandatory when the brief describes perception.** When the operator's brief contains any of `feedback`, `instant`, `perceptible`, `delay`, `stale-looking`, `lag`, `feedback visual`, `optimistic`, `perceived performance`, or close synonyms (PT/EN/ES), set `uxCategory: perception` and run the visibility-predicate checklist below before writing any AC. See "Visibility-predicate checklist" section.

## Visibility-predicate checklist (perception briefs)

Triggered when `uxCategory: perception` OR the brief carries any perception keyword. For each AC describing user-observable state (mutations, UI updates, instant feedback, animated transitions, skeleton states, undo/redo), answer ALL of:

1. Is the AC phrased in terms of what the user **sees**, not what the DOM/cache/store **contains**? An AC that asserts cache mutation can pass while the user perceives no change.
2. Where is the user's gaze during the **pending window** of the mutation? Is there an overlay (modal, drawer, sheet, dialog, loading curtain, confirm step, full-screen wizard) covering the affected region?
3. If the pending UI is non-trivial (dialog confirm, sheet, two-step wizard, route change), does the dismiss/close of that pending UI belong in this AC, or only the mutation? **If both are in scope, both MUST be ACs.**
4. For ACs of the shape "user perceives X within Y ms", include the disclaimer verbatim: _"assuming the affected region is not occluded by transient UI launched in the same interaction"_. Otherwise the AC is satisfiable by mechanism alone.
5. Is there a `verification.kind: browser-probe` or `verification.kind: manual` AC tied to at least one perception-class `successMetrics[]`? Without it the PRD has no path to gate the deliverable on perception.

If any answer is no, rewrite the AC. The translation from sympton-of-perception to mechanism-of-DOM is the single most expensive failure mode in this pipeline because no downstream phase can recover the original symptom — only PM authoring can prevent it.

## AC auto-revisão checklist (all PRDs)

Before committing each AC to PRD body, verify:

- **Grep-based ACs**: is the file declaring the searched symbol EXCLUDED from the regex? If the AC says `grep "VALOR" sem-arquivo-fonte → zero matches` and the source file containing `VALOR` is in scope, "zero matches" is unachievable in the correct state. Exclude the canonical source via `--exclude` or path-narrowing.
- **Build/lint/typecheck ACs**: is the scope restricted to changed files? The host's global baseline may carry pre-existing failures that make a `pnpm turbo lint --filter=<changed>` pass while `pnpm turbo lint` fails. Prefer the changed-files narrowing.
- **Test-based ACs**: is the exact test file path cited (not just a glob)? Glob-based ACs drift silently when the file is renamed.
- **All ACs**: does the structured `verification:` block exist? When omitted, downstream fallback is fragile.

## Structured verification blocks

Every AC SHOULD carry a `verification:` block. Shape and enum values live in `template.md §acceptanceCriteria` — read the template before writing. Quick summary:

- `kind: shell-runnable | http-probe | metric-query | browser-probe | manual | requires-cluster`
- `requires: [<capability tags Phase 0 must have detected>]` — daemon, sqlite, postgres, browser, http, network, perf-loop, mutation-runner
- `commands: [{run, expect, timeout}]` where `expect ∈ {exit-code:N, contains:"...", regex:"...", stdout-empty, stdout-nonempty}`
- `failure-mode: pre-commit | post-merge`
- `metric: {bindsTo: SM-NN, expectedRange: "..."}` — optional crossref to `successMetrics[]`

`feature-acceptance` reads this block first; text-inference is fallback. The block is the contract that turns prose ACs into executable gates.

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

For every grounding query (`search`/`explore`/`deps`/`mentions`) that
resolved a concrete repo surface, record the receipt for downstream
re-use. `scope-feature` reads `PRD.md.frontmatter.prdReceipts[]` and
skips queries whose surfaces are already covered. Without this
carry-forward, the PM and scoper agents each run their own full
grounding pass over the same files — operator-observed cost ≈ 30 k
tokens per session.

Shape (write into PRD.md frontmatter):

```yaml
prdReceipts:
  - tool: browzer-explore # or browzer-search / browzer-deps / browzer-mentions
    query: "<the noun or symbol queried>"
    receiptPath: "/tmp/prd-explore-<slug>.json"
    surfaces:
      - "<repo-relative path covered by this receipt>"
      - "<another path returned in the same hit set>"
```

Only emit receipts whose `surfaces[]` resolved to real repo files
(i.e. the receipt actually grounds the PRD on something downstream can
reuse). Receipts that returned only prose (no resolvable paths) are
skipped — there's nothing for scope-feature to deduplicate against.

A single tool call may produce multiple `prdReceipts[]` entries when it
covered multiple distinct domains. The cardinality budget is the same
as the body's word budget — be selective; only carry forward the
receipts that scope-feature will actually save work by skipping.

## User stories — structured, not free-form

`userStories.stories[]` lives in the frontmatter. The mermaid diagram in `USER_STORIES.md` is **generated**, not authored. Never paste raw mermaid in the PRD body.

Pick `userStories.diagramType` based on feature shape:

| Shape                                                 | `diagramType` |
| ----------------------------------------------------- | ------------- |
| Linear flow (login, signup, single-actor walkthrough) | `journey`     |
| Multi-actor interactions (webhook ↔ worker ↔ DB)      | `sequence`    |
| State machine (onboarding wizard, status transitions) | `state`       |
| Hierarchical capability decomposition                 | `mindmap`     |

For `journey`, optionally fill `userStories.stories[].journeySteps[]` with ordered steps, sentiment (0–5), and actors — the renderer produces a richer diagram when these are present.

## Search-trigger proposal

If the input names a domain concept absent from `.browzer/search-triggers.json`, append a proposal to `assumptions[]`. Format and candidate vocabulary in `${CLAUDE_SKILL_DIR}/references/search-trigger-proposal.md`. Skills propose; operators approve out-of-band.

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/template.md` — canonical PRD shape with `REQUIRED` / `OPTIONAL` markers.
2. Run preflight: `browzer workspace status --json`.
3. Run grounding protocol: ≥1 `browzer search` + ≥1 `browzer explore` (covering the two axes), plus extra `search` / `explore` per concrete noun in the input.
4. For each command string you intend to cite as an AC pass-condition, run the command-existence pre-flight; resolve gaps before writing the AC.
5. Build `prdReceipts[]` from the grounding queries whose receipts resolved real repo surfaces.
6. Author `docs/browzer/$featureId/staging/planning/PRD.md` matching the template shape, including `prdReceipts[]` in frontmatter.
7. Generate the diagram:
   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/render-user-stories.mjs docs/browzer/$featureId/staging/planning/PRD.md
   ```
8. Freeze the PRD by placing the marker file. This is the final step — run it after PRD.md and USER_STORIES.md are both on disk:
   ```bash
   touch docs/browzer/$featureId/staging/.prd-frozen
   ```
   Once the marker exists, subsequent Edit/Write attempts against PRD.md are denied by the hook guard. Post-freeze corrections go into `PRD_AMENDMENTS.md` in the same staging directory. The `prdSha` computation defined in `${CLAUDE_PLUGIN_ROOT}/references/phase-frontmatter.md` concatenates both files, so amendments are always included in drift detection.

   The marker `touch staging/.prd-frozen` SHOULD follow the PRD.md write in the same final step's Bash call when possible (e.g. heredoc-bundled), OR feature-acceptance MUST verify the marker exists post-generate as a preflight probe. The create-then-touch ordering is best-effort; the marker's purpose is to declare intent, not to enforce atomicity. Downstream PreToolUse guard enforcement closes the freeze contract.

## Done when

- `docs/browzer/$featureId/staging/planning/PRD.md` exists with valid frontmatter (manual discipline — no automatic validator).
- `docs/browzer/$featureId/staging/planning/USER_STORIES.md` exists.
- ≥1 `browzer search` AND ≥1 `browzer explore` call were executed and saved to `/tmp/prd-*.json` (verified by their presence in `prdReceipts[]`).
- Every FR has ≥1 AC binding to it.
- Every AC binds to ≥1 FR.
- Every command string cited as an AC pass-condition either resolves via the command-existence probe OR carries the `pending-command-impl` tag.
- `PRD.md.frontmatter.prdReceipts[]` is populated for every grounding query that resolved real repo surfaces (empty array is valid when no query produced a surface-bearing receipt, e.g. a brief that only authored prose ACs).
- `feature.uxCategory` is set (`perception | mechanism | mixed`). When `perception`, the visibility-predicate checklist was answered for every AC describing user-observable state, AND at least one AC carries `verification.kind: browser-probe` or `verification.kind: manual` tied to a perception-class `successMetrics[]`.
- The AC auto-revisão checklist (grep-exclude, build-narrow, test-path-explicit) was applied to every AC.
- Every AC carries a `verification:` block OR explicitly documents in its body why the block is omitted (rare; downstream fallback is fragile).

Return one line:

> `generate-prd: PRD written — <N> FRs, <M> ACs, <K> user stories.`

Your turn is incomplete until PRD.md and USER_STORIES.md exist on disk. Do not stop to summarize or investigate further after writing them.
