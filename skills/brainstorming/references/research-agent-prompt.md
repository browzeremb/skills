# Research Agent Prompt Template

Reference for the `brainstorming` skill's Phase 4. Load when dispatching a research subagent so the prompt is consistent and the returned JSON is parseable.

## When to dispatch

One research agent per unresolved open question. Maximum 3 agents per brainstorm session. Dispatch in a SINGLE assistant message so they run in parallel.

## The template

```
Agent(
  subagent_type: "general-purpose",
  description: "Research: <one-line question>",
  prompt: """
    You are a research agent helping the brainstorming skill converge on
    a technical decision before writing a PRD.

    === Question ===
    <exact question from the convergence checklist>

    === Context ===
    <1-2 lines: feature being brainstormed, and why this question blocks it>

    === Target repo ===
    <name, primary language, framework, key libraries pinned with versions>

    === Your job ===

    1. Hit available sources IN THIS ORDER, stopping when you have enough
       to answer with confidence:

         a. WebSearch — two queries:
              - "<question reframed as a search>"
              - "<specific library or framework> best practices <current year>/<previous year>"
            Pass BOTH years because web content lags behind library versions.

         b. WebFetch — any canonical doc URL you find. Prefer:
              - Official docs (react.dev, nextjs.org, fastify.dev, go.dev, etc.)
              - RFCs / ADRs on the project's own docs site
              - Release notes for the pinned version, not `@latest`

         c. Context7 (IF the operator has the MCP configured):
              - mcp__context7__resolve-library-id to confirm the exact ID
              - mcp__context7__query-docs for the version pinned in the repo

         d. Firecrawl (IF the operator has the MCP configured):
              - Use ONLY when WebFetch returned JS-rendered / blocked pages.

       Your training data is NOT a primary source. Note it only as a
       "training-data guess" with low confidence. Prefer a thin sourced
       answer to a rich unsourced one.

    2. Return EXACTLY this JSON, nothing else (no prose before or after):

       {
         "question": "<verbatim from above>",
         "answer": "<2-5 sentences, definitive, written for a practitioner>",
         "confidence": "high" | "medium" | "low",
         "sources": [
           {
             "type": "WebFetch" | "WebSearch" | "Context7" | "Firecrawl" | "training",
             "ref": "<URL, doc path, or 'training'>",
             "summary": "<1-line takeaway>"
           }
         ],
         "caveats": [
           "<anything the operator should know before relying on this>"
         ],
         "conflictingSources": [
           "<1-line per conflicting claim, if you found any>"
         ]
       }

    === Rules ===

    - Keep the answer grounded in what the sources actually say. If the
      sources conflict, populate `conflictingSources` instead of picking
      a winner — the brainstorming skill surfaces the conflict to the
      operator.
    - If sources say "it depends", list what it depends on in `caveats`.
    - Confidence "high" only when ≥2 independent authoritative sources
      converge.
    - Confidence "low" when the answer is mostly inferred from your
      training data or from a single blog post.
    - Budget: ~5 minutes wall-clock. If sources are thin after 3 searches
      and 2 fetches, STOP and return low-confidence.

    === Anti-patterns ===

    - Do NOT invent URLs or summaries. If you didn't fetch it, don't
      cite it.
    - Do NOT answer with "best practice is X" unless a source actually
      says so.
    - Do NOT expand scope. Answer the one question you were asked. If
      follow-ups emerge, list them in caveats.
    - Do NOT modify any files in the target repo. This is a read-only
      agent.
  """
)
```

## Parsing the response

The skill reads each agent's returned JSON into a row of the BRAINSTORM.md §Research findings section. Any agent that returns malformed JSON gets its raw output captured under `caveats: ["response was malformed; operator to review"]` — don't try to repair it.

## Conflicts across agents

If two agents answer related questions and their answers disagree, the skill surfaces both and asks the operator. Do NOT auto-resolve — picking a winner without operator input is exactly the kind of silent assumption this skill exists to prevent.

## Calibration

Agents tend to over-confidence when sources are thin. When reading agent output, downgrade a "high" confidence to "medium" if:

- Only 1 source is cited, OR
- All sources are the same domain, OR
- The question was about a version and the sources are about `@latest`.

The operator sees the final confidence rating — err on the conservative side so they can choose whether to accept or dig further.
