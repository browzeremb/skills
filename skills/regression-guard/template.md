---
featureId: <feat>
round: <N>
generatedAt: <RFC3339>
runner: <turbo | pnpm | npm | yarn | go | cargo | pytest | unknown>
gateResults:
  lint: <pass | fail | n/a>
  typecheck: <pass | fail | n/a>
  test: <pass | fail | n/a>
  build: <pass | fail | n/a>
correlatedFixes: [F-NNN, F-MMM]
---

# Regression guard — round <N>

## Summary

<one line — pass/fail counts + which fixers ran in this round>

## Lint

```
<gate output, last 200 lines>
```

## Typecheck

```
<gate output, last 200 lines>
```

## Test

```
<gate output, last 200 lines>
```

## Build

> Present only when `CONFIG.tier == full` AND the detector returned a
> non-empty build command tuple.

```
<gate output, last 200 lines>
```

## HALT (only when round = 3 AND any gate failed)

regression-guard: exceeded max rounds (3) — operator must inspect or
pass `--override-gate` to `/feature-acceptance` to accept the failing
gate and proceed. Override is recorded in
`acceptance/ACCEPTANCE.md.frontmatter.gateOverride: {reason, operator}`.

## Next phase

- Gate passed → `feature-acceptance`
- Gate failed AND round < 3 → write `staging/.regression-guard-rerun`,
  loop back to `receiving-code-review` for round <N+1>
- Gate failed AND round == 3 → HALT
