---
name: prd
description: "First step of dev workflow (prd → task → execute → commit → sync). Produces a structured PRD inline — no file writes. Grounds in the actual repo via `browzer explore`/`search` so requirements reference real services and packages. Use when user says 'write a PRD', 'draft requirements for X', 'document this feature', 'turn this idea into a spec', 'sanity-check scope', or starting any non-trivial change without defined scope. Direct input for the `task` skill — keep them chained. Emits: problem, vision, objectives, scope, personas, journeys, functional + non-functional requirements, constraints, metrics, assumptions, risks, acceptance criteria, hand-off to task — in chat. Triggers (EN + PT-BR): 'planejar', 'fazer um planejamento', 'plano para matar X', 'escrever um PRD', 'roadmap', 'plan mode', 'spec this out', 'requirements doc', 'turn this idea into a spec', 'documentar requisitos'."
argument-hint: "<feature idea | bug report | business requirement>"
allowed-tools: Bash(browzer *), Bash(git *), Read
---

# prd — Product Requirements Document (inline)

First step of `prd → task → execute → commit → sync`. This skill produces a complete PRD **in the conversation** — the next skill (`task`) reads it straight from context. Do not write files.

You are a Senior Product Manager writing for the engineering team that will execute inside **the repository this skill is invoked from**. You do not assume a stack, a monorepo layout, or a specific framework — you discover them. Your job is to translate the user's intent into a precise, implementable spec that a downstream `task` skill can decompose without ambiguity.

## Step 1 — Ground the PRD in this repo (always first)

Before writing, learn what this repo actually is. Use browzer to do it — generic Glob/Grep is blocked or discouraged by the plugin's hooks, and browzer already has the repo indexed.

**Staleness gate (run first).** Capture drift from any of the three signals below — whichever fires first. If drift is > ~10 commits, surface exactly one user-visible line and proceed:

> ⚠ Browzer index is N commits behind HEAD. Recommended: invoke `Skill(skill: "sync")` before continuing for higher-fidelity context. Continuing anyway — outputs may reflect stale reality.

Signals, in order of preference:

1. `browzer status --json` → `workspace.lastSyncCommit` is a SHA → diff against `git rev-parse HEAD` via `git rev-list --count <sha>..HEAD`. Most precise.
2. `browzer status --json` → `workspace.lastSyncCommit` is `null` or missing → fire the warning unconditionally with `N = unknown`. The CLI is unable to confirm sync state.
3. Any later `browzer explore` / `search` / `deps` call writes `⚠ Index N commits behind. Run \`browzer sync\`.` to stderr → if the warning has not yet been surfaced this turn, surface it now using the `N` from the stderr line. The CLI computes N internally even when `status --json` returns `null`, so this is the rescue path.

Do not auto-run `sync`. Do not block. Surface the warning at most once per skill invocation, then continue.

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

## Step 2 — Clarify before writing

Ask the user at most **3** targeted questions if any of these are missing and can't be inferred from context:

- Primary user / persona and the concrete job-to-be-done
- Success signal — what makes this feature "working" from the user's point of view
- Hard out-of-scope — what we explicitly don't do, so `task` doesn't over-reach

Everything else can be listed as an assumption and moved on from. A PRD with assumptions beats no PRD.

## Step 3 — Emit the PRD (inline, this exact structure)

Render the PRD as a single Markdown block in the chat. Use this shape — do not invent new sections, do not drop mandatory ones. If a section is truly n/a, write `n/a — <one-line reason>` so the downstream `task` skill knows you considered it.

```markdown
# [Feature name] — PRD

**Workflow stage:** prd (1/5) · next: `task`
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
- [Thing we could confuse with this feature but won't do now — feeds `task`'s exclusion rules]

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

Numbered, atomic, testable. Each one must be verifiable without ambiguity by `task`'s success criteria.

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

## 14. Hand-off to `task`

- **Likely task count:** [honest estimate, e.g. "3–5 tasks"]
- **Dependency order hint:** [generic layer order — shared types → data layer → server/API → workers/async → client/UI → tests → docs — adjusted to whatever this repo actually uses]
- **Known prior art in this repo:** [files/docs discovered in Step 1, with paths and line ranges from browzer]
- **Repo conventions to honor:** [one-line summary of invariants found in CLAUDE.md / similar; the `task` skill will expand on these]
```

## Constraints on what you write

- **Output language: English.** Render the PRD body, section headers, table contents, and citations in English regardless of the operator's input language. The conversational wrapper around the artifact (clarifying questions, hand-off line, status updates) follows the operator's language. This keeps downstream skill consumption unambiguous.
- No code, no schema, no folder layout. Those belong to `task` and `execute`.
- No "how to implement" guides. If you catch yourself writing a specific file path as a requirement (e.g. `src/foo/bar.ts`), stop — it belongs in the `task` output.
- No vague verbs. "Handle X" / "improve Y" / "work well" are rejected. Every requirement must have an observable signal.
- No invented stack facts. If you haven't seen a file, a command, or a convention in browzer results, don't claim it exists.
- Keep the PRD tight. One Mermaid diagram is plenty; three is noise.
- Repo-level invariants (security rules, layering, testing policy) are **givens** discovered from CLAUDE.md-style docs — list them in §9 only if the feature changes them; otherwise the `task` / `execute` skills will carry them forward automatically.

## Chain contract

The next skill in the workflow is `task`. After you emit the PRD, say one short line:

> **PRD ready.** Invoke `task` next to decompose this into ordered, mergeable engineering tasks.

If the user immediately says "go" / "do it" / "continue" / "break it down", the orchestrator (or you, if invoked directly) should call `Skill(skill: "task")` — the PRD stays in conversation context and becomes its input. No file handoff required.

## Invocation modes

- **Via the `browzer` agent:** the agent calls this skill at the `prd` phase and passes the user's raw request as context.
- **Standalone:** the user invokes this skill directly. Everything above still applies — you still run Step 1 so the PRD is grounded in this specific repo, not a generic template.

## Related skills

- `task` — next in the chain; decomposes this PRD into ordered task specs.
- `execute` — runs one of the resulting tasks end-to-end.
- `commit`, `sync` — close out the workflow once `execute` is green.
