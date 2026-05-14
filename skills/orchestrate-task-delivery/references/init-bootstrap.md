# Init bootstrap — first-invocation feat folder setup

Loaded by the orchestrator only when `detect-phase.mjs` returns
`state: no-feat-folder, nextPhase: INIT`. All other iterations skip this
doc.

## 1. Validate / normalize `<featureId>`

- If matches `^feat-\d{8}-[a-z0-9-]+$`, use as-is.
- If just a slug, prepend `feat-$(date +%Y%m%d)-`.

## 2. Create the staging folder

```bash
mkdir -p docs/browzer/<featureId>/staging
```

## 3. Write `staging/.gitignore` (immutable)

```
*
!.gitignore
```

This excludes every workflow artefact from git while keeping the
`.gitignore` itself versioned so the discipline survives clones.

## 4. Write `staging/CONFIG.md`

```yaml
---
featureId: <featureId>
executionStrategy: <serial | parallel | parallel-worktrees | agent-teams>
acceptanceMode: hybrid
createdAt: <RFC3339>
---
```

`executionStrategy` defaults to `serial`. `acceptanceMode` defaults to
`hybrid`.

## 5. Legacy-layout migration (idempotent)

When initializing a feat folder whose prior incarnation pre-dates the
staging-folder discipline — any `PRD.md` / `TASK_*.md` at
`docs/browzer/<featureId>/` top level with no `staging/` subfolder —
move every file except `README.md` into the newly created `staging/`
subfolder before continuing. Re-running on an already-migrated folder is
a no-op.

## 6. Brainstorming gate

Apply the heuristic from
`${CLAUDE_SKILL_DIR}/references/intent-detection.md §brainstorming-gate`.
Record the decision via `append-trace.mjs`:

- `--operator-override` when the operator explicitly forced one path.
- `--from init-no-feat --to brainstorming|generate-prd` otherwise.

## 7. Resume the loop

Continue with a fresh `detect-phase` call. The state machine takes over
from filesystem state.
