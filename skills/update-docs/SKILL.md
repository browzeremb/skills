---
name: update-docs
description: "Step 6 of the dev workflow (… → fix-findings → update-docs → feature-acceptance → commit). Use after code stabilises to find every markdown file whose accuracy depends on the just-changed code and patch it. Runs three signals (always all three): (1) `browzer mentions` reverse traversal — File ← RELEVANT_TO ← Entity ← MENTIONS ← Chunk ← HAS_CHUNK ← Document; (2) direct-ref pass — markdown files literally naming the changed paths; (3) concept-level pass — docs that describe the area (CLAUDE.md invariants, runbooks, ADRs, READMEs) via `browzer deps --reverse` + `explore` + `search`. Budget-capped at 8 search calls (raise via --budget N for multi-service changes). Patches existing docs only — never writes new ones. Writes STEP_<NN>_UPDATE_DOCS to workflow.json. Triggers: 'update the docs', 'sync the documentation', 'docs are stale', 'we changed X — what docs cover X'."
argument-hint: "[files: <paths>; feat dir: <path>; --budget N]"
allowed-tools: Bash(browzer *), Bash(git *), Bash(date *), Bash(ls *), Bash(test *), Bash(jq *), Bash(mv *), Read, Edit, Write, AskUserQuestion
---

# update-docs — keep documentation in sync with a change

Step 6 of the workflow. Runs AFTER `fix-findings` stabilises the code and BEFORE `feature-acceptance` / `commit`. Single responsibility: find every markdown file whose accuracy depends on the code that just changed, and patch it. Writes `STEP_<NN>_UPDATE_DOCS` to `workflow.json`.

**Two invocation paths:**

| Path | Who calls it | `files:` source | `feat dir:` source |
|------|-------------|-----------------|-------------------|
| **Orchestrated** | `orchestrate-task-delivery` after `fix-findings` | Aggregated from `.task.execution.files.modified + .created` across task steps | From feat folder |
| **Standalone** | User says "update the docs" | Auto-derived via `git diff` against `main` | Newest `docs/browzer/feat-*/` or created on-the-fly |

All three signals (mentions + direct-ref + concept-level) **always run** regardless of invocation path. This is not a best-effort skill.

## Phase 0 — Resolve input

Determine (a) the list of changed files to sync docs for, (b) the feat folder + workflow.json, and (c) the budget.

### 0.1 — File list

Preferred: explicit args from the caller. The orchestrator aggregates from workflow.json:

```bash
FILES=$(jq -r '[.steps[] | select(.name=="TASK") | .task.execution.files.modified + .task.execution.files.created] | add | unique | .[]' "$WORKFLOW")
```

Fallback (standalone): auto-derive from git:

```bash
BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo "HEAD~1")
FILES=$(git diff --name-only "$BASE"..HEAD -- ':(exclude)*.md' ':(exclude)*.mdx' 2>/dev/null)
```

Exclusions: markdown files themselves. If the list is empty, stop — there is nothing to sync.

### 0.2 — Feat folder + workflow

Preferred: `feat dir:` in args. Fallback: newest `ls -1dt docs/browzer/feat-*/ | head -1`. If no feat folder exists, create `docs/browzer/feat-$(date -u +%Y%m%d)-standalone-update-docs/` and seed a v1 workflow.json skeleton per `references/workflow-schema.md` §2.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

Derive the step id:

```bash
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_UPDATE_DOCS"
```

### 0.3 — Budget

Default: 8 `browzer search` calls split across the passes. Override via `--budget N`. `browzer mentions`, `browzer deps`, and `browzer explore` are structural probes — they don't count against the search budget.

### 0.4 — State in chat (one line, before Phase 1a)

```
update-docs: <F> files in scope; budget <B>; feat dir <FEAT_DIR>
```

Not a summary — a cursor. So the operator can veto if `files:` is wrong.

## Phase 1a — Mentions pass (new in this redesign)

