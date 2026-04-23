---
name: update-docs
description: "Step 4 of 6 in the dev workflow (generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace). Use after any code change lands — even if the user just says 'update the docs', 'sync the documentation', or 'our docs are stale'. Runs two passes: (1) direct-ref pass — finds markdown files that literally name the changed paths; (2) concept-level pass — finds docs that describe the area conceptually (CLAUDE.md invariants, runbooks, ADRs, READMEs) via browzer deps --reverse + explore + search. Both passes always run. Budget-capped at 8 browzer search calls by default (raise with --budget N for multi-service changes). Patches existing docs only — does not write new ones. Triggers: 'update the docs', 'sync the documentation', 'docs are stale', 'we changed X, what docs describe X?', or automatically when orchestrate-task-delivery reaches phase 4. Do NOT use for writing new docs (that's execute-task's job) or updating a retro/PRD that triggered the session (that's the orchestrator's post-ship nudge)."
argument-hint: "[files: <paths>; feat dir: <path>; --budget N]"
allowed-tools: Bash(browzer *), Bash(git *), Bash(date *), Bash(ls *), Bash(test *), Read, Edit, Write
---

# update-docs — keep documentation in sync with a change

Step 4 of 6 in the dev workflow. Runs after `execute-task` lands a change, before `commit`. Single responsibility: find every markdown file whose accuracy depends on the code that just changed, and patch it — nothing else. `commit` assumes `update-docs` already ran; committing without updated docs is the drift this skill prevents.

**Two invocation paths:**

| Path | Who calls it | `files:` source | `feat dir:` source |
|------|-------------|-----------------|-------------------|
| **Orchestrated** | `orchestrate-task-delivery` after each `execute-task` | Explicit from `HANDOFF_NN.json` | Explicit from feat folder |
| **Standalone** | User says "update the docs" | Auto-derived via `git diff` against `main` | Newest `docs/browzer/feat-*/` or created on-the-fly |

Both passes (direct-ref + concept-level) **always run** regardless of invocation path. This is not a best-effort skill.

## Phase 0 — Resolve input

Determine (a) the list of changed files to sync docs for, and (b) the feat folder where the report is written.

### 0.1 — File list

Preferred: explicit args from the caller.

```
Skill(skill: "update-docs", args: "files: apps/api/src/middleware/auth.ts apps/api/src/routes/protected.ts; feat dir: docs/browzer/feat-20260422-rbac-tighten/; --budget 8")
```

If the orchestrator is dispatching, it MUST pass `files:` explicitly — derived from the previous phase's HANDOFF (`gates.postChange` implies the file list is authoritative in `files.created` + `files.modified`). The orchestrator has the information; don't make `update-docs` re-derive it.

Fallback: auto-derive from git. Used when the user invokes standalone ("update the docs") and no orchestrator is threading context:

```bash
BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo "HEAD~1")
FILES=$(git diff --name-only "$BASE"..HEAD -- ':(exclude)*.md' ':(exclude)*.mdx' 2>/dev/null)
```

