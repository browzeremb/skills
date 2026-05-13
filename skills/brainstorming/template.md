# Brainstorming template

Single artefact: `docs/browzer/<feat>/staging/BRIEF.md`. LLM-authored brief that
feeds `generate-prd` as its `$contextInput`.

---

## Frontmatter (REQUIRED)

```yaml
---
featureId: feat-YYYYMMDD-<slug>
generatedAt: <RFC3339>
operatorRequest: |
  <verbatim verbatim of the operator's original ask — same text that will land in PRD.md.frontmatter.originalRequest>
researchTools:
  - tool: WebSearch | Firecrawl | Context7 | browzer-search | browzer-explore
    query: "<query string>"
    summary: "<one-line takeaway>"
searchTriggerProposals:                 # candidate terms to add to .browzer/search-triggers.json
  - term: <kebab-case-term>
    rationale: "<why this term should trigger search>"
gaps:                                    # dimensions surfaced during interview
  - dimension: persona | success-signal | in-scope | out-of-scope
    resolved: true | false
    resolution: "<one-line summary when resolved>"
---
```

---

## Body (REQUIRED)

```markdown
# Brainstorm summary — <feature label>

## Persona

<who benefits, in what context>

## Success signal

<observable outcome that proves it works — measurable when possible>

## In scope

- <item>
- <item>

## Out of scope

- <item>
- <item>

## Open decisions

- <decision>: <chosen option> — <rationale>

## Research findings (optional)

<sub-section ONLY when external research was conducted:
one bullet per source with takeaway>

## Search-trigger proposals (optional)

<sub-section ONLY when new triggers were proposed:
one bullet per term with rationale; operator approves out-of-band>
```

---

## Hard gate — operator approval

The brainstorming skill MUST NOT write BRIEF.md until the operator
approves the rendered summary. Approval requires:

1. An explicit affirmative token in the operator's response (`approved`, `I approve`, `yes ship it`, `go ahead`)
2. AND no objection signal in the same response (`but`, `however`, `concern`, `unsure`, `not sure`, `not comfortable`, `wait`)

A response containing both is treated as NOT approved — re-prompt until
the response is unambiguous. Track this in the interview loop; do NOT
write BRIEF.md prematurely.

---

## Cross-reference invariants

1. `operatorRequest` MUST be the verbatim text the operator typed (no paraphrasing, no completions). It becomes `PRD.md.frontmatter.originalRequest` downstream.
2. Every `gaps[]` entry MUST have `resolved == true` at write time. Unresolved gaps mean the brainstorm is not done.
3. `body.Persona / Success signal / In scope / Out of scope` MUST all be present (the four core dimensions of a useful PRD seed).
4. `searchTriggerProposals[]` is non-binding — the skill PROPOSES; the operator (out-of-band) accepts/rejects. Do NOT auto-edit `.browzer/search-triggers.json`.
