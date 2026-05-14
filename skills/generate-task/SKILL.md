---
name: generate-task
description: "Decompose a finished PRD + EXPLORATION.md into per-task `TASK_NN.md` files. Groups work by DOMAIN bucket (never one task per file), inlines AC/FR text verbatim from PRD so each task is a CLOSED PROMPT for execute-task, copies `skillsFound[]` + `blastRadius` from EXPLORATION.md so no downstream skill re-queries browzer. Single-pass Reviewer (the Explorer pass moved to `scope-feature`)."
when_to_use: "break this PRD into tasks, generate tasks, plan the implementation, decompose this spec, task plan, task breakdown, sequence the work, split this into PRs, how should I sequence this, /generate-task"
arguments: [featureId]
allowed-tools: Read Write Bash(browzer *) Bash(node *) Bash(cat *) Bash(printf *) Bash(jq *) Bash(git *) Bash(ls *)
---

You are a senior Product Owner task decomposer. Your only inputs are `EXPLORATION.md` (file map, blast radius, resolved domain skills) and `PRD.md` (FR/AC verbatim text for inlining). Your only outputs are per-task `TASK_NN.md` files plus the bundled script that renders `TASK_GRAPH.md`. Group work by domain bucket — never one task per file. Each `TASK_NN.md` MUST be a closed prompt: execute-task reads only that file, never PRD or EXPLORATION.

## Inputs

- `$featureId` — Stable identifier matching `^feat-[0-9]{8}-[a-z0-9-]+$`. Identifies `docs/browzer/<feat-id>/staging/` (per the staging-folder discipline in `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md`).

You read three files:

- `docs/browzer/$featureId/staging/EXPLORATION.md` — REQUIRED. Domain map + blast radius + skillsFound. Fail fast if absent: `generate-task: EXPLORATION.md not found — run /scope-feature $featureId first`.
- `docs/browzer/$featureId/staging/PRD.md` — REQUIRED. FR/AC text for verbatim inlining into each TASK.
- `docs/browzer/$featureId/staging/USER_STORIES.md` — OPTIONAL. Story narrative for granularity context.

## Output contract

Write under `docs/browzer/$featureId/staging/`:

| Path               | Produced by                     | Role                                                                                |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------- |
| `TASK_NN.md` (× N) | You (LLM authoring)             | Per-task closed prompt — frontmatter is the contract execute-task reads             |
| `TASK_GRAPH.md`    | `scripts/render-task-graph.mjs` | OPTIONAL — emit only when `CONFIG.executionStrategy != "serial"`. Manifest frontmatter (order, deps, parallelizable groups) + mermaid `graph TD` body |

The canonical TASK*NN.md shape lives in `${CLAUDE_SKILL_DIR}/template.md` — read it before authoring. There is no separate manifest file — the orchestrator discovers tasks by globbing `TASK*\*.md`and reading the manifest frontmatter of`TASK_GRAPH.md`.

## Preflight — PRD drift check

EXPLORATION.md captures the `prdSha` of the PRD it was grounded on. If the PRD has been edited since scoping, the inlined FR/AC text in EXPLORATION.md is stale and any tasks authored from it inherit that staleness.

```bash
EXP_SHA=$(grep -E '^prdSha:' docs/browzer/$featureId/staging/EXPLORATION.md | awk '{print $2}')
NOW_SHA=$(git hash-object docs/browzer/$featureId/staging/PRD.md)
[ "$EXP_SHA" = "$NOW_SHA" ] || echo "WARN: PRD has drifted since scoping — re-run /scope-feature $featureId before proceeding."
```

If the SHAs diverge, halt and surface the warning to the operator. Re-running scope-feature is the right fix; never paper over drift by re-deriving inlined text from current PRD inside generate-task.

## Read context

Parse EXPLORATION.md frontmatter — extract `prdSha`, `domains[]` (with `relatedFRs[]`, `likelyFiles[]`, `skillsFound[]`), `sensitiveScopeHits[]`, and `featureBlastRadius`. Parse PRD.md frontmatter — extract `functionalRequirements[]` (full text) and `acceptanceCriteria[]` (text + bindsTo).

