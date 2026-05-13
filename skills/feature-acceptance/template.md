# Feature-acceptance template

Single artefact: `docs/browzer/<feat>/staging/ACCEPTANCE.md`. LLM-authored verdict
+ per-AC / per-NFR / per-metric results.

---

## Frontmatter (REQUIRED)

```yaml
---
featureId: feat-YYYYMMDD-<slug>
prdSha: <SHA mirrored from PRD.md; mismatch HALTS>
generatedAt: <RFC3339>
mode: autonomous | autonomous-with-stack-boot | hybrid | manual
modeNote: "<one-line probe summary; stack boot status when applicable>"
verdict: accepted | rejected | partial
verdictReason: "<one-line summary citing the load-bearing veto when verdict != accepted>"
summary:
  acsTotal: <int>
  acsPassed: <int>
  acsFailed: <int>
  acsDeferred: <int>
  nfrsTotal: <int>
  nfrsPassed: <int>
  nfrsFailed: <int>
  nfrsDeferred: <int>
  metricsTotal: <int>
  metricsPassed: <int>
  metricsFailed: <int>
  metricsDeferred: <int>
perAcVerdict:
  - acId: AC-01
    verdict: pass | fail | deferred
    method: build | test | http-probe | browser-probe | playwright | metric-query | manual-check
    evidence: "<command output digest, screenshot path, etc.>"
    pinsTasks: [TASK_NN, ...]
    pinsFindings: [F-NNN, ...]            # OPTIONAL — when a fix resolved this AC
nfrVerdict:
  - nfrId: NFR-01
    target: "<shell command or narrative>"
    runnable: true | false
    verdict: pass | fail | deferred
    evidence: "<command exit + stderr digest, or manual confirmation>"
metricBaseline:
  - metricId: M-01
    target: "<numeric target or qualitative>"
    observed: "<measured value>"
    delta: "<observed - target, when numeric>"
    verdict: pass | fail | deferred
operatorActionsRequested:                # populated in hybrid + manual modes
  - id: OA-01
    kind: manual-verification | deferred-pre-commit | deferred-post-merge | blocks-commit
    description: "<what the operator must do>"
    rendered: "<full instruction block from references/manual-instructions.md>"
    pinsAcs: [AC-NN, ...]
techDebtMirror:                          # reflected from RECEIVING_CODE_REVIEW.md for verdict computation
  highCount: <int>
  mediumCount: <int>
  lowCount: <int>
---
```

---

## Body (REQUIRED)

```markdown
# Feature acceptance — <verdict>

## Summary

<one paragraph: mode used, totals, top-line verdict reason>

## Verdict per AC

### AC verdicts
- AC-01 <pass|fail|deferred> <evidence-path-or-(manual)>
- AC-02 <pass|fail|deferred> <evidence-path-or-(manual)>
- ...

## NFR verdicts

| NFR | Target | Runnable | Verdict | Evidence |
|---|---|---|---|---|
| NFR-01 | <target> | <bool> | <verdict> | <evidence> |

## Metric baselines

| Metric | Target | Observed | Delta | Verdict |
|---|---|---|---|---|
| M-01 | <target> | <observed> | <delta> | <verdict> |

## Operator actions requested

<sub-section when len > 0: list each operatorActionsRequested[] entry with
its full rendered instruction block>

## Veto rationale

<sub-section ONLY when verdict != accepted: explain which veto fired —
high-severity tech-debt without override, failed render-class AC, NFR shell
gate failure, etc.>

## Next phase

<one of:
  "Run /finalize-feature <featureId> to write the README and prepare for commit."
  "HALT — operator must address rejections before re-running /feature-acceptance.">
```

---

## Verdict computation

| Condition | Resulting verdict |
|---|---|
| Any AC `fail` AND no override | `rejected` |
| Any NFR `fail` (autonomous mode, shell-runnable) | `rejected` |
| `techDebtMirror.highCount > 0` AND no `.browzer/accepted-tech-debt.json` override | `rejected` |
| Any operatorActionsRequested[].kind == `blocks-commit` unresolved | `rejected` |
| Any operatorActionsRequested[].kind == `manual-verification` or `deferred-pre-commit` unresolved | `partial` (commit must wait) |
| All `deferred-post-merge` entries are non-fatal — commit proceeds | counted as `accepted` |
| Otherwise (all pass or pass+deferred-post-merge only) | `accepted` |

---

## AC verdict regex contract

Body section `### AC verdicts` follows:

```
^- (AC-\d+) (pass|fail|deferred) (\S+|\(manual\))$
```

- Capture groups: `acId` · `verdict` · `evidence-path-or-(manual)`
- `evidence-path` is repo-relative when the artifact was generated (test report, screenshot)
- `(manual)` literal indicates operator-verified, evidence in body prose

---

## Render-class AC binding rule

Any AC whose verbatimText matches `\b(render|display|visible|visibility|UI)\b`
(case-insensitive) is **render-class**. Render-class ACs:

- MUST NOT carry `verdict: deferred` with `kind: deferred-post-merge` operator action
- MAY carry `verdict: deferred` with `kind: manual-verification` (e.g. no Playwright/MCP available)
- MUST emit an `operatorActionsRequested[]` entry with concrete browser/Playwright steps when `verdict: deferred`

---

## Cross-reference invariants

1. `prdSha` MUST equal `git hash-object docs/browzer/<feat>/staging/PRD.md`. Mismatch HALTS the phase.
2. Every `perAcVerdict[].acId` MUST match an AC ID in PRD.md (verified by the feature-acceptance phase reading PRD.md frontmatter `acceptanceCriteria[]`).
3. Every `perAcVerdict[].pinsTasks[]` entry MUST reference an existing `TASK_NN.completed.md`.
4. `summary.acsPassed + summary.acsFailed + summary.acsDeferred == summary.acsTotal`. Same for nfrs + metrics.
5. `techDebtMirror` MUST equal the breakdown in `RECEIVING_CODE_REVIEW.md.frontmatter.techDebtBreakdown` + severity-aware counts.
6. `verdict == rejected` ⇒ `verdictReason` is non-empty.
7. Render-class ACs (regex above) with `verdict: deferred` MUST have a corresponding `operatorActionsRequested[]` entry with `pinsAcs: [<that acId>]`.
