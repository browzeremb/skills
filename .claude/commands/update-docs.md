---
name: update-docs
description: "Find every markdown doc whose accuracy depends on the just-changed code and patch it in place. Three signals: `browzer mentions` reverse traversal, direct-path-refs in markdown, and concept-level docs (CLAUDE.md invariants, ADRs, runbooks, READMEs) via `browzer deps --reverse` + `explore` + `search`. Patches existing docs only — never writes new ones. Triggers: update the docs, sync the documentation, docs are stale, refresh the README, propagate changes to docs, 'we changed X — what docs cover X'."
argument-hint: "[files: <paths>; feat dir: <path>]"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(date *), Bash(ls *), Bash(test *), Bash(jq *), Bash(mv *), Read, Edit, Write, AskUserQuestion
---

# update-docs — keep documentation in sync with a change

Step 7 of the workflow. Runs AFTER `write-tests` stabilises tests and BEFORE `feature-acceptance` / `commit`. Single responsibility: find every markdown file whose accuracy depends on the code that just changed, and patch it. Writes `STEP_<NN>_UPDATE_DOCS` to `workflow.json`.

**Two invocation paths:**

| Path | Who calls it | `files:` source |
|------|-------------|-----------------|
| **Orchestrated** | `orchestrate-task-delivery` after `write-tests` | Aggregated from task steps + receivingCodeReview + writeTests |
| **Standalone** | User says "update the docs" | Auto-derived via `git diff` against `main` |

All three signals (mentions + direct-ref + concept-level) **always run** regardless of invocation path. There is no per-run search budget. This is not a best-effort skill.

Output contract: emit ONE confirmation line on success.

## References router

| Topic | Reference |
| ----- | --------- |
| Phase 1a (mentions pass) + Phase 1 (direct-ref) + Phase 2 (concept-level) + anchor-doc audit + citation policy + Phase 0.4 enforcement | `references/three-signals.md` |
| workflow.json schema (`updateDocs`, step lifecycle, review gate) | `references/workflow-schema.md` |
| jq helpers (seed_step, complete_step, append_review_history, bump_completed_count) | `references/jq-helpers.sh` |

## Banned dispatch-prompt patterns

- `Read workflow.json` / `Edit workflow.json` / `Write workflow.json` — use `browzer workflow *` only.
- `Read docs/browzer/<feat>/<doc>` — use `browzer workflow get-step --field <jqpath>` or `--render <template>`.
- `twoPassRun: { directRef: false, conceptLevel: false, skipReason: "session budget" }` — silent downgrade is rejected. Batch queries instead (see `references/three-signals.md` §2.3).
- Patching docs beyond surgical scope (>25 lines or >2 sections) — record `verdict: "failed"` and stop.
- Introducing banned citation targets (feat folder paths, mutable doc paths, PR links) — see `references/three-signals.md` citation policy.

---

## Phase 0 — Resolve input

### 0.1 — File list

Preferred: explicit args from the caller.

```bash
FILES=$(browzer workflow query changed-files --workflow "$WORKFLOW" | jq -r '.[]')
```

Fallback (standalone):

```bash
BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo "HEAD~1")
FILES=$(git diff --name-only "$BASE"..HEAD -- ':(exclude)*.md' ':(exclude)*.mdx' 2>/dev/null)
```

If the list is empty, stop — nothing to sync.

### 0.2 — Feat folder + workflow

Preferred: `feat dir:` in args. Fallback: `ls -1dt docs/browzer/feat-*/ | head -1`. If no feat folder, create `docs/browzer/feat-$(date -u +%Y%m%d)-standalone-update-docs/` and seed a v1 workflow.json skeleton per `references/workflow-schema.md` §2.

Set `WORKFLOW="$FEAT_DIR/workflow.json"`.

Derive step id:

```bash
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_UPDATE_DOCS"
```

Stamp `startedAt`:

```bash
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
seed_step "$STEP_ID" "UPDATE_DOCS" "docs"
```

### 0.3 — State in chat (one line, before Phase 1a)

```
update-docs: <F> files in scope; feat dir <FEAT_DIR>
```

---

## Phase 1a — Mentions pass

Run `browzer mentions` for each changed file. Apply decision matrix and fallback grep per `references/three-signals.md` §Phase 1a.

Aggregate into `updateDocs.docsMentioning[]`:

```jsonc
"docsMentioning": [
  { "sourceFile": "<changed-file>", "mentionedBy": [{ "doc": "<path>", "confidence": 0.92 }] }
]
```

Compute `confidence` as `chunkCount / maxChunkCount_per_file`. Docs above 0.5 are HIGH-confidence candidates.

## Phase 1 — Direct-ref pass

For EVERY changed file — full path + basename queries. See `references/three-signals.md` §Phase 1.

## Phase 2 — Concept-level pass

Extract concepts, search each, always include anchor docs. Merge all three pools.

See `references/three-signals.md` §Phase 2 for the full concept-extraction and anchor-doc always-include rules.

**Emit anchor-doc audit on every run** (even `[]`):