Before the text-based passes, use the graph-level reverse traversal. `browzer mentions <file>` returns indexed documents whose chunks mention the file via `File ← RELEVANT_TO ← Entity ← MENTIONS ← Chunk ← HAS_CHUNK ← Document`.

For each changed file:

```bash
browzer mentions "$FILE" --json --save "/tmp/mentions-$(basename "$FILE").json"
```

If `browzer mentions` errors (e.g. `Not found.` because the file is not in the indexed snapshot — common when the index lags HEAD by more than a handful of commits, or when the file was just created in this feature), do NOT block the phase. Fall back to a literal-grep pass over the canonical doc set and record the fallback in `updateDocs.warnings[]`:

```bash
# Fallback when `browzer mentions` returns Not found / errors:
grep -rln --include='*.md' "$(basename "$FILE")" docs apps/*/CLAUDE.md packages/*/CLAUDE.md CLAUDE.md README.md 2>/dev/null
```

Treat each grep hit as a `mentionedBy` entry with `confidence: 0.5` (no graph signal — assume medium confidence and let Phase 3 classification decide). Surface the fallback once in chat:

> ⚠ `browzer mentions` failed for N files (likely stale index — recommend `browzer sync`). Falling back to literal-grep over docs/, apps/*/CLAUDE.md, packages/*/CLAUDE.md.

Aggregate the results into the `updateDocs.docsMentioning[]` payload per schema §4:

```jsonc
docsMentioning: [
  {
    "sourceFile": "<changed-source-file>",
    "mentionedBy": [
      { "doc": "docs/runbooks/RBAC_OPERATIONS.md", "confidence": 0.92 },
      { "doc": "docs/SYSTEM_DESIGN_TARGET_STATE.md", "confidence": 0.81 }
    ]
  }
]
```

