---
name: give-claude-rag-steroids
description: One-shot bootstrapper that turns an arbitrary repo into a Browzer-powered, Claude-aware RAG workspace — initializes + indexes the workspace if missing, fans out parallel agents to (1) sync stale docs with the actual code, (2) generate a full ARCHITECTURE_BLUEPRINT.md from a self-contained spec (no external skill dependency), (3) map installed Claude skills against the project's libs/domains, then uploads the resulting doc bundle into the workspace, writes a per-repo `.browzer/search-triggers.json` that extends the search-guard vocab for this stack, and commits local changes. Use when the user says "give claude rag steroids", "bootstrap rag on this repo", "supercharge this codebase for browzer", "onboard this project into browzer end-to-end", "full rag onboarding", or is starting a new project and wants the whole Browzer + Claude-skills loop wired up in one go. Triggers - give claude rag steroids, rag steroids, claude rag onboarding, full browzer bootstrap, supercharge rag, browzer end-to-end onboarding, map claude skills to codebase, sync stale docs, generate architecture blueprint, tune browzer vocab, rag onboarding workflow, turbo-charge browzer, one-shot rag setup.
allowed-tools: Bash(browzer *), Bash(python3 *), Bash(git *), Bash(ls *), Bash(mkdir *), Bash(cp *), Bash(find *), Bash(cat *), Bash(mv *), Bash(rm *), Bash(test *), Read, Write, Edit, Glob, Grep, Agent
---

# give-claude-rag-steroids — one-shot Browzer + Claude-skills bootstrap

This skill **bootstraps a repo end-to-end** so Claude Code (and any other agent on this machine) can work on it with first-class hybrid vector + Graph RAG via Browzer, a curated doc bundle, a stack-tuned search guard, and a clean commit trail.

Run it once per fresh repo. It is idempotent — safe to re-run; existing workspaces and already-current docs are left alone.

## Shape of the run

Four phases, strictly ordered. Phase 3 fans out to parallel sub-agents; everything else is sequential.

```
Phase 1  Preflight        → browzer status? → browzer init if no workspace
Phase 2  Indexed?         → browzer workspace index if graph isn't current
Phase 3  Parallel dispatch (3 Agent calls in ONE message, fallback: sequential):
          3a  Doc-drift sweeper  → fix stale README/docs against real code
          3b  Blueprint builder  → $SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md
          3c  Skill mapper       → $SCRATCH_DIR/CLAUDE_SKILLS_FOR_<repo>.md
                                 + $SCRATCH_DIR/skills-manifest.json
Phase 4  Converge:
          4.1  Mirror $SCRATCH_DIR bundle → <repo>/docs/rag-steroids/, then browzer workspace docs --add
          4.2  Write <repo>/.browzer/search-triggers.json (only if vocab_suggestions non-empty)
          4.3  Commit inside <repo>: sweeper fixes + CLAUDE.md + .browzer/config.json + .browzer/search-triggers.json + .gitignore + docs/rag-steroids/*
          4.4  Write report JSON + emit one-line confirmation (per plugin output contract)
```

Tell the user up front this will run 3 agents in parallel and touch at most: their docs, `.browzer/config.json`, `.browzer/search-triggers.json`, `.gitignore`, `CLAUDE.md`, and the Browzer workspace on the server side. The plugin's own source tree is never modified. Ask for green-light **before** Phase 3 if the repo has uncommitted changes (the /commit at the end would mix them in).

## Phase 1 — Preflight

First, allocate a per-invocation scratch dir and export it so every phase below writes to the same place without colliding with other concurrent runs:

```bash
export SCRATCH_DIR=$(mktemp -d -t rag-steroids.XXXXXX)
```

