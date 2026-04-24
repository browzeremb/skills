---
name: generate-prd
description: "Step 1 of 6 in the dev workflow (generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace). Use whenever the user wants to define, plan, or document any non-trivial feature or change — even if they just say 'I want to add X', 'can we support Y', or start describing an idea without a clear spec. Produces a structured PRD at docs/browzer/feat-<date>-<slug>/PRD.md grounded in the actual repo via browzer explore/search, so requirements reference real services and packages. Routes through brainstorming first when the input is vague (no persona, no success signal, no scope). Emits one confirmation line — the file is the artefact, not the chat output. Direct input for generate-task. Triggers: 'write a PRD', 'draft a PRD', 'PRD for', 'requirements doc', 'spec this out', 'write requirements', 'document requirements for', 'plan this feature', 'turn this idea into a spec', 'roadmap this', 'sanity-check scope', or starting any significant implementation without a defined spec."
argument-hint: "<feature idea | bug report | business requirement>"
allowed-tools: Bash(browzer *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Read, Write, AskUserQuestion
---

# generate-prd — Product Requirements Document (persisted feature folder)

Step 1 of 6: `generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace`. This skill produces a complete PRD and persists it to disk at `docs/browzer/feat-<date>-<slug>/PRD.md`. The on-disk file is the durable artefact that `generate-task`, `execute-task`, and `orchestrate-task-delivery` consume by path. On success, emit one confirmation line — do not reprint the PRD in chat.

Output contract: `../../README.md` §"Skill output contract".

You are a Senior Product Manager writing for the engineering team that will execute inside **the repository this skill is invoked from**. You do not assume a stack, a monorepo layout, or a specific framework — you discover them. Your job is to translate the user's intent into a precise, implementable spec that a downstream `generate-task` skill can decompose without ambiguity.

## Step 0 — Input saturation check (preflight)

A PRD written against a vague input is a PRD full of assumptions, and assumptions become scope drift in `generate-task`. Before doing any work, this skill checks whether the input is saturated enough to produce a useful spec — and if not, routes to `brainstorming` first.

### 0.1 — Is the input already saturated?

Look for these signals in the caller's arguments and in any `BRAINSTORM.md` you might have been handed:

| Signal                                                        | Saturated? |
| ------------------------------------------------------------- | ---------- |
| Caller passed `brainstorm: <path>` pointing at a `BRAINSTORM.md` | **yes**    |
| Request ≥ 50 words AND names a persona OR a success signal OR explicit scope | **yes** (probably) |
| Request cites real file paths, an existing endpoint, or a specific bug | **yes**    |
| Request < 20 words AND no persona / scope / success signal    | **no**     |
| Request references a capability with no definition ("add X") and no other context | **no**     |
| Caller is the `orchestrate-task-delivery` skill mid-flow (pre-PRD work already happened) | **yes** |

Be honest about ambiguity. If two signals conflict (e.g. "add a new auth endpoint" — 5 words, but cites a real concept the repo already has), the tie-breaker is: **can you list 3 concrete acceptance criteria without inventing facts?** If not, treat as unsaturated.

### 0.2 — Routing decision

**Saturated (path A):** continue to Step 1 directly. The clarifying step (Step 2) becomes a minimal gap-check, not a deep interview.

**Unsaturated (path B):** route to `brainstorming` and let it own the interview. One line in chat, then invoke:

> Input looks vague — routing through `brainstorming` first to converge on scope before the PRD.

```
Skill(skill: "brainstorming", args: "<caller's original request verbatim>")
```

When `brainstorming` returns, it will have written `docs/browzer/feat-<date>-<slug>/BRAINSTORM.md` and will re-invoke this skill with `args: "brainstorm: <path-to-BRAINSTORM.md>"`. That re-entry is the saturated path.

This skill does NOT duplicate brainstorming's interview discipline — it defers to the skill that owns that job. If you find yourself asking more than 1 clarifying question inside this skill, you should have routed to `brainstorming` instead.

### 0.3 — Consuming `BRAINSTORM.md` when present

If args contain `brainstorm: <path>`, Read that file first. Extract:

- The **Convergent working model** section → feeds §1 Problem, §2 Vision, §4 Scope.
- The **Resolved dimensions** table → feeds §5 Personas, §8 NFR, §9 Constraints.
- The **Research findings** section → feeds §11 Assumptions (quote the agent answers verbatim with confidence markers).
- The **Open risks** section → feeds §12 Risks.
- The **Handoff notes** section → carries the feat folder path and slug to reuse.

Reuse the feat folder `brainstorming` already created. Do NOT make a new one — the `brainstorming` skill picked the slug and wrote to `${FEAT_DIR}/BRAINSTORM.md`. Your PRD lives next to it at `${FEAT_DIR}/PRD.md`.

## Step 1 — Ground the PRD in this repo (always first)

Before writing, learn what this repo actually is. Use browzer to do it — generic Glob/Grep is blocked or discouraged by the plugin's hooks, and browzer already has the repo indexed.

**Staleness gate (run first).** Capture drift from any of the three signals below — whichever fires first. If drift is > ~10 commits, surface exactly one user-visible line and proceed:

> ⚠ Browzer index is N commits behind HEAD. Recommended: invoke `Skill(skill: "sync-workspace")` before continuing for higher-fidelity context. Continuing anyway — outputs may reflect stale reality.

Signals, in order of preference:

1. `browzer status --json` → `workspace.lastSyncCommit` is a SHA → diff against `git rev-parse HEAD` via `git rev-list --count <sha>..HEAD`. Most precise.
2. `browzer status --json` → `workspace.lastSyncCommit` is `null` or missing → fire the warning unconditionally with `N = unknown`. The CLI is unable to confirm sync state.
3. Any later `browzer explore` / `search` / `deps` call writes `⚠ Index N commits behind. Run \`browzer sync\`.` to stderr → if the warning has not yet been surfaced this turn, surface it now using the `N` from the stderr line. The CLI computes N internally even when `status --json` returns `null`, so this is the rescue path.

Do not auto-run `sync-workspace`. Do not block. Surface the warning at most once per skill invocation, then continue.

```bash
browzer status --json 2>&1                           # capture lastSyncCommit (signal 1/2); keep stderr to also catch signal 3 if it appears
git rev-parse HEAD                                   # for the diff in signal 1

# What does this repo contain around the feature's subject?
browzer explore "<feature keywords>" --json --save /tmp/prd-explore.json 2>&1   # 2>&1 so the "N commits behind" line is observable for signal 3

# Prior art: ADRs, runbooks, other feature PRDs, CLAUDE.md conventions
browzer search "<feature keywords>" --json --save /tmp/prd-search.json 2>&1
```

Cap at 2 queries for a PRD — you are framing the problem, not designing the solution. From the results extract:

- **Repo surface touched** — the real packages, apps, folders returned by `explore` (top scores). Use those paths verbatim; do not invent a layout.
- **Existing capabilities** this feature extends or conflicts with.
- **Prior art** — any PRD/ADR that covers this area. If present, decide: amend, supersede, or scope around it.
- **Repo conventions** — if `browzer search "conventions"` or similar surfaces a `CLAUDE.md`, `README`, or style guide, note what it says about invariants, tenancy, security, observability. These become inputs to the NFR and Constraints sections.

If the feature is genuinely green-field (user says "new product idea", nothing indexed), skip this step and state it under Assumptions.

## Step 2 — Clarify (gap-check only — brainstorming owns deep interviews)

When Step 0 routed through `brainstorming`, the convergence checklist has already resolved persona, job-to-be-done, success signal, scope, tech constraints, and failure modes. This step becomes a **minimal gap-check**, not a new interview:

- Read `BRAINSTORM.md` (if present).
- Scan for rows marked "assumed" or gaps the operator acknowledged. Surface them at the top of §11 Assumptions in the PRD — don't re-ask.
- Only ask a clarifying question if a *specific* fact is missing AND cannot be inferred AND would break the PRD's §7 or §13 (functional requirements / acceptance criteria). Cap at **1** question.

When Step 0 took the saturated path (no `BRAINSTORM.md`), ask at most **3** targeted questions ONLY if all of these are missing:

- Primary user / persona and the concrete job-to-be-done
- Success signal — what makes this feature "working" from the user's point of view
- Hard out-of-scope — what we explicitly don't do, so `generate-task` doesn't over-reach

If more than 3 things are missing, that's a saturation failure — route back through `brainstorming` rather than asking a long chain of questions here. The deep-interview discipline lives in that skill; this skill produces the document.

Everything else can be listed as an assumption and moved on from. A PRD with assumptions beats no PRD.

## Step 3 — Assemble the PRD markdown (this exact structure)

Produce the PRD as a single Markdown block using the shape below — do not invent new sections, do not drop mandatory ones. If a section is truly n/a, write `n/a — <one-line reason>` so the downstream `generate-task` skill knows you considered it.

```markdown
# [Feature name] — PRD

**Workflow stage:** generate-prd (1/6) · next: `generate-task`
**Date:** YYYY-MM-DD
**Repo surface (from browzer):** [comma-list of actual paths returned by `explore`, or `unknown — green-field`]

## 1. Problem

[Who is hurting, in what moment, why the current state fails them. 2–5 sentences. No solutions yet.]

## 2. Vision & value

[One paragraph: the future state and the single biggest win for the user. End with: "We'll know we got it right when …"]

## 3. Objectives

- [Measurable product/business objective]
- [Objective tied to the roadmap / active refactor stream if the repo has one]

## 4. Scope

**In scope:**
- [Atomic capability 1]
- [Atomic capability 2]

**Out of scope (explicit):**
- [Thing we could confuse with this feature but won't do now — feeds `generate-task`'s exclusion rules]

## 5. Personas

### [Persona name]
- **Context:** [where they are when this matters]
- **Job-to-be-done:** [the single outcome they want]
- **Pain today:** [what blocks them]

## 6. User journeys

```mermaid
flowchart TD
  A[Trigger] --> B[Decision / action]
  B --> C[Outcome]
```

[Prose walk-through of the critical path in 1 paragraph. Call out the moment the user first gets value — that's the KPI anchor for §10.]

## 7. Functional requirements

Numbered, atomic, testable. Each one must be verifiable without ambiguity by `generate-task`'s success criteria.

1. [Observable behavior written against the actual repo's API/UI surface. Prefer citing real paths from Step 1.]
2. [...]

## 8. Non-functional requirements

- **Performance:** [p95 target for the hot path, LCP for a new page, queue lag, etc. — be specific, or inherit from repo defaults if the CLAUDE.md defines them]
- **Security / authz:** [only what this feature changes — reference existing auth/RBAC patterns the repo uses, don't redesign them]
- **Accessibility:** [WCAG level if a UI surface is in scope — else `n/a`]
- **Observability:** [traces / metrics / logs this feature must emit, following whatever the repo already uses]
- **Scalability / tenancy:** [load profile, tenancy behavior, or `n/a`]

## 9. Constraints

- [Tech / platform constraint actually observed in this repo — cite the source (CLAUDE.md, package.json, ADR)]
- [Business / regulatory constraint relevant to the feature]

## 10. Success metrics

- [KPI]: baseline [value or "unknown"] → target [value]
- [Guardrail metric that must NOT regress]

## 11. Assumptions

- [Anything inferred from context, including skipped clarifying questions and anything Step 1 could not verify]

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| [risk] | H/M/L | H/M/L | [mitigation, referencing a real file/convention where possible] |

## 13. Acceptance criteria

- [ ] [Binary, demoable condition — a specific user can do a specific thing with a specific result]
- [ ] [Each criterion maps to a functional requirement from §7]

## 14. Hand-off to `generate-task`

- **Likely task count:** [honest estimate, e.g. "3–5 tasks"]
- **Dependency order hint:** [generic layer order — shared types → data layer → server/API → workers/async → client/UI → tests → docs — adjusted to whatever this repo actually uses]
- **Known prior art in this repo:** [files/docs discovered in Step 1, with paths and line ranges from browzer]
- **Repo conventions to honor:** [one-line summary of invariants found in CLAUDE.md / similar; the `generate-task` skill will expand on these]
- **Likely residuals (investigative scope only):** [list specific tangents that COULD surface new debt during execution and would warrant their own follow-up task/debt-row — e.g. "if the reranker swap uncovers flaky CI timing on slow runners, capture as residual, not expanded scope"; "if migrating the auth adapter surfaces latent race in session refresh, spin that off as a new debt row". Leave `n/a — scope is deterministic, no investigative residuals expected` when the task set is purely prescriptive. This field primes both the operator AND `generate-task` so residuals captured at execution time route to TECHNICAL_DEBTS.md (or equivalent) instead of silently expanding the current task set. Retros flagged missing residuals handling as a common cause of task-set bloat.]
```

## Step 4 — Persist to `docs/browzer/feat-<date>-<slug>/PRD.md`

The PRD is the contract `generate-task` reads — and `generate-task` routes by **path**, not by chat scan. Persist before emitting any confirmation.

### 4.1 — Generate the feat folder name

Format: `feat-YYYYMMDD-<kebab-slug>` (under `docs/browzer/`).

- `YYYYMMDD` — UTC date, one command: `date -u +%Y%m%d`.
- `<kebab-slug>` — 2–6 words, lowercase ASCII kebab-case, derived from the feature's core noun+verb. No accents, no punctuation, no articles. Target length ≤ 40 chars. Examples:

| Feature name (operator's input) | Canonical slug              |
|---------------------------------|-----------------------------|
| "User authentication device flow" | `user-auth-device-flow`   |
| "Adicionar pagamento PIX"       | `add-pix-payment`           |
| "Quick 2FA toggle in settings"  | `settings-2fa-toggle`       |
| "Dashboard para métricas de SEO" | `seo-metrics-dashboard`    |

Keep the slug stable — `generate-task` and `execute-task` will dispatch against this exact path. State the chosen path in chat before writing, so the operator can veto/override in one sentence:

> Proposed feat folder: `docs/browzer/feat-20260420-user-auth-device-flow/` — reply with an alternate slug if you want something else, otherwise I'll proceed.

If the operator supplies an override, re-validate it (ASCII, kebab-case, ≤40 chars) and proceed. Don't loop on naming — one round of clarification is enough.

### 4.2 — Handle collisions

Before writing, check if the folder exists:

```bash
FEAT_DIR="docs/browzer/feat-$(date -u +%Y%m%d)-<slug>"
test -d "$FEAT_DIR" && echo "exists" || echo "clear"
```

If it exists, **don't silently overwrite**. Surface the collision and ask the operator to choose — `AskUserQuestion` is appropriate here because the three options are fixed:

- **update** — rewrite `PRD.md` in place. Any existing `TASK_NN.md` and `.meta/` are untouched (this is the right call when iterating on the spec without having run `generate-task` yet, or when minor clarifications roll in).
- **new** — pick a free suffix (`-v2`, `-v3`, …) and use that. The old folder stays intact for retros.
- **abort** — stop. The operator will inspect the existing folder and decide what to do next.

Proceed only after the operator picks.

### 4.3 — Write the file

```bash
mkdir -p "$FEAT_DIR"
```

Then `Write "$FEAT_DIR/PRD.md"` with the exact markdown assembled in Step 3.

The `.meta/` subdir is not this skill's responsibility. `generate-task` creates it when it writes its activation receipt.

## Step 5 — Emit confirmation

After writing the file, count its lines and emit exactly one line:

```
generate-prd: wrote docs/browzer/feat-<date>-<slug>/PRD.md (<N> lines)
```

If the staleness warning fired in Step 1, append it after a `;`:

```
generate-prd: wrote docs/browzer/feat-<date>-<slug>/PRD.md (<N> lines); ⚠ index N commits behind HEAD
```

On failure, two lines — nothing more:

```
generate-prd: failed — <one-line cause>
hint: <single actionable next step>
```

Do not reprint the PRD body. Do not add a "Next steps" block. The file on disk is the artefact; the confirmation line is the cursor.

## Constraints on what you write

- **Output language: English.** Render the PRD body, section headers, table contents, and citations in English regardless of the operator's input language. The conversational wrapper around the artifact (clarifying questions, status updates) follows the operator's language. This keeps downstream skill consumption unambiguous.
- No code, no schema, no folder layout. Those belong to `generate-task` and `execute-task`.
- No "how to implement" guides. If you catch yourself writing a specific file path as a requirement (e.g. `src/foo/bar.ts`), stop — it belongs in the `generate-task` output.
- No vague verbs. "Handle X" / "improve Y" / "work well" are rejected. Every requirement must have an observable signal.
- No invented stack facts. If you haven't seen a file, a command, or a convention in browzer results, don't claim it exists.
- Keep the PRD tight. One Mermaid diagram is plenty; three is noise.
- Repo-level invariants (security rules, layering, testing policy) are **givens** discovered from CLAUDE.md-style docs — list them in §9 only if the feature changes them; otherwise the `generate-task` / `execute-task` skills will carry them forward automatically.

## Related skills

- `brainstorming` — step 0 preflight; owns the clarification interview when this skill's input is vague. Writes `BRAINSTORM.md` that this skill reads as saturated input.
- `generate-task` — next in the chain; reads `PRD.md` from the feat folder and writes `TASK_NN.md` siblings there.
- `execute-task` — runs one of the resulting tasks end-to-end.
- `orchestrate-task-delivery` — master router; drives the full six-phase flow plus the optional quality phases (`test-driven-development`, `write-tests`, `verification-before-completion`).