Compute `confidence` as `chunkCount / maxChunkCount_per_file` (normalise within each source file's returned mentions). Docs above a reasonable threshold (e.g. 0.5) are HIGH-confidence patch candidates for Phase 3.

Docs surfaced here join Phase 1 (direct-ref) and Phase 2 (concept-level) candidate pools at Phase 3 classification. The graph signal is complementary — it often catches documentation that describes the file by concept but doesn't cite it by path.

## Phase 1 — Direct-ref pass (budget ÷ 2 browzer search calls)

For each changed file, find markdown that literally names it:

```bash
# Full path — catches docs citing the changed file verbatim
browzer search "<full-path>" --json --save /tmp/update-docs-direct-1.json

# Basename only — catches docs citing auth.ts in context
browzer search "<basename>" --json --save /tmp/update-docs-direct-2.json
```

For each hit:

1. Deduplicate by `documentName` across all queries.
2. Drop hits inside the feat folder itself.
3. Drop hits inside any subtree marked historical/archived (`retrospectives/`, `archive/`, `history/`, `old/`, `status: archived` frontmatter, `.archive-root` / `ARCHIVED.md` markers).
4. The remainder is the Pass-1 candidate list.

Stop Pass 1 when `budget÷2` is consumed or all changed files have been searched.

## Phase 2 — Concept-level pass (budget ÷ 2 browzer search calls)

Docs don't always name the file that changed; they describe the *area*. This pass catches those.

### 2.1 — Extract concepts

- **Nearest `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md`** walking up from each changed file.
- **Consumers from `browzer deps --reverse`** — for every changed file:

  ```bash
  browzer deps "$FILE" --reverse --json --save /tmp/update-docs-deps-<slug>.json
  ```

  The `importedBy` list gives real blast-radius — the CLAUDE.md / README.md / runbook next to those consumers is a high-signal candidate.
- **Symbol-level hits from `browzer explore`** — when the changed file exports a named symbol:

  ```bash
  browzer explore "<symbol>" --json --save /tmp/update-docs-symbol-<slug>.json
  ```
- **Package / app name** — strip the path down to the package or feature segment (e.g. `<root>/<package>/<area>/...` → `<package>`, `<area>`).
- **Module / layer** — `src/middleware/...` → "middleware", `src/routes/...` → "routes", `src/repos/...` → "repositories".
- **Purpose inferred from filename** — `auth.ts` → "authentication", `rbac.ts` → "authorization", `session.ts` → "session management".

Dedupe the concept list.

### 2.2 — Search concepts + anchor docs

For each distinct concept:

```bash
browzer search "<concept>" --json --save /tmp/update-docs-concept-<slug>.json
```

Also always include (known paths, no search cost):

- Every `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` walking up from each changed file's directory.
- Every `CLAUDE.md` / `AGENTS.md` / `README.md` next to a direct importer returned by `browzer deps --reverse`.
- Any `TECHNICAL_DEBTS.md`, `DEBTS.md`, `ROADMAP.md`, `CHANGELOG.md` at the repo root, if the change closes an item tracked there.
- Any `README.md` along the change's directory path if the change alters something user-visible (public API, CLI flag, env var, port, command).

Stop Pass 2 when `budget÷2` is consumed.

### 2.3 — Merge candidate pools

Dedupe across Phase 1a (mentions), Phase 1 (direct-ref), Phase 2 (concept-level). A doc that appears in two pools is still one candidate; prefer the higher-confidence signal when classifying.

## Phase 3 — Classify each candidate

For each candidate, `Read` the doc and decide:

| Classification  | When                                                                                                 | Action                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `needs-patch`   | The doc asserts something the change made untrue (wrong path, wrong API shape, wrong behavior, wrong env var, wrong command). | Edit the specific lines. Record in `patches[]` with `verdict: "applied"`. |
| `needs-append`  | The doc's structure invites a new entry that the change creates (a new invariant, a new runbook step, a new env var section, a closed debt). | Append or insert. Record in `patches[]` with `verdict: "applied"`. |
| `stale-but-oos` | The doc is stale OUTSIDE this change's scope. | Don't patch. Record in `patches[]` with `verdict: "skipped"` + reason. |
| `not-stale`     | The doc mentions the area but is still accurate. | Don't patch. (Not recorded in `patches[]`.) |
| `false-positive` | Keyword hit but the doc is about a different thing with the same word. | Don't patch. (Not recorded.) |

When in doubt between `needs-patch` and `stale-but-oos`, prefer `stale-but-oos`. Patching beyond your lane makes the commit bigger and harder to revert.

## Phase 4 — Patch (two-pass discipline + mentions)

For each `needs-patch` / `needs-append` candidate, use `Edit` to change only the specific lines that went stale. Preserve the rest of the doc verbatim.

Rules:

- Never regenerate a whole section unless the entire section is about behavior that no longer exists.
- Preserve the doc's voice, examples, and formatting (indentation, list style, table shape).
- Don't add "updated on <date>" footers unless the doc already has one. Git history is the audit trail.
- When closing a `TECHNICAL_DEBTS.md` item, check the box + append the commit SHA in the existing format; don't rewrite the whole entry.

If a patch exceeds ~25 lines or spans >2 sections, STOP and record it in `patches[]` with `verdict: "failed"` + `reason: "patch exceeded surgical scope; needs human review"`. The skill's value is reliable small mechanical updates; big doc rewrites should go through `generate-task` → `execute-task`.

## Phase 5 — Write STEP_<NN>_UPDATE_DOCS to workflow.json

Assemble the `updateDocs` payload per schema §4:

```jsonc
{
  "docsMentioning": [
    { "sourceFile": "...", "mentionedBy": [{ "doc": "...", "confidence": 0.92 }] }
  ],
  "patches": [
    { "doc": "...", "reason": "...", "linesChanged": 12, "verdict": "applied|skipped|failed" }
  ],
  "budgetUsed": 7,
  "budgetMax": 8,
  "twoPassRun": { "directRef": true, "conceptLevel": true }
}
```

Append the step via jq + atomic rename:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STEP=$(jq -n \
  --arg id "$STEP_ID" \
  --arg now "$NOW" \
  --argjson updateDocs "$UPDATE_DOCS_PAYLOAD" \
  '{
     stepId: $id,
     name: "UPDATE_DOCS",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "post-fix-findings sync" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0,
     itDependsOn: [],
     nextStep: null,
     skillsToInvoke: ["update-docs"],
     skillsInvoked: ["update-docs"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     updateDocs: $updateDocs
   }')

jq --argjson step "$STEP" \
   --arg now "$NOW" \
   '.steps += [$step]
    | .currentStepId = $step.stepId
    | .totalSteps = (.steps | length)
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

### 5.1 — Review gate (when `config.mode == "review"`)

Before setting the step to COMPLETED, if `.config.mode == "review"`:

- Flip status to `AWAITING_REVIEW`.
- Render `references/renderers/update-docs.jq` to `/tmp/review-$STEP_ID.md`.
- Show to operator via `AskUserQuestion`: Approve / Adjust / Skip / Stop.
- On Adjust: translate operator edits to jq ops on `.steps[] | select(.stepId==$id) | .updateDocs.patches` (e.g. "skip patch to docs/runbooks/foo.md" → mark that patch's `verdict: "skipped"`). Re-render and loop. Append each round to `reviewHistory[]`.

## Phase 6 — One-line confirmation

Success:

```
update-docs: updated workflow.json <STEP_ID>; patches <applied>/<total>; status COMPLETED
```

Where `<applied>` = count of patches with `verdict: "applied"`, `<total>` = length of `patches[]`.

Warnings append with `;`:

```
update-docs: updated workflow.json STEP_05_UPDATE_DOCS; patches 3/5; status COMPLETED; ⚠ budget exhausted at 8 calls, 2 candidates unverified
```

Failure:

```
update-docs: stopped at <STEP_ID> — <one-line cause>
hint: <single actionable next step>
```

No inline list of patched files. No diff preview. The JSON on disk is the artefact; the chat line is the cursor.

## What update-docs does NOT do

- **Does not write new docs.** If a change adds a capability that has no doc yet, that's a task for `generate-task` / `execute-task`.
- **Does not update the source doc the session consumed.** If the session was driven by a retro or an action plan, the orchestrator's post-ship nudge handles that.
- **Does not re-run quality gates.** `execute-task` + `fix-findings` already did.
- **Does not commit.** `commit` is the last phase; it consumes this step's record without re-probing.
- **Does not format prose.** Preserve the doc's existing style.

## Invocation modes

- **Via `orchestrate-task-delivery`** — phase 6 of the pipeline (after fix-findings). Orchestrator aggregates `files:` from task executions and passes `feat dir:`.
- **Standalone** — user says "update the docs". Auto-derives file list from git.
- **Via `execute-task`'s tail** — for a single-task session, `execute-task` may invoke directly. Same contract.

## Non-negotiables

- **Output language: English.** JSON payload in English. Conversational wrapper follows operator's language.
- Don't rewrite whole sections for cosmetic reasons.
- Don't short-circuit any of the three signals (mentions + direct-ref + concept-level) when the skill succeeds.
- `workflow.json` is mutated ONLY via `jq | mv`. Never with `Read`/`Write`/`Edit`.

## Related skills and references

- `references/subagent-preamble.md` — the code-subagent brief (included for symmetry; update-docs may dispatch a subagent per-doc for very large candidate lists).
- `references/workflow-schema.md` — authoritative schema for `updateDocs`.
- `references/renderers/update-docs.jq` — markdown renderer invoked in review mode.
- `generate-task`, `execute-task`, `fix-findings` — prior phases; `update-docs` reads `.task.execution.files` to ground scope.
- `commit` — next phase; consumes this step's record without re-probing.
- `orchestrate-task-delivery` — coordinator; schedules `update-docs` after `fix-findings`.