`mktemp` yields a unique path like `/var/folders/.../rag-steroids.aB3xYz/` on macOS or `/tmp/rag-steroids.aB3xYz/` on Linux. Per-invocation isolation matters because multiple runs of this skill in parallel (different repos, same host) would otherwise trash each other's `ARCHITECTURE_BLUEPRINT.md` and `skills-manifest.json`. If `SCRATCH_DIR` is already set in the environment, reuse it (caller may want to preserve artifacts across phases). If the `Agent` sub-agents in Phase 3 run in separate shell contexts, pass `SCRATCH_DIR` to each one explicitly in the prompt so they write to the same dir.

Then preflight Browzer itself:

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

## Phase 2 — Make sure the code graph is indexed

The structural index is what powers `browzer explore`. If `status.json` shows no successful parse yet (or the repo has non-trivial unindexed changes), index now:

```bash
browzer workspace index --json --save $SCRATCH_DIR/index.json
```

- `No changes detected — skipped re-parse` → fine, already indexed.
- HTTP 429 `parse_cooldown` → wait `Retry-After` seconds or skip (the prior parse is still usable).
- `N ingestion job(s) still in flight` → skip with a note; use `browzer job get <batchId>` to drain. Do not `--force` here; Phase 3 doesn't need a fresh parse.

The goal is: after Phase 2, `browzer explore` returns real results over this repo.

## Phase 3 — Parallel dispatch (ONE message, three Agent calls)

Send all three Agent calls in a **single assistant message** so they run concurrently. Use `subagent_type: "general-purpose"` unless a more specialized agent matches the sub-task.

**Fallback when `Agent` isn't available** (e.g. this skill running from inside a subagent that doesn't inherit the tool): execute the three sub-tasks sequentially in the current context, each as a normal tool-using workflow. Order: 3c (skill mapper — cheapest, pure Python) → 3b (blueprint — heaviest, benefits from the mapper's stack signals) → 3a (doc-drift sweeper — benefits from the blueprint's module map). The three tasks are still logically independent; running them in-order just costs wall-clock time, not correctness.

### 3a — Doc-drift sweeper

Dispatch an agent with a prompt along these lines (adapt the repo path):

> You are the doc-drift sweeper for `<repo-path>`. Goal: find every markdown doc in this repo that claims something the code no longer does, and either **fix it in-place** (if the correct claim is obvious from the code) or **append a `> ⚠️ STALE: <reason>` marker** where the correct answer isn't obvious. Use `browzer explore --save /tmp/explore.json` as your primary lookup — do NOT grep-walk the whole tree unless explore misses. Scope: top-level `README*`, every `CLAUDE.md` / `AGENTS.md`, every `docs/**/*.md`. Out of scope: `node_modules/`, `dist/`, generated files, third-party vendored docs. Produce a report at `$SCRATCH_DIR/DOC_DRIFT_REPORT.md` with: files touched, one-line reason per fix, and any `⚠️ STALE` markers left for humans. Commit nothing — Phase 4 handles the commit.

Notes for the sweeper:
- Ports, env vars, script names, directory layout, and "how to run" blocks rot fastest. Prioritize those.
- Version numbers (Node, pnpm, Go, library versions) must match the repo's pinning (`package.json`, `go.mod`, `.nvmrc`, `.tool-versions`).
- Do NOT rewrite prose for style — only correct factually wrong claims.

### 3b — Blueprint builder

Dispatch an agent to produce `$SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md` — a comprehensive, human-readable snapshot of the repo's architecture that a newcomer (human or AI) can load once and navigate from. The blueprint is self-contained: do **not** depend on any external blueprint skill being installed (this plugin ships in other codebases and the user may not have one). If the agent happens to find a local skill named `architecture-blueprint-generator` (e.g. under `~/.claude/skills/` or `<repo>/.claude/skills/`), it may use it as a reference, but the required deliverable and method below take precedence.

Agent instruction:

