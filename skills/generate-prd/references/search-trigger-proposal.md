# Search-trigger proposal

The target repo's `.browzer/search-triggers.json` is an array of strings the Browzer search guard reacts to. When the operator's prompt mentions one of these terms, the guard nudges the agent toward `browzer explore` / `browzer search` instead of blind file reads.

Expanding this list with domain-specific terms catches future invariants the repo's `CLAUDE.md` may not document.

## When to propose

While grounding the PRD, if the operator's input mentions a domain concept that is **not already in** `.browzer/search-triggers.json`, append a proposal to the PRD's `assumptions[]` array:

> Propose adding `<term>` to `.browzer/search-triggers.json` — observed during exploration when `<concrete justification>`.

The proposal lives in `assumptions[]` because it is a side-channel signal for the operator, not a functional requirement of the feature itself.

## What the operator does with proposals

Skills propose; operators approve. The actual patch to `.browzer/search-triggers.json` lands later in the workflow as a separate operator-driven step — out of scope for `generate-prd`.

Downstream skills (`feature-acceptance`, `finalize-feature`) may surface the proposal in their final report so the operator does not lose track of the open decision.

## Candidate vocabulary

Terms worth proposing when encountered during grounding:

| Domain | Candidate terms |
| --- | --- |
| Identity / authz | `permission`, `rbac`, `authn`, `authz`, `role`, `session` |
| I18n | `i18n`, `translation`, `locale` |
| Data | `migration`, `mutation`, `query`, `prisma`, `drizzle`, `neo4j`, `redis` |
| Infra | `queue`, `worker`, `webhook`, `billing`, `audit-log`, `feature-flag` |
| Browzer-specific | `daemon`, `workflow`, `step`, `phase`, `dispatch`, `embed` |

Do **not** propose generic English nouns (`user`, `data`, `system`, `feature`). The list catches domain-specific terms that the search guard wouldn't otherwise know to react to.

## How to check before proposing

```bash
cat .browzer/search-triggers.json 2>/dev/null | grep -i "<term>"
```

If the grep returns nothing, the term is a candidate. If it returns a match, the trigger already exists — no proposal needed.

## Example proposal entry in `assumptions[]`

```yaml
assumptions:
  - |
    Propose adding `outbox` to `.browzer/search-triggers.json` — observed during
    exploration when grounding billing-reconciliation scope. Multiple files
    reference the outbox pattern but the trigger list does not include the term,
    so future agents may miss the convention.
```

The proposal is justified by an observable from this grounding session, not a generic suggestion.
