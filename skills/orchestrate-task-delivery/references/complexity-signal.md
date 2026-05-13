# COMPLEXITY signal — PM / PO model selection

Loaded only when the orchestrator is about to dispatch `generate-prd`
(PM) or `generate-task` (PO). Every other phase skips this doc.

## Tier table

| Signal          | PM (PRD)       | PO (tasks)     |
| --------------- | -------------- | -------------- |
| `simple`        | sonnet, medium | sonnet, medium |
| `standard`      | sonnet, high   | sonnet, high   |
| `complex`       | opus, xhigh    | opus, xhigh    |
| `architectural` | opus, max      | opus, max      |

## Heuristic

Count distinct domains touched (frontend / backend / infra / docs) and
distinct files mentioned in BRIEF.md (when present) or the verbatim
request.

| Inputs                                       | Signal          |
| -------------------------------------------- | --------------- |
| ≤2 domains AND ≤5 files                      | `standard`      |
| >3 domains                                   | `complex`       |
| cross-cutting refactor signals (renames, shared utilities, schema migration) | `architectural` |
| trivial single-file change                   | `simple`        |

## Intentional change — 2026-05-13

The PM tier for `complex` features was bumped from `sonnet, xhigh` to
`opus, xhigh` to align with the PO tier at the same complexity level.
Complex PRDs benefit from opus reasoning depth; this is a deliberate
cost trade-off, not a formatting accident.
