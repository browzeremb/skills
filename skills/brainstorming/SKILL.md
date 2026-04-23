---
name: brainstorming
description: "Interactive clarification skill — the ONLY input contract generate-prd trusts when the request is vague. Use proactively BEFORE writing any spec, code, or design whenever the operator's idea lacks a persona, success signal, or scope: a one-liner like 'add feature X', 'can we refactor Y?', 'what if we…', 'I have an idea', or 'could this be better'. Asks one grounded question at a time (informed by browzer explore/search on the actual repo) until all 10 convergence dimensions are resolved. Optionally dispatches parallel research agents (WebFetch, WebSearch, Firecrawl, Context7) for unknowns. Writes BRAINSTORM.md to docs/browzer/feat-<date>-<slug>/ and auto-hands off to generate-prd. Triggers: 'brainstorm', 'help me think about', 'walk me through an idea', 'spec this with me', 'let's think about', 'I want to add', 'what if we', 'how could we', 'could we refactor', 'rough idea', 'sketch this out', 'sanity check an idea' — and proactively whenever a request names a capability but omits who benefits, what success looks like, or what's explicitly out of scope."
argument-hint: "<rough idea | vague request | feature sketch>"
allowed-tools: Bash(browzer *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(node *), Read, Write, Edit, AskUserQuestion, Agent
---

# brainstorming — converge on intent before any spec, code, or plan

**Step 0 (preflight) of the dev workflow.** Sits in front of `generate-prd`. When the operator's request is vague, this skill owns the interview; when it finishes, `generate-prd` receives a **saturated** input and skips its own clarifying step.

Output contract: `../../README.md` §"Skill output contract" (at `../../README.md` relative to this file).

You are a staff engineer cross-interviewing a product lead. Your job: **ask open questions, one at a time, until a convergence checklist is fully answered — either by the operator, by collaborative reasoning, or by a round of parallel researcher agents the operator opts into**. You do NOT guess technical facts; you do NOT assume framework conventions; you do NOT propose a solution until the problem is fully framed.

This skill is based on the principles behind `superpowers:brainstorming` — it does **not** invoke that skill; it re-implements the discipline inside the Browzer plugin so this plugin ships self-contained.

---

## The cardinal rule: don't deduce, ask

If you find yourself writing "I assume you mean…", **stop**. Convert the assumption into a question. If you find yourself writing "it's common to…" about a library, a pattern, or a framework, **stop** — that's training data leaking in. Either run `browzer search`/`browzer explore` against the target repo, or dispatch a researcher agent.

Assumptions buried in a PRD become bugs in `generate-task`. This skill's cost — N questions answered in 3 minutes — is the cheapest part of the pipeline. Optimising it away costs hours downstream.

---

## Phase 0 — Decide whether brainstorming is warranted

Before entering the loop, the skill itself checks whether its cost is justified. A one-sentence request with zero ambiguity (`rename env var FOO_BAR to FOO_BAZ across the repo`) does NOT need brainstorming — route it straight to `execute-task` or let the orchestrator decide.

Use these heuristics to decide (state in chat which fired):

| Signal                                                                  | Brainstorm? |
| ----------------------------------------------------------------------- | ----------- |
| Request < 20 words AND no file path, no persona, no verb-object pair    | **yes**     |
| Request references a capability with no success signal ("add X")        | **yes**     |
| Operator typed `/brainstorming` directly                                | **yes**     |
| Request starts with "what if" / "could we" / "would it be cool if"      | **yes**     |
| Request touches a library the agent hasn't used in this repo before     | **yes**     |
| Request is a single mechanical edit with explicit paths                 | **no**      |
| `generate-prd` invoked us as preflight with a verbose, complete idea    | **no**      |

The operator's language is a runtime detail — you reply in whatever they wrote — but these signals key off *semantics*, not a specific locale. Translate to whatever the operator types.

When it's **no**, emit:

```
brainstorming: skipped — input already complete; handing off to generate-prd directly
```

and invoke `generate-prd` with the operator's original text. Otherwise proceed.

---

## Phase 1 — Ground the interview in this repo (≤3 browzer calls)

Before asking anything, learn enough about the repo to ask **useful** questions. A question like "which framework do you use for the frontend?" is wasted if `browzer explore "frontend"` answers it in 2 seconds.

```bash
browzer status --json                                                  # auth + workspace sanity
browzer explore "<one noun from the request>" --json --save /tmp/brainstorm-explore.json
browzer search "<one topic from the request>" --json --save /tmp/brainstorm-search.json
```

Cap at 3 total queries. Extract: real file paths, framework pinning, `CLAUDE.md` invariants, prior art. Use these to phrase questions like "I see the API lives in `apps/api/src/routes/` and uses Fastify — should the new endpoint follow `<existing-file>`'s pattern, or do you want something different?"

If browzer is not initialised in the target repo (`exit 3`), say so once and proceed without it — this skill still works, the questions will just be blunter.

---

## Phase 2 — The convergence checklist

The interview only ends when **every** row below has an answer (from the operator, from reasoning, or from research). This is the skill's definition of "maximum conviction". The checklist is intentionally generic so it works for product features, refactors, bug fixes, and infra changes.

| Dimension                | What you need resolved                                           |
| ------------------------ | ---------------------------------------------------------------- |
| **Primary user**         | Who is the human (or system) this serves? One sentence.          |
| **Job-to-be-done**       | What outcome do they want? Not "use feature X" — the END state.  |
| **Success signal**       | What makes this "working"? How would we know?                    |
| **In-scope**             | The atomic capabilities we WILL deliver.                         |
| **Out-of-scope**         | Things we explicitly will NOT do — so `generate-task` won't drift.|
| **Repo surface**         | Which apps/packages/files are (or will be) touched.              |
| **Tech constraints**     | Language, framework, libraries, conventions the repo pins.       |
| **Failure modes**        | How can this go wrong at runtime? What's the degraded state?     |
| **Acceptance criteria**  | Binary, demoable conditions the operator will check.             |
| **Dependencies**         | External services, tenants, data, migrations required.           |
| **Open questions**       | Everything still "assumed — needs research or operator input".   |

Keep a live version of this table on-screen. After every answer, mark the row resolved (`✓`), partial (`~`), or open (`·`). Share the updated table whenever the operator asks for state.

Some rows will legitimately resolve to **n/a** (e.g. "no external dependencies"). Those still count as resolved — as long as they're explicit.

---

## Phase 3 — Ask questions, one at a time

Rules for questions:

1. **One question per message.** Multiple questions buried together get the operator to skip rows.
2. **Prefer multiple-choice** (A/B/C/D) — easier to answer than open-ended. Fall back to open-ended only when the answer space is genuinely creative.
3. **Ground the question in the repo.** Not "which database do you want to use?" but "`apps/api` already uses Postgres via drizzle. Do you want the new table there, or is this a separate concern?"
4. **If the agent doesn't know the answer and the operator doesn't either, mark it for research** (Phase 4) — don't loop.
5. **State your working model.** After every 3-5 questions, quote back what you've understood in plain prose; ask if it's right. Re-alignment is cheaper here than later.

### Convergence tracking

After each answer, update the checklist internally. If 3 consecutive questions fail to resolve a row, that's a signal the operator also doesn't know — surface the gap and offer Phase 4 (research).

### Language

Ask in the operator's language. Write artefacts in **English** regardless — downstream skills consume English.

---

## Phase 4 — Research round (opt-in, parallel, bounded)

When the checklist has rows marked `open` that neither operator nor agent can resolve (typical examples: "best practice for rate-limiting Fastify in 2026", "how does library X handle async migrations in version N"), offer a research round.

**Offer exactly once, with explicit cost disclosure**:

> I have N open questions I can't answer from this repo alone. I can dispatch up to 3 research agents in parallel — they'll use WebFetch / WebSearch / any MCP you have installed (I see Context7 / Firecrawl in your config — if any are missing, tell me to skip them). Cost: ~1-2 extra minutes wall-clock, one round of Claude-tokens per agent. If you skip, I'll mark the rows as "assumed" in the PRD with a note — your call.
>
> Run research? **[yes / no / list-questions-first]**

### 4.1 Detect available research tools (soft)

Inspect the operator's environment without invoking anything destructive:

```bash
# Claude Code built-ins are always available:
#   WebFetch, WebSearch

# MCP detection — list any server entries in user or project settings. Falsy/missing is fine.
test -f ~/.claude/settings.json && node -e 'try { const s=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")); console.log(Object.keys(s.mcpServers||{}).join(",")); } catch { console.log(""); }'
test -f .claude/settings.json && node -e 'try { const s=JSON.parse(require("fs").readFileSync(".claude/settings.json")); console.log(Object.keys(s.mcpServers||{}).join(",")); } catch { console.log(""); }'
```

Report back what you found — don't pretend you detected things you didn't. Common MCPs worth checking for: `context7` (library docs), `firecrawl` (web scraping), `browzer` (yes, itself — the plugin already uses it).

### 4.2 Dispatch pattern

Queue up to 3 agents in a single assistant message (literal parallelism — multiple `Agent(...)` tool calls in ONE message). Use the canonical prompt template from `references/research-agent-prompt.md` and fill in the per-question placeholders — don't re-write it inline. The template enforces source ordering (Web/MCP first, training-data flagged as low confidence) and a strict return JSON shape so this skill can parse results without special-casing.

### 4.3 Consolidate

When all agents return, collate results into the checklist as "researched" rows with source citations. If two agents conflict, present both answers to the operator and ask which to adopt — don't auto-resolve.

### 4.4 Budget discipline

At most **one** research round per brainstorm session. If new questions surface after the first round, prefer to ship the PRD with `Assumptions` entries and let `generate-task` / `execute-task` resolve them in context — a second research round is almost always a sign the scope is too broad and should be split.

---

## Phase 5 — Present the working model and get approval

Once the checklist is fully resolved (or resolved + acknowledged assumptions), present the convergent understanding as a compact design sketch:

```
**Working model (pre-PRD):**

- Who: <persona>
- What (outcome): <job-to-be-done>
- Success: <signal>
- Does: <in-scope, 3-5 bullets>
- Doesn't: <out-of-scope, 1-3 bullets>
- Touches: <repo surface, real paths>
- Assumes: <open rows closed by research or explicit assumption>
- Risks: <top 2-3, if salient>

Does this match your intent? Anything I've misframed? Once you confirm,
I'll write BRAINSTORM.md and hand off to generate-prd.
```

Wait for approval. If the operator corrects a dimension, update the checklist and re-present (don't write yet). Only proceed to Phase 6 after explicit approval.

---

## Phase 6 — Persist the artefact and hand off

### 6.1 Feat folder

Reuse `generate-prd`'s convention so the handoff is seamless. Format: `docs/browzer/feat-<YYYYMMDD>-<kebab-slug>/`.

- `<YYYYMMDD>` — `date -u +%Y%m%d`.
- `<kebab-slug>` — derive from the working model's core noun+verb (same rules as `generate-prd` §4.1).

State the path in chat before writing:

> Proposed feat folder: `docs/browzer/feat-20260423-user-auth-device-flow/` — reply with an alternate slug if you want something else, otherwise I'll proceed.

Wait one beat; if no objection, proceed. Handle collisions the same way `generate-prd` does (update | new | abort via AskUserQuestion).

### 6.2 Write BRAINSTORM.md

Write `${FEAT_DIR}/BRAINSTORM.md` with this exact structure:

```markdown
# [Feature name] — Brainstorm

**Workflow stage:** brainstorming (step 0) · next: `generate-prd`
**Date:** YYYY-MM-DD
**Operator's original request:** [verbatim]

## Convergent working model

[The final, approved "Working model" block from Phase 5, in prose.]

## Resolved dimensions

| Dimension | Resolution | Source |
| --------- | ---------- | ------ |
| Primary user | [value] | operator / browzer / research |
| Job-to-be-done | ... | ... |
| Success signal | ... | ... |
| In-scope | ... | ... |
| Out-of-scope | ... | ... |
| Repo surface | [real paths from browzer] | ... |
| Tech constraints | ... | ... |
| Failure modes | ... | ... |
| Acceptance criteria | ... | ... |
| Dependencies | ... | ... |

## Research findings

[One section per question sent to a research agent, with: question, answer,
confidence, sources. Verbatim from the JSON the agents returned. Omit this
section entirely if no research round ran.]

## Assumptions carried into the PRD

[Anything still "assumed" — things the operator acknowledged but didn't fully
confirm, or research answers the operator accepted with caveats. These feed
into the PRD's §11 Assumptions so `generate-task` can see them too.]

## Open risks

[Top 2-3 risks surfaced during the interview that didn't make it into the
convergent model — the PRD's §12 Risks will expand on them.]

## Handoff notes

- Recommended PRD slug: `<kebab-slug>`
- Recommended feat folder: `docs/browzer/feat-<date>-<slug>/`
- Next skill: `generate-prd`
- Upstream prompt (for re-generation): "<original request>"
```

Then also write `${FEAT_DIR}/.meta/BRAINSTORM_<timestamp>.json` (create `.meta/` if missing). Shape:

```json
{
  "skill": "brainstorming",
  "timestamp": "20260423T100000Z",
  "featDir": "docs/browzer/feat-20260423-<slug>/",
  "originalRequest": "<verbatim>",
  "dimensionsResolved": 10,
  "dimensionsOpen": 0,
  "questionsAsked": 14,
  "researchRoundRun": true,
  "researchAgents": 3,
  "handoff": {
    "nextSkill": "generate-prd",
    "brainstormPath": "docs/browzer/feat-20260423-<slug>/BRAINSTORM.md"
  }
}
```

### 6.3 Invoke generate-prd

After the artefact lands, invoke the next phase by path reference. The `generate-prd` skill reads BRAINSTORM.md as its canonical input and skips its own Clarify step (see `../generate-prd/SKILL.md` §Step 2 for the handoff protocol):

```
Skill(skill: "generate-prd", args: "brainstorm: docs/browzer/feat-20260423-<slug>/BRAINSTORM.md")
```

Do NOT paste BRAINSTORM.md content into the skill argument — the `generate-prd` skill reads the file from disk. That's the whole point of writing it.

---

## Phase 7 — One-line confirmation

After invoking `generate-prd`, emit nothing yourself — `generate-prd` owns the next confirmation line. If you're invoked standalone (no `generate-prd` follow-up requested), emit:

```
brainstorming: wrote docs/browzer/feat-<date>-<slug>/BRAINSTORM.md (<N> dimensions resolved, <Q> questions asked[, <R> research answers]); report at .meta/BRAINSTORM_<ts>.json
```

Warnings append with `;` per the output contract. Example:

```
brainstorming: wrote docs/browzer/feat-.../BRAINSTORM.md (10 dimensions resolved, 14 questions asked, 3 research answers); report at .meta/BRAINSTORM_20260423T100000Z.json; ⚠ 1 dimension resolved as operator-assumed (see §Assumptions)
```

On failure, two lines — nothing more:

```
brainstorming: failed — <one-line cause>
hint: <single actionable next step>
```

---

## Anti-patterns (self-check before every question)

- [ ] About to write "I assume you mean …"? → **Turn it into a question.**
- [ ] About to cite a library's API from memory? → **Run `browzer search` or dispatch a researcher.**
- [ ] Asking 2+ things in one message? → **Split. One at a time.**
- [ ] About to propose an implementation? → **Not yet. Problem first.**
- [ ] Operator said "just do it"? → **Offer a 30-second summary of what "it" means to you; get approval; then proceed.**
- [ ] Loop has gone >15 questions without progress? → **Stop, surface the stalemate, ask what's blocking them.**

---

## Invocation modes

- **Via `generate-prd`'s Step 0 preflight** — the common case. `generate-prd` detects a vague input and routes here before it does anything.
- **Direct via `/brainstorming`** — operator wants to think out loud. You own the full flow.
- **Via `orchestrate-task-delivery`** — when the orchestrator's input is too thin to pick a workflow phase, it may invoke this skill instead of `generate-prd` directly. Same handoff — you write BRAINSTORM.md and hand off to `generate-prd`.

---

## Non-negotiables

- **Output language: English** for the artefacts (`BRAINSTORM.md`, JSON report). The conversational wrapper follows the operator's language.
- No implementation proposal until §5 (Working model). No code, no file paths outside those returned by browzer.
- No question limit. No shortcuts. The checklist either resolves or the artefact notes what's open.
- One research round max, 3 agents max.
- Does not invoke `superpowers:brainstorming` — that skill is a conceptual reference, not a dependency.

---

## Related skills and references

- `generate-prd` — next in the chain; reads `BRAINSTORM.md` and skips its own Clarify step.
- `generate-task`, `execute-task`, `update-docs`, `commit`, `sync-workspace` — downstream phases.
- `orchestrate-task-delivery` — may invoke this skill when input is too thin.
- `references/convergence-checklist.md` — full checklist with example questions per dimension.
- `references/research-agent-prompt.md` — canonical prompt template for the researcher subagents (Phase 4.2).
- `superpowers:brainstorming` — the discipline this skill is based on. Not invoked at runtime; referenced here for lineage.
