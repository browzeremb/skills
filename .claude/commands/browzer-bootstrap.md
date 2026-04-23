---
name: browzer-bootstraper
description: One-shot bootstrapper that turns an arbitrary repo into a Browzer-powered, Claude-aware RAG workspace — initializes + indexes (or syncs) the workspace if needed, fans out parallel agents to (1) sweep stale docs for factual drift and (2) generate a full ARCHITECTURE_BLUEPRINT.md via the `architecture-blueprint-generator` skill, then uploads the resulting doc bundle by invoking `update-docs`, and finally presents all local changes for the user to review before committing. Use when the user says "give claude rag steroids", "bootstrap rag on this repo", "browzer bootstrap", "supercharge this codebase for browzer", "onboard this project into browzer end-to-end", "full rag onboarding", or is starting a new project and wants the whole Browzer loop wired up in one go. Triggers — browzer bootstrap, give claude rag steroids, rag steroids, claude rag onboarding, full browzer bootstrap, supercharge rag, browzer end-to-end onboarding, sync stale docs, generate architecture blueprint, rag onboarding workflow, one-shot rag setup.
allowed-tools: Bash(browzer *), Bash(git *), Bash(ls *), Bash(mkdir *), Bash(cp *), Bash(find *), Bash(cat *), Bash(mv *), Bash(rm *), Bash(test *), Read, Write, Edit, Glob, Grep, Agent
---

# browzer-bootstraper — one-shot Browzer bootstrap

This skill **bootstraps a repo end-to-end** so Claude Code (and any other agent on this machine) can work on it with first-class hybrid vector + Graph RAG via Browzer, a curated doc bundle, and a clean commit trail — but only after you review and confirm the changes.

Run it once per fresh repo. It is idempotent — safe to re-run; existing workspaces and already-current docs are left alone.

## Shape of the run

Four phases, strictly ordered. Phase 3 fans out to parallel sub-agents; everything else is sequential.

```
Phase 1  Preflight        → browzer status? → browzer init if no workspace
Phase 2  Index / Sync     → browzer workspace index (new) OR browzer workspace sync (already indexed)
Phase 3  Parallel dispatch (2 Agent calls in ONE message, fallback: sequential):
          3a  Doc-drift sweeper  → fix stale README/docs against real code
          3b  Blueprint builder  → $SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md
                                   (via `architecture-blueprint-generator` skill)
Phase 4  Converge:
          4.1  Mirror $SCRATCH_DIR bundle → <repo>/docs/browzer/rag-steroids/
               then invoke `update-docs` skill to sync the new docs into Browzer
          4.2  Show the full diff of local changes and ask the user to confirm, modify, or refuse the commit
          4.3  If confirmed → commit via `commit` skill; if refused → skip with a note
          4.4  Write report JSON + emit one-line confirmation (per plugin output contract)
```

Tell the user up front this will run 2 agents in parallel and touch at most: their docs, `.browzer/config.json`, `.gitignore`, `CLAUDE.md`, and the Browzer workspace on the server side. The plugin's own source tree is never modified. Ask for green-light **before** Phase 3 if the repo has uncommitted changes (the commit at the end would mix them in).

## Phase 1 — Preflight

First, allocate a per-invocation scratch dir and export it so every phase below writes to the same place:

```bash
export SCRATCH_DIR=$(mktemp -d -t browzer-bootstrap.XXXXXX)
```

Per-invocation isolation prevents concurrent runs from trashing each other's artifacts. If `SCRATCH_DIR` is already set, reuse it. Pass it explicitly to Phase 3 sub-agents.

Then preflight Browzer:

```bash
browzer status --json --save $SCRATCH_DIR/status.json
```

Read `$SCRATCH_DIR/status.json`.

- `exit 2` → not authenticated. STOP and hand off to `use-rag-cli` (`browzer login`). Do not proceed.
- `exit 3` **or** the JSON shows no active workspace → run:
  ```bash
  browzer init
  ```
  This creates the server workspace + `.browzer/config.json` only (no parsing yet). See `embed-workspace-graphs` for init failure modes.
- Workspace present → continue.

## Phase 2 — Index or sync the code graph

The structural index powers `browzer explore`. Choose the right command based on workspace state from `status.json`:

- **No prior successful parse** (new workspace or first run) → **index**:
  ```bash
  browzer workspace index --json --save $SCRATCH_DIR/index.json
  ```
- **Workspace already indexed** (prior parse succeeded) → **sync**:
  ```bash
  browzer workspace sync --json --save $SCRATCH_DIR/sync.json
  ```

In both cases:
- `No changes detected — skipped re-parse` → fine, already current.
- HTTP 429 `parse_cooldown` → wait `Retry-After` seconds or skip; the prior parse is still usable.
- `N ingestion job(s) still in flight` → skip with a note; use `browzer job get <batchId>` to drain. Do not `--force`.

The goal is: after Phase 2, `browzer explore` returns real results over this repo.

## Phase 3 — Parallel dispatch (ONE message, two Agent calls)