You will use:

- `domains[].relatedFRs[]` → the FR IDs that scope this bucket
- `domains[].likelyFiles[]` → become `scope.files[]` on the task
- `domains[].skillsFound[]` → become `task.skillsFound[]` on the task (verbatim copy)
- `PRD.acceptanceCriteria[].text` → inline as `bindsTo[].acText` on the task
- `PRD.functionalRequirements[].text` → inline as `bindsTo[].frText` on the task
- `EXPLORATION.sensitiveScopeHits[]` → drive the invariant gate (see below)

## Domain → task mapping

Default 1:1: one entry in `EXPLORATION.md.domains[]` becomes one `TASK_NN.md`. Two cases override:

- **Split** when a bucket >10 files AND files cluster into ≥2 distinct conceptual surfaces. Emit two tasks with `dependsOn[]` if ordering matters. Each task gets `granularityNote.verdict: split` and a rationale naming the split lines.
- **Collapse** when two adjacent buckets (<2 files each) share a domain prefix. Emit one merged task with `granularityNote.verdict: collapse` and a rationale.

Full heuristics in `${CLAUDE_SKILL_DIR}/references/granularity-heuristics.md`.

Bucket → role inference (free-form but conventional). Derive `role` from
the bucket's path and the file extensions it contains — NOT from a fixed
enum, because every host repo lays out its apps/packages differently.

| Bucket signal                                                                                                                                                                                                    | Typical role                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Path matches `apps/<X>/`, `services/<X>/`, `<X>/` at repo root with directory-name in {web, ui, dashboard, frontend, mobile, admin, app}, OR bucket files are predominantly `.tsx` / `.jsx` / `.vue` / `.svelte` | `frontend`                                                                    |
| Path matches `apps/<X>/`, `services/<X>/`, `<X>/` with directory-name in {cli, cmd, bin, tool, tools} OR bucket files are predominantly `main.go` / a `cmd/` tree                                                | `cli`                                                                         |
| Path matches `apps/<X>/`, `services/<X>/`, `microservices/<X>/`, `<X>/` with directory-name in {api, server, service, auth, gateway, worker, queue, ingest, rag, search, billing, orchestrator}                  | `backend`                                                                     |
| Path under `packages/<X>/`, `libs/<X>/`, `modules/<X>/`, `crates/<X>/`, `internal/<X>/` and the file mix is server/library code (no UI framework files)                                                          | `backend`                                                                     |
| Path under any of the above with `skills/`, `prompts/`, `agents/` in the directory name AND files are markdown-only                                                                                              | `skill-author`                                                                |
| Path under `infra/`, `monitoring/`, `deploy/`, `terraform/`, `docker/`, `helm/`, `.github/workflows/`, top-level `Dockerfile` / compose files                                                                    | `infra`                                                                       |
| Path under `docs/` (excluding `docs/browzer/` which is plugin-internal state)                                                                                                                                    | `docs`                                                                        |
| Anything else                                                                                                                                                                                                    | `backend` (fallback — assume server-side code unless evidence says otherwise) |

When the heuristics disagree (e.g. a bucket holds both `.tsx` and
`.go`), pick the role of the _majority_ extension and surface a
granularity note. The role is advisory — execute-task uses it to pick a
specialist subagent profile, not to gate behaviour.

## Canonical-phase suppression filter

Reject candidate tasks that duplicate the work of later canonical phases — `write-tests`, `code-review`, `receiving-code-review`, `feature-acceptance`, `finalize-feature` (doc patching + README finalization), `commit`. Do NOT emit a TASK_NN.md for these. Full filter list and rationale: `${CLAUDE_SKILL_DIR}/references/task-decomposition.md`.

## Sensitive-scope invariants gate

For every TASK_NN.md whose `scope.files[].path` intersects `EXPLORATION.md.sensitiveScopeHits[].path`, `task.invariants[]` MUST be non-empty. Empty `invariants[]` on a sensitive-scope task is a hard refusal — do not emit the file. Two acceptable resolutions:

- **A — Discover and populate**: `browzer explore "<domain-term>"` or `browzer search "<topic>"` over the matched paths; surface a project convention and add `{rule, source}` to `invariants[]`.
- **B — Sentinel rationale**: When no invariant exists, add a single entry:
  ```yaml
  invariants:
    - rule: "INVARIANT_RATIONALE: <free text explaining the absence>"
      source: "generate-task-reviewer"
  ```

Downstream skills (`receiving-code-review`, `feature-acceptance`) skip `INVARIANT_RATIONALE:`-prefixed entries when counting real contract violations. The predicate definition (path-glob + content-grep) lives in:

- Cross-skill base: `../../references/sensitive-paths.md`
- Extended patterns: `../../skills/scope-feature/references/sensitive-paths-extended.md`

scope-feature already ran the matcher and persisted hits — generate-task only reads the result.

## Auto-trivial routing (set `trivial: true` automatically)

`execute-task`'s inline fast-path is gated on `task.trivial == true`. By
default, decomposed tasks ship with `trivial: false` — which forces
every task through a full coder-subagent dispatch even when the work is
two-file surgical edits with no skills and no real invariants. In
production this produces hundreds of redundant tokens per trivial task.

**Auto-set `trivial: true`** on a task when ALL of the following hold
simultaneously:

1. `scope.files.length ≤ 2`
2. `skillsFound.length == 0`
3. Every `invariants[].rule` either:
   - starts with `INVARIANT_RATIONALE:` (sentinel — not a real invariant), OR
   - the `invariants[]` array is empty entirely
4. No `scope.files[].path` intersects `EXPLORATION.sensitiveScopeHits[].path`
5. No `scope.files[].blastRadius.reverse[].length > 0` — i.e. the changed surface has no reverse importers

When all five conditions hold, `execute-task`'s gate logic would
already route the task inline; setting `trivial: true` at decomposition
time eliminates one redundant evaluation and surfaces the routing
decision to the operator in `TASK_GRAPH.md` (the trivial-marked tasks
show up with a `[fast-path]` annotation in the rendered graph).

When ANY condition fails, leave `trivial: false`. This is conservative
by design — false negatives (a trivial task incorrectly marked
non-trivial) cost one dispatch; false positives (a non-trivial task
incorrectly routed inline) skip skill loading + blast-radius probe and
can ship a broken change.

Record the heuristic outcome in the task's `granularityNote.rationale`:

```yaml
granularityNote:
  verdict: ok
  rationale: "auto-trivial: ≤2 files, zero skills, no real invariants, empty blast radius → inline fast-path"
```

## Slim acceptanceCriteria frontmatter (token-economy)

`acceptanceCriteria[].bindsTo[]` MAY ship as a pointer-only pair
(`{acId, frId}`) when the verbatim AC/FR text would otherwise inflate
TASK_NN.md beyond ~6 KB. `execute-task` runs
`node scripts/expand-task-acs.mjs TASK_NN.md` at dispatch time, which
resolves each `bindsTo[]` row against the feature's PRD.md and rewrites
the frontmatter into the legacy self-contained shape the dispatched
subagent reads.

Two modes coexist; the helper picks based on content shape:

| Frontmatter shape                                          | When                                                                         | Helper behaviour                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bindsTo: [{acId, frId, acText, frText}]` (legacy, inline) | Default for tasks under the auto-trivial threshold                           | `expand-task-acs.mjs` echoes the file unchanged                                           |
| `bindsTo: [{acId, frId}]` (slim, pointer-only)             | Tasks whose verbatim FR/AC bodies are large enough to be worth deduplicating | `expand-task-acs.mjs` resolves text from PRD.md and prints expanded frontmatter to stdout |

The closed-prompt invariant for `execute-task` is satisfied by EITHER
mode: legacy tasks read self-contained text from their own frontmatter;
slim tasks read self-contained text from the helper's stdout (which
inlines PRD-resolved verbatim strings without execute-task ever opening
PRD.md). Drift detection still flows through `prdSha` — slim tasks
carry the same `prdSha:` field, so a PRD edit invalidates them too.

`generate-task` MAY emit slim tasks but is not required to; emit slim
only when the resulting size delta is meaningful.

## HTTP route consumer-contract pass

When ANY `scope.files[].path` is a server route (path contains `/routes/`, `/handlers/`, `/controllers/`, ends with `-route.ts`, `-handler.ts`, or matches `**/api/**/*.{ts,js,go}`): read the file's `blastRadius.reverse[]` from EXPLORATION.md. Reverse importers under a frontend or web entrypoint indicate consumer contracts — surface them in the task body's `## Implementation hints` section. Add an `invariants[]` entry per undocumented field, OR flag in `granularityNote.rationale`.

## testSpecs[] closure — structured pins, not prose

`testSpecs[]` is consumed by `write-tests` (Phase 8), NOT by execute-task. The closure principle still applies INTRA-FILE: when a test spec pins an AC or FR, encode it via the structured `pinsAcs: [AC-NN]` and `pinsFrs: [FR-NN]` arrays. Do NOT write narrative pinning into `description` (e.g. "Pins AC-03 / FR-03") — that forces write-tests to scan back into `acceptanceCriteria[]` for context with no machine-readable anchor.

Every `pinsAcs[]` and `pinsFrs[]` ID MUST already appear in this task's `acceptanceCriteria[].bindsTo[]` — a test cannot pin an AC the task itself does not bind. The template carries this as cross-reference invariants 11–13.

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/template.md` — canonical TASK_NN.md shape.
2. Run preflight: check `prdSha` consistency between EXPLORATION.md and PRD.md.
3. Parse EXPLORATION.md + PRD.md frontmatter.
4. For each domain in `EXPLORATION.md.domains[]`: decide split / collapse / 1:1 → produce N task candidates.
5. Apply the canonical-phase suppression filter; record suppressed candidates in the decisions JSON.
6. For each surviving task: author `docs/browzer/$featureId/staging/TASK_NN.md` matching the template. Inline AC text + FR text + blast radius + skillsFound VERBATIM from source artifacts.
7. Apply the sensitive-scope gate; reject + re-author any task whose invariants[] is empty against a sensitive surface (Resolution A or B).
8. Apply the **auto-trivial heuristic**: when all five conditions hold (§ Auto-trivial routing), set `task.trivial: true` and annotate `granularityNote.rationale`. Otherwise leave `trivial: false`.
9. Set `granularityNote` per task (always `ok` when no concerns; otherwise `split`/`collapse`/`premature` with rationale).
10. Render the manifest + visual graph ONLY when the resolved `CONFIG.executionStrategy != "serial"`:
    ```bash
    node ${CLAUDE_SKILL_DIR}/scripts/render-task-graph.mjs $featureId
    ```
    In serial runs, executor reads `TASK_NN.md` files directly and the graph is dead weight — skip the render.

## Done when

- One `docs/browzer/$featureId/staging/TASK_NN.md` exists per surviving domain task.
- Every TASK_NN.md has non-empty `acceptanceCriteria[]` and `scope.files[]`.
- Every `bindsTo[].acText` and `bindsTo[].frText` matches PRD.md verbatim (whitespace-normalised).
- Every `scope.files[].blastRadius` is copied verbatim from EXPLORATION.md.
- Every `skillsFound[].installedAt` was already verified by scope-feature; trust the source.
- Every task whose `scope.files[].path` intersects `sensitiveScopeHits[]` has non-empty `invariants[]` (real or sentinel).
- `docs/browzer/$featureId/staging/TASK_GRAPH.md` exists when `CONFIG.executionStrategy != "serial"`.

Return one line:

> `generate-task: <N> tasks written, <S> suppressed, <G> non-ok granularity flags.`

Your turn is incomplete until all TASK_NN.md files exist on disk. Do not stop to summarize after writing them.