Exclusions: markdown files themselves (editing a doc doesn't create doc-sync pressure on itself). If the auto-derived list is empty, say so and stop — there is nothing to sync.

### 0.2 — Feat folder

Preferred: `feat dir:` in args (set by the orchestrator).

Fallback: newest feat folder matching the current session:

```bash
FEAT_DIR=$(ls -1dt docs/browzer/feat-*/ 2>/dev/null | head -1)
```

If no feat folder exists (standalone invocation on a repo that doesn't use the workflow), write the report to `docs/browzer/feat-$(date -u +%Y%m%d)-standalone-update-docs/.meta/UPDATE_DOCS_<timestamp>.json` — the folder is cheap and keeps the report discoverable.

### 0.3 — Budget

Default: 8 `browzer search` calls split across the two passes (4 + 4). Override via `--budget N` in args. The budget matters because each `browzer search` is a server round-trip and the skill runs inside a larger pipeline. A budget of 4 is enough for most 1–3 file changes; raise to 12 for multi-service refactors.

### 0.4 — State in chat (one line, before Phase 1)

```
update-docs: 3 files in scope; budget 8; feat dir docs/browzer/feat-20260422-rbac-tighten/
```

Not a summary, not a plan — a cursor. So the operator can veto if `files:` is wrong.

## Phase 1 — Direct-ref pass (budget ÷ 2 browzer search calls)

For each changed file, find markdown that literally names it. Two queries per file when path is long enough to disambiguate:

```bash
# Full path — catches docs citing apps/api/src/middleware/auth.ts verbatim
browzer search "<full-path>" --json --save /tmp/update-docs-direct-1.json

# Basename only — catches docs citing auth.ts in context
browzer search "<basename>" --json --save /tmp/update-docs-direct-2.json
```

For each hit in the results:

1. Deduplicate by `documentName` across all queries.
2. Drop hits inside the feat folder itself (`docs/browzer/feat-<slug>/` — those are the PRD / task specs; they describe the change, they aren't stale from it).
3. Drop hits inside any subtree the repo explicitly marks as historical or archived. Conventional signals: a directory named `retrospectives/`, `archive/`, `history/`, or `old/` under `docs/`; a file whose YAML frontmatter carries `status: archived` / `archived: true`; a marker file at the subtree root (`.archive-root`, `ARCHIVED.md`). The point is correct-as-of-date docs don't want to be retro-edited. When unsure, skip and log the skip under `deferred` in the report with `reason: "looks archived; operator decides"`.
4. The remainder is the Pass-1 candidate list.

Stop Pass 1 when budget÷2 is consumed or all changed files have been searched.

## Phase 2 — Concept-level pass (budget ÷ 2 browzer search calls)

Docs don't always name the file that changed; they describe the *area*. After changing an auth middleware, a doc about "how authentication works in this repo" is stale even if it never cites `auth.ts`. This pass catches those.

### 2.1 — Extract concepts from each changed path

Heuristic (ordered by specificity):

- **Nearest `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md`** walking up from each changed file. These are the authoritative per-subtree docs. Add them as direct candidates (no search needed — they're known paths).
- **Consumers from `browzer deps --reverse`** — for every changed file, run `browzer deps <path> --reverse --json --save /tmp/update-docs-deps-<slug>.json`. The `importedBy` list gives real blast-radius — the CLAUDE.md / README.md / runbook sitting next to those consumers is a high-signal candidate even when it never cites the changed path. Prefer `browzer deps` over walking the filesystem with `ls`: it answers "who might be affected" in a single indexed query instead of N filesystem probes, and it surfaces cross-package consumers that `ls` up the tree would miss.
- **Symbol-level hits from `browzer explore`** — when the changed file exports a named symbol the PRD mentions (e.g. `requireAuthz`, `DeviceFlow`), run `browzer explore "<symbol>" --json --save /tmp/update-docs-symbol-<slug>.json`. Hits inside doc files (`.md` / `.mdx` under `docs/`) are concept-level candidates; hits inside code files surface additional consumers whose sibling docs may be stale.
- **Package / app name** — `apps/api/...` → concept "api", `packages/core/src/search/...` → concepts "core", "search".
- **Module / layer** — `src/middleware/...` → "middleware", `src/routes/...` → "routes", `src/repos/...` → "repositories".
- **Purpose inferred from filename** — `auth.ts` / `rbac.ts` / `session.ts` → concepts "authentication", "authorization", "session management".

Dedupe the resulting concept list across all changed files.

**Why `browzer deps` before `browzer search` for this pass.** `browzer search` matches on text similarity; `browzer deps --reverse` matches on actual import edges. The former is necessary but fuzzy; the latter is cheap, precise, and exposes the real graph of "code that would break if the changed file broke". A doc sitting next to a direct importer is almost always worth at least a Read-pass. Run both — they catch different kinds of staleness.

### 2.2 — Search concepts + anchor docs

For each distinct concept (after §2.1's `deps`/`explore` round), run one `browzer search`:

```bash
browzer search "<concept>" --json --save /tmp/update-docs-concept-<slug>.json
```

Also always include (without search — known paths discovered by §2.1):

- Every `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` walking up from each changed file's directory.
- Every `CLAUDE.md` / `AGENTS.md` / `README.md` sitting next to a direct importer returned by `browzer deps --reverse` in §2.1. These are the per-consumer-subtree authoritative docs; they are known paths (no search cost), but they only become visible once `deps` has produced the import list.
- Any `TECHNICAL_DEBTS.md`, `DEBTS.md`, `ROADMAP.md`, `CHANGELOG.md` at the repo root, if the change closes an item tracked there.
- Any `README.md` along the change's directory path if the change alters something user-visible (public API, CLI flag, env var, port, command).

**Budget accounting**: the `--budget N` cap (default 8) applies only to `browzer search` calls. `browzer deps` and `browzer explore` in §2.1 are structural probes — they don't hit the vector index and don't count against the budget. This is the same accounting `execute-task` uses for Context7 fallbacks.

Stop Pass 2 when budget÷2 is consumed.

### 2.3 — Merge into Pass-2 candidate list

Deduplicate against Pass 1 (a doc that matched both is still just one candidate).

## Phase 3 — Classify each candidate

For each candidate (Pass 1 and Pass 2), Read the doc and decide:

| Classification  | When                                                                                                 | Action                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `needs-patch`   | The doc asserts something the change made untrue (wrong path, wrong API shape, wrong behavior, wrong env var, wrong command). | Edit the specific lines. Record under `patched`.                |
| `needs-append`  | The doc's structure invites a new entry that the change creates (a new invariant, a new runbook step, a new env var section, a new backlog item being closed). | Append or insert. Record under `patched`.                        |
| `stale-but-oos` | The doc is stale in a way that's real but OUTSIDE this change's scope (the change exposed a pre-existing gap — the change didn't create it). | Don't patch. Record under `deferred` with a precise reason so a future sweep can pick it up. |
| `not-stale`     | The doc mentions the area but describes it in terms that are still accurate after the change.        | Don't patch. Record under `reviewed-clean`.                      |
| `false-positive`| `browzer search` hit on a keyword but the doc is about a different thing with the same word.          | Don't patch. Record under `false-positives`.                    |

When in doubt between `needs-patch` and `stale-but-oos`, prefer `stale-but-oos` — patching beyond your lane makes the commit bigger and harder to revert. An unambiguous `needs-patch` is one where the doc's current text would mislead a reader who trusted it right now.

## Phase 4 — Patch

For each `needs-patch` / `needs-append` candidate, use `Edit` to change only the specific lines that went stale. Preserve the rest of the doc verbatim — update-docs is a surgeon, not a rewriter.

Rules:

- Never regenerate a whole section unless the entire section is about behavior that no longer exists. Rewriting a section to "improve prose" while patching is scope creep.
- Preserve the doc's voice, examples, and formatting (indentation, list style, table shape). Mirror the existing style of the doc you're patching.
- Don't add "updated on <date>" footers unless the doc already has one. Git history is the audit trail.
- When a closed item in `TECHNICAL_DEBTS.md` / similar needs a status flip, prefer checking the box + appending the commit SHA in the existing format rather than rewriting the whole entry.

If a patch turns out to be larger than ~25 lines or spans >2 sections of a doc, stop and add it to `deferred` with `reason: "patch exceeded surgical scope; needs human review"`. The skill's value is in catching the small mechanical updates reliably; big doc rewrites are tasks in their own right and should go through `generate-task` → `execute-task`.

## Phase 5 — Write the report

Write JSON to `<FEAT_DIR>.meta/UPDATE_DOCS_<timestamp>.json` (create `.meta/` if missing):

```json
{
  "skill": "update-docs",
  "timestamp": "20260422T174503Z",
  "featDir": "docs/browzer/feat-20260422-rbac-tighten/",
  "filesInScope": [
    "apps/api/src/middleware/auth.ts",
    "apps/api/src/routes/protected.ts"
  ],
  "budget": { "total": 8, "consumed": 7, "exhausted": false },
  "passes": {
    "directRef": {
      "candidates": 5,
      "patched": 2,
      "deferred": 1,
      "reviewedClean": 1,
      "falsePositives": 1
    },
    "concept": {
      "candidates": 4,
      "patched": 1,
      "deferred": 0,
      "reviewedClean": 3,
      "falsePositives": 0
    }
  },
  "patched": [
    {
      "path": "apps/api/CLAUDE.md",
      "reason": "doc asserted `requireAuthz` lives in src/middleware; change moved it to src/middleware/auth.ts — corrected path on line 42",
      "pass": "concept",
      "classification": "needs-patch"
    }
  ],
  "deferred": [
    {
      "path": "docs/runbooks/oncall.md",
      "reason": "mentions deprecated /v1/ask endpoint in the incident-playbook; removal is out of scope for this change (would need PRD + tasks)",
      "pass": "concept",
      "classification": "stale-but-oos"
    }
  ],
  "reviewedClean": [],
  "falsePositives": [],
  "warnings": []
}
```

The report is the handoff to `commit`. `commit` does NOT re-probe the repo for docs to update — it trusts `update-docs` already did. If the report lists `deferred` items, the operator sees them via the confirmation line and decides whether to widen scope before committing.

## Phase 6 — One-line confirmation

Per the plugin's `README.md` (at `../../README.md` relative to this file) §"Skill output contract". The canonical shape is:

```
update-docs: patched <N> markdown files (<X> direct refs, <Y> concept-level[, <Z> deferred]); report at <path-to-report>[; ⚠ <warning>]
```

Always emit the `(<X> direct refs, <Y> concept-level)` breakdown — zero is fine (`0 direct refs`). Add `, <Z> deferred` only when deferred candidates exist; omit the clause entirely when `Z = 0`. Always cite the report path unless the skill failed before writing it.

Concrete examples:

```
update-docs: patched 3 markdown files (1 direct ref, 2 concept-level); report at docs/browzer/feat-20260422-rbac-tighten/.meta/UPDATE_DOCS_20260422T174503Z.json
```

With deferred items:

```
update-docs: patched 3 markdown files (1 direct ref, 2 concept-level, 2 deferred); report at docs/browzer/feat-20260422-rbac-tighten/.meta/UPDATE_DOCS_20260422T174503Z.json
```

With budget exhausted (append the warning after `;`; still cite the report path):

```
update-docs: patched 2 markdown files (2 direct refs, 0 concept-level); report at .meta/UPDATE_DOCS_20260422T174503Z.json; ⚠ budget exhausted at 8 calls, 3 candidates unverified (see report)
```

On failure (e.g., browzer CLI down, every search returned 500):

```
update-docs: failed — browzer search returned 500 for 3 consecutive queries
hint: check `browzer status --json` and retry after the server stabilises; if the outage persists, fall back to manual doc review — this skill does not short-circuit either pass (both passes ALWAYS run when the skill succeeds)
```

False-positive counts live in the report (`falsePositives` array), not in the confirmation line. `reviewedClean` counts likewise — clutter if printed every run.

No inline list of patched files. No diff preview. No "Here's what I updated" block. The operator reads the report if they need detail; the chat line is the cursor.

## What update-docs does NOT do

- **Does not write new docs.** If a change adds a capability that has no doc yet, that's a task for `generate-task` / `execute-task`, not this skill. The skill patches *existing* docs that went stale; it doesn't author new ones.
- **Does not update the source doc the session consumed.** If the session was driven by a retro or an action plan, the orchestrator's post-ship nudge handles that (see `orchestrate-task-delivery` §"Post-ship: source doc hygiene"). `update-docs` syncs docs that describe the *code*; the post-ship nudge syncs the doc that *triggered the session*. Different shape of staleness.
- **Does not re-run quality gates.** `execute-task` already did that. Markdown edits don't warrant another `pnpm turbo test` pass.
- **Does not commit.** `commit` is phase 5; it consumes this report but runs separately.
- **Does not format prose.** Biome / prettier don't format markdown bodies in this repo. Preserve the doc's existing style.

## Invocation modes

- **Via `orchestrate-task-delivery`:** phase 4/6 of the dev workflow. Orchestrator passes `files:` from the prior HANDOFF and `feat dir:` from the feat folder it created.
- **Standalone:** user says "update the docs", "sync doc freshness", or similar. Auto-derives file list from git; writes a standalone feat folder if none exists.
- **Via `execute-task`'s tail:** for a single-task session, `execute-task` may invoke `update-docs` directly after its own HANDOFF lands and before returning control to the orchestrator. Same contract.

## Related skills and references

- the plugin's `README.md` (at `../../README.md` relative to this file) §"Skill output contract" — the output shape this skill conforms to.
- `../../references/subagent-preamble.md` — the code-subagent brief that `execute-task` uses; included here for symmetry (update-docs may dispatch a subagent per-doc for a very large candidate list, in which case the subagent reads the preamble).
- `generate-task`, `execute-task` — prior phases; `update-docs` reads their HANDOFF and activation artifacts to ground its scope.
- `commit` — next phase; consumes the report without re-probing.
- `orchestrate-task-delivery` — coordinator; decides whether `update-docs` runs per-task or once per plan.