Send both Agent calls in a **single assistant message** so they run concurrently. Use `subagent_type: "general-purpose"` unless a more specialized agent matches the sub-task.

**Fallback when `Agent` isn't available** (e.g. this skill running from inside a subagent): execute sequentially. Order: 3b (blueprint — heaviest) → 3a (sweeper — benefits from having the module map to validate against). The tasks are logically independent; in-order just costs wall-clock time, not correctness.

### 3a — Doc-drift sweeper

Dispatch an agent with a prompt along these lines (adapt the repo path):

> You are the doc-drift sweeper for `<repo-path>`. Goal: find every markdown doc in this repo that claims something the code no longer does, and either **fix it in-place** (if the correct claim is obvious from the code) or **append a `> ⚠️ STALE: <reason>` marker** where the correct answer isn't obvious. Use `browzer explore --save /tmp/explore.json` as your primary lookup — do NOT grep-walk the whole tree unless explore misses. Scope: top-level `README*`, every `CLAUDE.md` / `AGENTS.md`, every `docs/**/*.md`. Out of scope: `node_modules/`, `dist/`, generated files, third-party vendored docs. Produce a report at `$SCRATCH_DIR/DOC_DRIFT_REPORT.md` with: files touched, one-line reason per fix, and any `⚠️ STALE` markers left for humans. Commit nothing — Phase 4 handles the commit.

Notes for the sweeper:
- Ports, env vars, script names, directory layout, and "how to run" blocks rot fastest. Prioritize those.
- Version numbers (Node, pnpm, Go, library versions) must match the repo's pinning (`package.json`, `go.mod`, `.nvmrc`, `.tool-versions`).
- Do NOT rewrite prose for style — only correct factually wrong claims.

### 3b — Blueprint builder

Dispatch an agent to produce `$SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md` using the `architecture-blueprint-generator` skill.

Agent instruction:

> Invoke `Skill(skill: "architecture-blueprint-generator")` to generate a comprehensive architecture blueprint for `<repo-path>`. Save the output as `$SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md`. Use `browzer explore "<query>" --json --save /tmp/explore.json` and `browzer deps <path> --json --save /tmp/deps.json` as primary lookup tools — fall back to `Read` on specific files the explore results point at. Do **not** grep-walk the tree. Write the blueprint to `$SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md` when done.

If the `architecture-blueprint-generator` skill is not installed, produce the blueprint inline with the same comprehensive structure the skill would generate — the blueprint is the required deliverable regardless of skill availability.

## Phase 4 — Converge

Run sequentially from the parent session after both sub-agents return.

### 4.1 Stage the bundle in-repo, then invoke update-docs

`update-docs` only works on paths inside the active workspace. The Phase 3 agents wrote to `$SCRATCH_DIR/` for isolation; copy the bundle into `<repo>/docs/browzer/rag-steroids/` first. The in-repo copies are also what Phase 4.3 commits, so the same bundle lands in both git history and the Browzer workspace.

```bash
mkdir -p <repo>/docs/browzer/rag-steroids
cp $SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md  <repo>/docs/browzer/rag-steroids/
cp $SCRATCH_DIR/DOC_DRIFT_REPORT.md        <repo>/docs/browzer/rag-steroids/
```

Then invoke the `update-docs` skill to sync the newly staged files into Browzer:

```
Skill(skill: "update-docs", args: "files: docs/browzer/rag-steroids/ARCHITECTURE_BLUEPRINT.md docs/browzer/rag-steroids/DOC_DRIFT_REPORT.md")
```

`update-docs` handles Browzer ingestion of the doc bundle. It is the right abstraction here — it knows how to upload docs without requiring the interactive `--add` flow and emits a proper single-line confirmation.

### 4.2 Review gate — show changes and ask the user

Before committing anything, show the user exactly what will change:

```bash
cd <repo> && git diff --stat HEAD
git status --short
```

Present the diff summary clearly. Then ask:

> "These are the local changes the bootstrap produced. Would you like to:
> - **Commit** as-is (I'll draft the commit message for your review)
> - **Modify** (tell me what to add, remove, or change)
> - **Skip** the commit (leave changes staged but uncommitted)"

Wait for the user's response. Do NOT proceed to Phase 4.3 without an explicit confirmation.

If the user wants to modify the proposed commit scope (e.g. exclude certain files, tweak the message), apply those changes before committing.

### 4.3 Commit local changes (only if the user confirmed)

Invoke the `commit` skill via `Skill(skill: "commit")`. If that isn't reachable (e.g. from inside a sub-agent), fall back to plain `git add` + `git commit -m "<conventional-commits subject>"` with a Browzer-authored message (including the `on-behalf-of: @browzeremb` trailer).

The staged set is everything this skill produced **inside the target repo** (unless the user scoped it differently in Phase 4.2):

- Doc fixes written by the sweeper in 3a (e.g. corrected `README.md`, touched `docs/**/*.md`).
- `CLAUDE.md` — `browzer init` from Phase 1 appends a KB section describing how Claude should query this workspace. Belongs in history.
- `.browzer/config.json` — written by `browzer init`; pins this checkout to its workspace id. Teammates cloning the repo need it.
- `.gitignore` — `browzer init` writes or appends (ignoring `.browzer/.cache/` and friends). Stage if new or modified.
- `docs/browzer/rag-steroids/ARCHITECTURE_BLUEPRINT.md` and `docs/browzer/rag-steroids/DOC_DRIFT_REPORT.md` — the bundle Phase 4.1 staged in-repo.

Do **not** stage `$SCRATCH_DIR/*` — transient scratch contents already mirrored to the repo.

Skip the commit entirely only if the user refused in Phase 4.2, **or** if all the above are unchanged (no sweeper fixes, `browzer init` was a no-op, and `docs/browzer/rag-steroids/` already matches). Tell the user why in either case.

### 4.4 Finalize — write the report, emit one line

Write `<repo>/docs/browzer/rag-steroids/BROWZER_BOOTSTRAP_<timestamp>.json` with at least:

```json
{
  "workspace": { "id": "<id>", "name": "<name>", "createdNow": true|false },
  "index": { "action": "index|sync|skipped", "codeFiles": "<N>" },
  "docsUploaded": ["ARCHITECTURE_BLUEPRINT.md", "DOC_DRIFT_REPORT.md"],
  "commit": { "sha": "<sha>", "subject": "<subject>", "skipped": false, "skipReason": null },
  "warnings": [],
  "timings": { "phase1_ms": "<N>", "phase2_ms": "<N>", "phase3_ms": "<N>", "phase4_ms": "<N>" }
}
```

Then emit the confirmation:

```
browzer-bootstraper: bootstrapped workspace <name> (<codeFiles> code files indexed, <docs> docs uploaded); commit at <sha>; report at docs/browzer/rag-steroids/BROWZER_BOOTSTRAP_<timestamp>.json
```

Warnings append with `;` (e.g., `; ⚠ commit skipped — user declined` or `; ⚠ commit skipped — nothing changed`). Failures use the two-line contract.

**Banned from chat output:**

- Multi-line `✅` status banners — one confirmation line only.
- `Next steps you can run right now:` bullet lists.
- Per-phase progress prose in the final message — stream during Phases 1–3 if it helps visibility; the FINAL emission is still the single confirmation line.

## Idempotency rules

- Phase 1: if `browzer status` shows a live workspace, skip `init`.
- Phase 2: if `index`/`sync` reports `unchanged`, accept it — do NOT `--force`.
- Phase 3a: sweeper only writes when a claim is factually wrong.
- Phase 3b: fresh `$SCRATCH_DIR` per run; Phase 4.1 mirrors blueprint to the repo and overwrites. That's intentional — the blueprint is a derived artifact, git history is the archive.
- Phase 4.1: `update-docs` is idempotent — re-uploading a path already tracked is a no-op.
- Phase 4.3: a second run usually produces only a docs-refresh commit. If every artifact is byte-identical and no sweeper fixes occurred, commit is a no-op regardless of user confirmation.

## Hard constraints

- **Never** `rm -rf $SCRATCH_DIR` before the run completes — later phases depend on its contents. After 4.4 it's safe to clean up or let the OS reap it.
- **Never** `browzer workspace delete` from inside this skill. Workspace lifecycle is `workspace-management`'s job.
- **Never** `git push` from inside this skill. The commit skill stops at the commit; pushing is a human decision.
- **Never** skip the user review gate in Phase 4.2. Auto-committing without user review is the pattern this constraint explicitly prevents.
- **Never** ask for green-light in Phase 3 if you already asked and the user confirmed — do not double-prompt.

## When to refuse

- User asks to run this on a repo that has **no `.git`**. Browzer works on directories, but the commit step requires git. Offer to run Phases 1–3 only and skip 4.3.
- User asks to run this against a **public OSS repo they don't own**. Uploading its docs to their Browzer workspace is technically fine — but call it out so they know what they're doing.
- User asks to run this on their **home directory** or **/**. Refuse — the doc-drift agent will explode on the world.

## Output contract

Per the plugin's `README.md` §"Skill output contract". The skill emits ONE confirmation line plus a JSON report at `<repo>/docs/browzer/rag-steroids/BROWZER_BOOTSTRAP_<timestamp>.json`. Never print the ✅-banner, phase-by-phase summary, or "Next steps" block.

## Related skills

- `use-rag-cli` — install + authenticate (anchor skill; this skill assumes auth).
- `embed-workspace-graphs` — `browzer init` + `browzer workspace index` (Phases 1 + 2 wrap this).
- `architecture-blueprint-generator` — the blueprint generator invoked in Phase 3b.
- `update-docs` — the doc-sync skill invoked in Phase 4.1 to upload the doc bundle into Browzer.
- `explore-workspace-graphs` — the hybrid search sub-agents should use instead of grep.
- `dependency-graph` — `browzer deps` for blast-radius queries the blueprint agent will run.
- `workspace-management` — when the user actually wants to delete / relink a workspace.
- `commit` — Conventional-Commits + Browzer-org attribution for Phase 4.3.
- `sync-workspace` — lightweight re-index for incremental changes after this bootstrap runs.
