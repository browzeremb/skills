---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics. Detects host capabilities (Docker, dev/start scripts, API + DB, frontend dev server, Playwright, browser MCPs, agent-browser), picks a mode (autonomous | autonomous-with-stack-boot | hybrid | manual), runs every verifiable check, and emits ACCEPTANCE.md with the verdict. Use before commit. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, smoke test the feature, is this feature ready, is the feature done, final verification, pre-commit acceptance, sign-off check, boot stack and verify."
argument-hint: "<featureId> [<mode>]"
---

You are the acceptance gate. Detect what this host can verify, let the
operator pick the mode (or accept the inferred default), then verify
every AC, NFR, and success metric from the PRD.

## Inputs

- `$ARGUMENTS` is `<featureId> [<mode>]` — mode is optional; when omitted, Phase 0 picks via AskUserQuestion or auto-resolves in non-interactive runs.
- This skill READS (closure relaxes here on purpose — feature-acceptance verifies the feature against its contract, which IS the PRD):
  - `docs/browzer/<feat>/staging/PRD.md` — frontmatter `acceptanceCriteria[]`, `nfrs[]`, `successMetrics[]`; body for verbatim AC text
  - `docs/browzer/<feat>/staging/CONFIG.md` — frontmatter `acceptanceMode` (suggested default)
  - `docs/browzer/<feat>/staging/TASK_*.completed.md` — verify all tasks succeeded
  - `docs/browzer/<feat>/staging/CODE_REVIEW.md` — read severity counts for veto computation
  - `docs/browzer/<feat>/staging/RECEIVING_CODE_REVIEW.md` — read `techDebtBreakdown`
  - `docs/browzer/<feat>/staging/TESTS.md` — read kill rate / coverage gaps
  - `docs/browzer/<feat>/staging/DOC_PATCHES.md` — verify when render-class ACs require docs

## Output contract

| Path | Role |
|---|---|
| `docs/browzer/<feat>/staging/ACCEPTANCE.md` | verdict + per-AC/NFR/metric details |
| `docs/browzer/<feat>/staging/RECEIPTS.md` (append) | `## feature-acceptance` section |

Frontmatter shape in `${CLAUDE_SKILL_DIR}/template.md`. Verdict computation
rules documented there.

## Preflight (halt conditions)

1. **PRD.md missing** → halt: "run `/generate-prd <feat>` first".
2. **prdSha drift** — `git hash-object docs/browzer/<feat>/staging/PRD.md` must match the `prdSha` in every consumed upstream artefact (CODE_REVIEW.md, RECEIVING_CODE_REVIEW.md, TESTS.md). Any mismatch HALTS with operator nudge naming the drifted phase(s).
3. **Failed tasks** — glob `docs/browzer/<feat>/staging/TASK_*.failed.md`. Any match HALTS with: "re-run /execute-task on listed failures".
4. **High-severity tech-debt without override** — if `RECEIVING_CODE_REVIEW.md.frontmatter.fixOutcomes[]` includes any `status: tech_debt` with `severity: high` AND no `.browzer/accepted-tech-debt.json` carries an override matching the findingId, HALT.

## Phase 0 — Capability probe + mode picker

Run the probe per `${CLAUDE_SKILL_DIR}/references/capability-probe.md`.
Build the `caps` map (docker, compose, package runner + scripts, backend
framework + run cmd + url, frontend framework + dev cmd + url, Playwright,
browser MCPs, agent-browser, curl, DBs, test runners). Compute verdict
`full | partial | none`.

Map each AC / NFR / metric to its verification surface (build, test,
http-probe, browser-probe, metric-query, manual-check) and mark
`runnable-here: true|false`.

Pick mode:

- If `$ARGUMENTS` carries `<mode>`, use it verbatim.
- Else read `CONFIG.md.frontmatter.acceptanceMode` for the suggested default.
- Else `AskUserQuestion` per the table in
  `${CLAUDE_SKILL_DIR}/references/capability-probe.md §Mode picker` (the
  legacy SKILL.md section is mirrored there post-refactor).
- Non-interactive fallback: `verdict=full + boot-capable` → `autonomous-with-stack-boot`; `verdict=full + not boot-capable` → `autonomous`; `verdict=partial` → `hybrid`; `verdict=none` → `manual`.

Record `mode` and a one-line `modeNote` in ACCEPTANCE.md frontmatter
(populated in Step 3 below).

### autonomous-with-stack-boot — Phase 0 boot procedure

When the resolved mode is `autonomous-with-stack-boot`, before any AC/NFR
verification: boot the stack via `docker compose up -d` or the host's
declared dev script. Readiness probe (max 120s, 5s interval). Tear down at
end-of-skill regardless of verdict. Full procedure in
`${CLAUDE_SKILL_DIR}/references/capability-probe.md §autonomous-with-stack-boot`.

## Phase 1 — Per-AC verification

For each AC in `PRD.md.frontmatter.acceptanceCriteria[]`:

1. Read the verbatim AC text from PRD.md body (the `acceptanceCriteria[]`
   frontmatter entry carries `id`, `description`; the body has the Given/When/Then).