> Produce `$SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md` for `<repo-path>`. Primary lookup must be Browzer — `browzer explore "<query>" --json --save /tmp/explore.json` and `browzer deps <path> --json --save /tmp/deps.json`. Fall back to reading specific files with `Read` when explore results point at them. **Do not** grep-walk the tree; that defeats the point of having a RAG index.
>
> Required top-level structure (use these exact `##` headings, in this order):
>
> 1. **Overview** — one paragraph: what this repo is, who it serves, what it does in plain language.
> 2. **Tech stack** — languages (+ pinned versions from `.nvmrc`/`.tool-versions`/`go.mod`/etc.), frameworks, databases, message buses, external services. Group by layer.
> 3. **Top-level layout** — map every `apps/*`, `packages/*`, `services/*`, or equivalent top-level dir to a one-line purpose. For a single-app repo, map the top-level source dirs instead.
> 4. **Runtime request path** — for the primary user-facing flow (HTTP request, CLI command, job trigger — whichever the repo centers on), trace the path from entry point through each module until response/side-effect. Name real functions/files with `path:line`. If there are multiple equally-central flows, cover each.
> 5. **Data stores** — every persistent store the code touches, with: what it holds, who owns the schema, where migrations live, access patterns (read/write/both), retention.
> 6. **Deploy targets** — where this ships (Vercel / Railway / AWS / self-hosted / etc.), per service. Build pipeline (CI file path). Environments (dev / staging / prod) and their differences.
> 7. **Cross-cutting invariants** — rules that every part of the codebase honors: auth/tenancy scoping, logging/observability, error handling, secret-handling, rate-limiting, idempotency. Pull these from existing docs (`CLAUDE.md`, `AGENTS.md`, `docs/**`) when present; infer from the code when not.
> 8. **Known debt / in-flight work** — anything the repo itself documents as ongoing: `REFACTOR_CHECKPOINT.md`, `SYSTEM_DESIGN*.md`, ADRs in `docs/adr/` or `docs/decisions/`, TODO-heavy files, `@deprecated` markers at module boundaries. Summarize; link to the source docs. Do NOT invent debt.
> 9. **Extension guide** — for the 3–5 most common tasks (`add an HTTP route`, `add a background job`, `add a database table`, `add a new package`, whichever fit), give the exact files to touch, in order.
>
> Style: dense but scannable. Use tables where they help (tech stack, services, data stores). Every non-trivial claim must cite a file path or an existing doc — if you can't cite it, don't claim it. Length target: 300–800 lines. If the repo is tiny (≤20 files), a ~150-line blueprint is correct; don't pad.
>
> Idempotency: if `$SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md` already exists from a prior run, overwrite it. Browzer holds the authoritative ingested copy after Phase 4.1.

### 3c — Skill mapper

Dispatch an agent to run the bundled Python helper:

```bash
python3 "$SKILL_DIR/scripts/map_skills.py" \
  --repo "<repo-path>" \
  --out  $SCRATCH_DIR/CLAUDE_SKILLS_FOR_<repo>.md \
  --manifest $SCRATCH_DIR/skills-manifest.json
```

`$SKILL_DIR` resolves to this skill's directory (the one containing SKILL.md). The script walks `~/.claude/skills` and `<repo>/.claude/skills`, reads every `SKILL.md` frontmatter, extracts project signals from every `package.json` / `go.mod` / `pyproject.toml` / `Cargo.toml` in the repo, scores each skill against those signals, and emits two artifacts:

- `CLAUDE_SKILLS_FOR_<repo>.md` — human-readable doc grouped by relevance (High / Medium / Low) with a one-line rationale per skill. Designed to be ingested by Browzer later.
- `skills-manifest.json` — machine-readable list Phase 4 reads to drive the vocab patch.

Agent instruction for 3c:

> Run the command above. If the script exits non-zero, read its stderr and fix the call (usually a missing `--repo` path). Do NOT modify the script. After it succeeds, skim the top of the generated markdown and confirm the "High" tier is non-empty; if it is empty, note it in the agent's return message — that usually means the repo has no `package.json`-like manifest at all.

## Phase 4 — Converge

Run sequentially from the parent session after all three sub-agents return.

### 4.1 Stage the bundle in-repo, then upload