```jsonc
"anchorDocsAlwaysIncluded": [
  { "doc": "docs/CHANGELOG.md", "source": "repo-root-changelog", "disposition": "auto-included-fresh" }
]
```

## Phase 3 — Classify each candidate

Read each candidate doc and classify:

| Classification  | When | Action |
| --------------- | ---- | ------ |
| `needs-patch`   | Doc asserts something the change made untrue | Edit specific lines; `verdict: "applied"` |
| `needs-append`  | Doc's structure invites a new entry the change creates | Append/insert; `verdict: "applied"` |
| `stale-but-oos` | Doc is stale OUTSIDE this change's scope | Don't patch; `verdict: "skipped"` + reason |
| `not-stale`     | Doc mentions the area but is still accurate | Don't patch; not recorded |
| `false-positive`| Keyword hit, different thing | Don't patch; not recorded |

When in doubt between `needs-patch` and `stale-but-oos`, prefer `stale-but-oos`.

## Phase 4 — Patch (two-pass discipline)

Use `Edit` to change only specific lines that went stale. Preserve the rest verbatim.

Rules:
- Never regenerate a whole section unless the entire section describes behaviour that no longer exists.
- Preserve the doc's voice, examples, and formatting.
- Don't add "updated on <date>" footers unless the doc already has one.
- When closing a `TECHNICAL_DEBTS.md` item, check the box + append the commit SHA in existing format.
- If a patch exceeds ~25 lines or spans >2 sections: record `verdict: "failed"`, reason `"patch exceeded surgical scope; needs human review"` and stop.

See `references/three-signals.md` §Citation policy and §CHANGELOG entries for citation rules.

## Phase 0.4 — Three-signal contract enforcement

**BEFORE Phase 5's final write**, validate both signals ran:

```bash
DIRECT=$(echo "$UPDATE_DOCS_PAYLOAD" | jq -r '.twoPassRun.directRef')
CONCEPT=$(echo "$UPDATE_DOCS_PAYLOAD" | jq -r '.twoPassRun.conceptLevel')

if [ "$DIRECT" != "true" ] || [ "$CONCEPT" != "true" ]; then
  echo "update-docs: stopped — three-signal contract violated"
  echo "hint: twoPassRun.directRef=$DIRECT conceptLevel=$CONCEPT — batch the three signal queries instead of skipping; see references/three-signals.md §2.3"
  exit 1
fi
```

This is non-optional. Silent downgrade (recording `skipReason: "session budget"`) is rejected.

## Phase 5 — Write STEP_<NN>_UPDATE_DOCS to workflow.json

Assemble the payload:

```jsonc
{
  "docsMentioning": [...],
  "anchorDocsAlwaysIncluded": [...],
  "patches": [
    { "doc": "...", "reason": "...", "linesChanged": 12, "verdict": "applied|skipped|failed", "notes": null }
  ],
  "twoPassRun": { "directRef": true, "conceptLevel": true }
}
```

Write via helper:

```bash
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
complete_step "$STEP_ID" "$UPDATE_DOCS_PAYLOAD"
bump_completed_count
```

### 5.1 — Review gate (when `config.mode == "review"`)

Flip status to `AWAITING_REVIEW`. Render `references/renderers/update-docs.jq` to `/tmp/review-$STEP_ID.md`. Show to operator: Approve / Adjust / Skip / Stop. On Adjust, translate operator edits to jq ops on `.updateDocs.patches`, re-render, loop, append to `reviewHistory[]`.

## Phase 6 — One-line confirmation

Success:
```
update-docs: updated workflow.json <STEP_ID>; patches <applied>/<total>; status COMPLETED
```

Failure:
```
update-docs: stopped at <STEP_ID> — <one-line cause>
hint: <single actionable next step>
```

No inline list of patched files. No diff preview. The JSON on disk is the artefact.

---

## What update-docs does NOT do

- Does not write new docs (use `generate-task` / `execute-task`).
- Does not re-run quality gates.
- Does not commit (`commit` is the last phase).
- Does not format prose.

## Non-negotiables

- Three signals always run: mentions + direct-ref + concept-level. No budget cap.
- Phase 0.4 enforcement fires before every Phase 5 write.
- `workflow.json` mutated ONLY via `browzer workflow *`. Never with `Read`/`Write`/`Edit`.

---

## Related skills and references

- `references/three-signals.md` — three-signal passes, anchor-doc audit, citation policy, Phase 0.4 enforcement.
- `references/workflow-schema.md` — authoritative schema for `updateDocs`.
- `references/renderers/update-docs.jq` — markdown renderer invoked in review mode.
- `generate-task`, `execute-task`, `receiving-code-review`, `write-tests` — prior phases.
- `commit` — next phase; consumes this step's record without re-probing.

## Render-template surface

`commit` and `feature-acceptance` consume a compressed summary via `browzer workflow get-step <step-id> --render update-docs`. Emits one screen: anchor docs disposition, patches applied/skipped/failed, two-pass run signals.