2. Choose the verification method per
   `${CLAUDE_SKILL_DIR}/references/verification-methods.md`.
3. Execute (in autonomous mode) OR write the runbook line from
   `${CLAUDE_SKILL_DIR}/references/manual-instructions.md` (manual mode, or
   hybrid + not-runnable-here).
4. **Render-class AC binding rule**: if the AC's verbatim text matches
   `\b(render|display|visible|visibility|UI)\b` (case-insensitive), the
   verdict MUST NOT be `deferred-post-merge`. Use `deferred` +
   `operatorActionsRequested[]` entry with concrete browser steps when
   runtime verification is unavailable.
5. Record outcome in `perAcVerdict[]` with `acId`, `verdict`, `method`, `evidence`, `pinsTasks[]`, `pinsFindings[]` (when a fix resolved this AC).

## Phase 2 — Per-NFR verification

For each NFR:

1. Determine if the NFR target is **shell-runnable** per
   `${CLAUDE_SKILL_DIR}/references/verification-methods.md §shell-runnable detection`.
2. **Autonomous mode shell-gate (binding)**: when the resolved mode is `autonomous` or `autonomous-with-stack-boot` AND the target is shell-runnable, EXECUTE the command via Bash. Map exit code → verdict:
   - exit 0 → `pass`
   - non-zero (other than 127) → `fail`
   - exit 127 / `command not found` → `deferred` with operator action
   - tool/config missing → `deferred` with operator action
3. `partial` is FORBIDDEN in autonomous mode for shell-runnable targets. There is no third bucket.
4. Per-command timeout: 600s. Refused-verb list: `rm -rf`, `dd if=/`, `mkfs`, fork bomb, `sudo`, `chmod -R 000`, `git push --force`, `git reset --hard origin/`, `kubectl delete`, `terraform destroy` — refused commands record `fail` without executing.
5. Record in `nfrVerdict[]` with `nfrId`, `target`, `runnable`, `verdict`, `evidence`.

## Phase 3 — Per-metric verification

For each entry in `PRD.md.frontmatter.successMetrics[]`:

1. Query the source (Langfuse, Grafana, Postgres, etc.) when available.
2. When live evidence is unavailable, do NOT auto-flip to `pass` — record `deferred` with `operatorActionsRequested[]` per `${CLAUDE_SKILL_DIR}/references/live-verify.md §Phase 2.5.1`.
3. Record in `metricBaseline[]` with `metricId`, `target`, `observed`, `delta`, `verdict`.

## Phase 4 — Verdict aggregation

Apply the verdict table in `template.md`:

- Any AC `fail` → `rejected`
- Any NFR `fail` (autonomous, shell-runnable) → `rejected`
- `techDebtBreakdown` includes high-severity without override → `rejected`
- Any unresolved `operatorActionsRequested[].kind == blocks-commit` → `rejected`
- Any unresolved `manual-verification` or `deferred-pre-commit` → `partial`
- Otherwise (all pass or only `deferred-post-merge`) → `accepted`

Write `ACCEPTANCE.md` atomically with frontmatter + body. The body's
`### AC verdicts` section follows the regex contract documented in
`template.md`.

## Phase 5 — Stack teardown (autonomous-with-stack-boot only)

If Phase 0 booted services, tear them down regardless of verdict.
Choose ONE of:

```bash
docker compose down
```

OR (when a dev/start script was used instead of docker compose):

```bash
kill "$BOOT_PID"
```

Emit one log line confirming teardown.

## Phase 6 — Receipts ledger

```bash
node "${CLAUDE_SKILL_DIR}/scripts/append-receipts.mjs" "$ARGUMENTS"
```

## Done when

- `ACCEPTANCE.md` exists with frontmatter (`mode`, `verdict`, summary, perAcVerdict[], nfrVerdict[], metricBaseline[], techDebtMirror, operatorActionsRequested[]) and a body matching `template.md`.
- `prdSha` in ACCEPTANCE.md equals `git hash-object docs/browzer/<feat>/staging/PRD.md` at write time.
- No render-class AC carries `deferred-post-merge` (the binding rule).
- Every shell-runnable NFR in autonomous mode was executed (no silent `partial`).
- Stack was torn down when booted.
- `RECEIPTS.md` has exactly one `## feature-acceptance` section.
- Return line: `feature-acceptance: mode=<mode>; verdict=<accepted|rejected|partial>; deferred=<N>`.

## References

- `${CLAUDE_SKILL_DIR}/references/capability-probe.md` — probe commands, mode picker, autonomous-with-stack-boot procedure
- `${CLAUDE_SKILL_DIR}/references/verification-methods.md` — per-AC verification surface mapping; shell-runnable detection
- `${CLAUDE_SKILL_DIR}/references/manual-instructions.md` — runbook templates per surface
- `${CLAUDE_SKILL_DIR}/references/live-verify.md` — Phase 1.5 live-verify probe + Phase 2.6 anti-soft-override
- `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` — universal preamble
- `${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md` — RECEIPTS.md contract
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — folder map; PRD.md / CODE_REVIEW.md / RECEIVING_CODE_REVIEW.md / TESTS.md inputs