`browzer workspace docs --add` only accepts paths **inside** the active workspace — anything under `/tmp/...` fails with `paths not found in workspace candidates`. The Phase 3 agents wrote to `$SCRATCH_DIR/` for isolation; now copy the bundle into `<repo>/docs/rag-steroids/` before handing it to Browzer. The in-repo copies are also what Phase 4.3 commits, so the same bundle lands in both git history and the Browzer workspace.

```bash
mkdir -p <repo>/docs/rag-steroids
cp $SCRATCH_DIR/ARCHITECTURE_BLUEPRINT.md  <repo>/docs/rag-steroids/
cp $SCRATCH_DIR/CLAUDE_SKILLS_FOR_*.md     <repo>/docs/rag-steroids/
cp $SCRATCH_DIR/DOC_DRIFT_REPORT.md        <repo>/docs/rag-steroids/

cd <repo>
browzer workspace docs --add docs/rag-steroids/ARCHITECTURE_BLUEPRINT.md --yes
browzer workspace docs --add docs/rag-steroids/CLAUDE_SKILLS_FOR_*.md      --yes
browzer workspace docs --add docs/rag-steroids/DOC_DRIFT_REPORT.md         --yes
```

`--yes` is required: recent CLI versions reject mutations from non-interactive shells (the skill always runs non-interactive) with `Error: Non-interactive shells require --yes to submit mutations.` — so it's needed on every run, not just as a fallback.

If `--add` itself is not supported on the installed CLI version, fall back to `browzer workspace docs --plan docs/rag-steroids/*.md` and walk the TUI. See `embed-documents` for the doc-ingestion contract.

The `--add` command prints a billing warning (`could not fetch billing usage: Forbidden`) on free-tier tokens — non-fatal, ignore it.

### 4.2 Extend the search-guard vocab per-repo

Read the freshly generated `$SCRATCH_DIR/skills-manifest.json`. Its `vocab_suggestions` array lists libs/frameworks detected in this repo's manifests that aren't already in the plugin's global `DEFAULT_VOCAB`.

Write those suggestions into `<repo>/.browzer/search-triggers.json` — a per-repo extension file that the `user-prompt-browzer-search` hook already reads (see `hooks/guards/user-prompt-browzer-search.mjs:55-61`) and merges with `DEFAULT_VOCAB` at runtime. This is the right place for stack-specific triggers: scoped to this workspace, committed alongside the rest of the Phase 4.3 bundle, no cross-repo bleed, and no writes to the plugin itself.

```bash
# Target: <repo>/.browzer/search-triggers.json
# Format: JSON array of strings.
# Behavior: hook does vocab.push(...extra.map(String)) — pure additive.
```

**If the file already exists**, merge: load it as JSON, union with `vocab_suggestions`, write the sorted deduped result. **If it doesn't exist**, create it with the suggestions array. If `vocab_suggestions` is empty, skip this step entirely and tell the user why.

Show the final file contents to the user before writing. Each term should be specific (`drizzle-zod`, `trpc`, `pinecone`) — generic language names (`typescript`, `node`, `python`) are excluded from `SIGNAL_KEYWORDS` on purpose and won't appear in suggestions.

**Do NOT edit the plugin's `DEFAULT_VOCAB`.** That's global state shared across every repo the user touches; the skill has no business widening it. Earlier versions of this skill did modify the plugin file directly — if you find that codepath referenced anywhere, it's stale and should be removed.

### 4.3 Commit local changes

Invoke the `commit` skill via `Skill(skill: "commit")`. If that isn't reachable (e.g. from inside a sub-agent that doesn't inherit slash commands), fall back to plain `git add` + `git commit -m "<conventional-commits subject>"` with a Browzer-authored message (including the `on-behalf-of: @browzeremb` trailer) that reflects what this phase produced.

The staged set is everything this skill produced **inside the target repo**:

- Doc fixes written by the sweeper in 3a (e.g. corrected `README.md`, touched `docs/**/*.md`).
- `CLAUDE.md` — `browzer init` from Phase 1 appends a KB section describing how Claude should query this workspace. That section is now part of the repo's contract with Claude, so it belongs in history.
- `.browzer/config.json` — also written by `browzer init`; it pins this checkout to its workspace id. A teammate cloning the repo needs it to point their Browzer at the same workspace.
- `.gitignore` — `browzer init` writes or appends to it (ignoring `.browzer/.cache/` and friends). If it's new or modified, stage it too — otherwise `.browzer/.cache/` will show up as noise in future `git status`.
- `.browzer/search-triggers.json` — Phase 4.2 writes the repo-specific vocab extension here. Staging it means every teammate who clones gets the same search-guard behavior.
- `docs/rag-steroids/ARCHITECTURE_BLUEPRINT.md`, `docs/rag-steroids/CLAUDE_SKILLS_FOR_<repo>.md`, `docs/rag-steroids/DOC_DRIFT_REPORT.md` — the bundle Phase 4.1 staged in-repo. Browzer holds the ingested copies, but keeping them in git gives humans (and future `browzer workspace docs --refresh` runs) a grep-able source of truth.

Do **not** stage:

- `$SCRATCH_DIR/*` — the transient scratch dir the Phase 3 agents wrote to. Its contents are already mirrored inside `<repo>/docs/rag-steroids/` by Phase 4.1.

Skip the commit entirely only if **all** of the above are unchanged (no sweeper fixes, `browzer init` was a no-op because the workspace already existed, and `docs/rag-steroids/` already matches what Phase 4.1 produced). Tell the user why.

### 4.4 Finalize — write the report, emit one line

The bootstrap does a lot under the hood (3 parallel agents, workspace create, index, docs upload, vocab patch, commit). Under the silence contract (see `../../README.md` §"Skill output contract"), the chat output is still ONE line. Rich detail goes into a machine-readable report on disk.

Write `<repo>/docs/rag-steroids/GIVE_CLAUDE_RAG_STEROIDS_<timestamp>.json` with at least:

```json
{
  "workspace": { "id": "<id>", "name": "<name>", "createdNow": true|false },
  "index": { "codeFiles": <N>, "fingerprintUnchanged": false },
  "docsUploaded": ["ARCHITECTURE_BLUEPRINT.md", "CLAUDE_SKILLS_FOR_<repo>.md", "DOC_DRIFT_REPORT.md"],
  "skillsMapped": { "high": <H>, "medium": <M>, "low": <L> },
  "vocabTermsAdded": <K>,
  "commit": { "sha": "<sha>", "subject": "<subject>", "skipped": false },
  "warnings": [],
  "timings": { "phase1_ms": <N>, "phase2_ms": <N>, "phase3_ms": <N>, "phase4_ms": <N> }
}
```

Then emit the confirmation:

```
give-claude-rag-steroids: bootstrapped workspace <name> (<codeFiles> code files indexed, <docs> docs uploaded, +<vocabTermsAdded> vocab terms); commit at <sha>; report at docs/rag-steroids/GIVE_CLAUDE_RAG_STEROIDS_<timestamp>.json
```

Warnings append with `;` (e.g., `; ⚠ Phase 4.2 skipped — no vocab suggestions` or `; ⚠ commit skipped — nothing changed`). Failures use the two-line contract.

**Banned from chat output:**

- The old `✅ Workspace ready / ✅ Indexed / ✅ Docs uploaded / ✅ Skills mapped / ✅ Vocab extended / ✅ Commit` multi-line banner. Every datum lives in the report.
- The `Next steps you can run right now:` bullet list. The operator already knows `browzer ask` / `explore` / `search` / `deps` — pasting them per run is re-display noise the contract forbids.
- Per-phase progress prose in the final message. Stream during Phase 1–3 if it helps the operator see what's happening; the FINAL emission is still the single confirmation line.

## Idempotency rules (so re-running is safe)

