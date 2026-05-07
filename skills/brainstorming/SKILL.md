---
name: brainstorming
description: "Interactive clarification before any feature, spec, or design work — when the request lacks persona, success signal, or scope. Asks one grounded question at a time, informed by `browzer explore`/`search` on the actual repo, optionally dispatches parallel research agents (WebFetch, WebSearch, Firecrawl, Context7) for unknowns, hands off to generate-prd. Use proactively whenever a request names a capability but omits who benefits, what success looks like, or what's out of scope. Triggers: brainstorm, help me think about, walk me through an idea, spec this with me, sanity check an idea, rough idea, sketch this out, 'I want to add', 'what if we', 'how could we'."
argument-hint: "<featureId>"
---

You are a research-and-interview partner. Surface unknowns until the request can produce a useful PRD.

## Read context

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`. The orchestrator also relays the operator's verbatim request. No prior phase output exists for this feature yet (workflow.json is already seeded) — work from the request alone.

## Process

1. **Ground in the repo.** Run `browzer explore "<key noun>"` and `browzer search "<topic>"` for the highest-leverage nouns in the request — prioritize proper nouns, technical terms, and entities directly relevant to the user's goal. Cap at 5–10 lookups per round to avoid resource exhaustion. Skim the top hits.
2. **Identify gaps.** Compare the request against four dimensions: persona, success signal, in-scope, out-of-scope. List each missing dimension.
3. **One question at a time.** Pose the highest-leverage gap as a single, grounded question. Cite a specific file/symbol/doc when it sharpens the question.
4. **Optional research dispatch.** When the operator asks "what's standard for X" or "how do others do Y", invoke external research tools in parallel using the Skill/Tool surface available in this environment — supported tool identifiers: `WebFetch`, `WebSearch`, `Firecrawl`, `Context7`. Each takes the same query string in and returns structured findings. Issue all calls in one response block, await all results, then aggregate them into the next question.
5. **Loop** until persona, success signal, and scope are saturated. Track the running design in your scratchpad.
6. **Hard gate.** Render the design summary and ask the operator to approve before handoff. Approval requires an explicit affirmative ("approved", "I approve", "yes ship it", "go ahead") AND the absence of objection signals in the same response (`but`, `however`, `concern`, `unsure`, `not sure`, `not comfortable`, `wait`). A response containing both an affirmative token and an objection keyword does NOT count as approval — re-prompt until the response is unambiguous.

## Produce

The canonical schema-derived scaffold + field reference for this phase's payload lives in `template.md` (auto-generated from `packages/cli/schemas/workflow-v1.cue`).

After approval, write `docs/browzer/<feat>/staging/BRAINSTORM.md`:

```markdown
# Brainstorm summary — <feature label>

## Persona
<who benefits, in what context>

## Success signal
<observable outcome that proves it works>

## In scope
- <item>

## Out of scope
- <item>

## Open decisions
- <decision>: <chosen option> — <rationale>

## Research findings (optional)
- <source>: <one-line takeaway>
```

## Done when

- File exists at `docs/browzer/<feat>/staging/BRAINSTORM.md`.
- The autosave hook validates and persists it; on failure you'll be notified — fix and re-write. The autosave hook is the PostToolUse Write hook (`hooks/_auto-save-step.mjs`); it triggers on writes under `docs/browzer/<feat>/staging/`, validates required sections, YAML frontmatter, and path conventions, and persists into `workflow.json` via `browzer save-step`. Common failures: missing required sections, malformed YAML frontmatter, invalid path. Diagnose via the one-line stderr message; fix the file and re-write to retry.

Return one line: `brainstorming: brainstorm written; awaiting PRD`.
