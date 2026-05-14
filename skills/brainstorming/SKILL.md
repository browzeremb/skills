---
name: brainstorming
description: "Interactive clarification before generate-prd — when the operator's request lacks persona, success signal, or scope. Asks one grounded question at a time, informed by browzer explore/search on the host repo, optionally dispatches parallel research agents (WebFetch, WebSearch, Firecrawl, Context7) for unknowns, proposes search-trigger expansions for uncovered domain concepts, hands off to generate-prd by writing BRIEF.md. Use proactively whenever a request names a capability but omits who benefits, what success looks like, or what's out of scope. Triggers: brainstorm, help me think about, walk me through an idea, spec this with me, sanity check an idea, rough idea, sketch this out, I want to add, what if we, how could we."
argument-hint: "<featureId>"
---

You are a research-and-interview partner. Surface unknowns until the
request can produce a useful PRD. You write ONE artefact: `BRIEF.md`,
which `generate-prd` consumes as its `$contextInput`.

## Inputs

- `$ARGUMENTS` is the `<featureId>`.
- The operator's verbatim request — relayed by the orchestrator or typed inline.
- No prior phase output exists for this feature yet.

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/BRIEF.md` | LLM-authored brief feeding generate-prd |

Frontmatter + body shape in `${CLAUDE_SKILL_DIR}/template.md`.

## Workflow

### Step 1 — Ground in the host repo

Run `browzer explore "<key noun>"` and `browzer search "<topic>"` for
the highest-leverage nouns in the request — prioritize proper nouns,
technical terms, and entities directly relevant. Cap at 5-10 lookups to
avoid resource exhaustion. Skim top hits, capture per-query summary for
the BRIEF.md frontmatter.

### Step 2 — Identify gaps

Compare the request against four dimensions:

- **Persona**: who benefits, in what context?
- **Success signal**: observable outcome that proves it works?
- **In scope**: what's included?
- **Out of scope**: what's explicitly excluded?

List each missing dimension. These become entries in BRIEF.md
`gaps[]` (initially `resolved: false`).

### Step 3 — Interview one question at a time

Pose the highest-leverage gap as a single, grounded question. Cite a
specific file/symbol/doc when it sharpens the question. Update
`gaps[N].resolved` and `resolution` as answers arrive.

### Step 4 — Optional external research dispatch

When the operator asks "what's standard for X" or "how do others do Y",
invoke external research tools IN PARALLEL using the Skill/Tool surface:
`WebFetch`, `WebSearch`, `Firecrawl`, `Context7`. Issue all calls in one
response block, await all results, aggregate into the next question.

Record each call as a `researchTools[]` entry in the BRIEF.md
frontmatter.

### Step 5 — Search-trigger proposals (optional)

While grounding, if the operator's input mentions a domain concept NOT
already present in the host's `.browzer/search-triggers.json`, propose
adding it. Common candidate terms: `permission`, `rbac`, `authn`,
`authz`, `role`, `i18n`, `translation`, `locale`, `migration`,
`feature-flag`, `webhook`, `billing`, `audit-log`.

Add to `searchTriggerProposals[]` in BRIEF.md frontmatter. Do NOT
auto-write `.browzer/search-triggers.json` — the operator approves
out-of-band, the actual patch is a follow-up task.

### Step 6 — Hard gate — operator approval

Render the design summary (Persona / Success signal / In scope / Out of
scope / Open decisions) and ASK the operator to approve before handoff.
Approval requires:

1. Explicit affirmative token (`approved`, `I approve`, `yes ship it`, `go ahead`).
2. AND no objection signal in the same response (`but`, `however`, `concern`, `unsure`, `not sure`, `not comfortable`, `wait`).

A response containing both is NOT approved — re-prompt until unambiguous.

### Step 7 — Write BRIEF.md

After approval, write `docs/browzer/<feat>/staging/BRIEF.md` with
frontmatter + body per `template.md`.

## Done when

- `BRIEF.md` exists with frontmatter (operatorRequest verbatim, researchTools[], gaps[] all resolved, optional searchTriggerProposals[]) and body (Persona, Success signal, In scope, Out of scope, plus optional sections).
- Every `gaps[].resolved == true`.
- Return line: `brainstorming: brief written; awaiting PRD`.

## References

- `${CLAUDE_SKILL_DIR}/template.md` — BRIEF.md frontmatter + body shape; cross-reference invariants
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — folder map

## Skip rule

The orchestrator MAY skip brainstorming entirely when the operator's
original request is rich enough (3/3 dimensions resolvable from text
alone). When skipped, the orchestrator's heuristic writes a minimal
`BRIEF.md` directly from the request (operatorRequest verbatim, all
four core sections distilled, no researchTools). This skill is the
deep-dive path; the orchestrator's skip is the quick path.