- Phase 1: if `browzer status` shows a live workspace, skip `init`.
- Phase 2: if the server reports `unchanged`, accept it — do NOT `--force`.
- Phase 3a: the sweeper only writes when a claim is factually wrong; prose diffs are disallowed.
- Phase 3b: each run has a fresh `$SCRATCH_DIR`, so no scratch collision. Phase 4.1 then mirrors the blueprint to `<repo>/docs/rag-steroids/` — re-running the skill on the same repo overwrites the in-repo copy. That's intentional; the blueprint is a derived artifact, git history is the archive.
- Phase 3c: same as 3b — fresh scratch dir per run; the in-repo `CLAUDE_SKILLS_FOR_<repo>.md` gets regenerated on each run.
- Phase 4.1: `browzer workspace docs --add` is idempotent on the CLI side — re-adding a path that's already tracked is a no-op.
- Phase 4.2: writes/merges `<repo>/.browzer/search-triggers.json` as a sorted-deduped union of the existing file (if any) and `vocab_suggestions`. Pure additive — never removes or reorders existing entries. If `vocab_suggestions` is empty, Phase 4.2 is a no-op.
- Phase 4.3: commit includes sweeper fixes + `CLAUDE.md` + `.browzer/config.json` + `.browzer/search-triggers.json` + `.gitignore` + `docs/rag-steroids/*.md`. A second run usually produces only a docs-refresh commit (the blueprint/skill-map regenerates; the init artifacts already exist). If every artifact is byte-identical, the commit step is a no-op.

## Hard constraints

- **Never** `rm -rf $SCRATCH_DIR` before the run completes — later phases depend on its contents. After 4.4 it's safe to `rm -rf "$SCRATCH_DIR"` or leave it for the OS to reap (`mktemp` dirs survive logout but are cleaned on tmpfs reboots).
- **Never** `browzer workspace delete` from inside this skill. Workspace lifecycle is `workspace-management`'s job.
- **Never** `git push` from inside this skill. `/commit` stops at the commit; pushing is a human decision.
- **Never** skip the user confirmation in Phase 3 if the working tree is dirty. Mixing unrelated work into the bootstrap commit is the #1 way to poison the trail.

## When to refuse

- User asks to run this on a repo that has **no `.git`**. Browzer works on directories, but the commit step requires git. Offer to run Phases 1–3 only and skip 4.3.
- User asks to run this against a **public OSS repo they don't own**. You'd be uploading its docs to their Browzer workspace — that's fine technically, but call it out so they know what they're doing.
- User asks to run this on their **home directory** or **/**. Refuse — the doc-drift agent will explode on the world.

## Output contract

Per the plugin's `README.md` §"Skill output contract" (at `../../README.md` relative to this file). The full shape, allowed warnings, banned patterns, and machine-readable report schema are specified in-line in Phase 4.4 above — the skill emits ONE confirmation line plus a JSON report at `<repo>/docs/rag-steroids/GIVE_CLAUDE_RAG_STEROIDS_<timestamp>.json`. Never print the ✅-banner, the phase-by-phase summary, or the "Next steps you can run right now" block — those are the v2.0.0 anti-patterns this skill retired.

## Related skills

- `use-rag-cli` — install + authenticate (anchor skill; this skill assumes auth).
- `embed-workspace-graphs` — `browzer init` + `browzer workspace index` (Phases 1 + 2 wrap this).
- `embed-documents` — the interactive doc picker (fallback for Phase 4.1).
- `explore-workspace-graphs` — the hybrid search this skill's agents should use instead of grep.
- `dependency-graph` — `browzer deps` for blast-radius queries the blueprint agent will run.
- `workspace-management` — when the user actually wants to delete / relink a workspace.
- `commit` — Conventional-Commits + Browzer-org attribution for Phase 4.3.

## Why this skill exists

Browzer gives Claude **context**. Claude-skills give Claude **method**. A fresh repo has neither wired up: the workspace doesn't exist, the docs are stale from the last refactor, the DEFAULT_VOCAB in the search guard doesn't know about this stack's weird framework choice, and the ten installed skills Claude would benefit from knowing about sit in `~/.claude/skills` unranked. This skill closes all four gaps in one pass so the next `/` command the user types is already steroidal.
