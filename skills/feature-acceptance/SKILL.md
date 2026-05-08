---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics. First detects what verification capabilities the host repo offers (Docker, dev/start scripts, API + DB, frontend dev server, Playwright, browser MCPs, agent-browser), then asks the operator to pick a mode — autonomous (all gates runnable here), hybrid (run what's possible, defer the rest with concrete how-to-verify steps), or manual (operator runs everything, skill emits the runbook). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, smoke test the feature, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check."
argument-hint: "<featureId>"
---

You are the acceptance gate. Detect what this repo can verify on its own, let the operator pick the mode, then verify every AC, NFR, and success metric from the PRD before commit.

## Read context

```
!`browzer get-step FEATURE_ACCEPTANCE --id $ARGUMENTS 2>/dev/null || echo "(no prior FEATURE_ACCEPTANCE step — first run)"`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob includes the PRD's acceptance criteria, NFRs, success metrics, and the list of completed TASK_NN execution receipts.

## Modes

| Mode | Behavior |
| ---- | -------- |
| `autonomous` | Skill runs every verifiable check itself (build, lint, test, http probe, metric query, browser/Playwright probe). Used when the capability probe returns `verdict=full`. |
| `hybrid` | Skill runs the items it can; emits a manual checklist for the residue with concrete how-to-verify steps. Default when the probe returns `verdict=partial`. |
| `manual` | Skill emits the full how-to-verify checklist; operator runs everything out-of-band and reports back. Always available regardless of probe verdict. |

The orchestrator's `CONFIG.mode` is the **default suggestion**; Phase 0 below confirms the final mode with the operator based on what the host repo actually supports. Live-verify procedures (dashboard / `/ask` / `/sync` probes) are in `references/live-verify.md`. Verification methods per AC type are in `references/verification-methods.md`. Stack-agnostic capability detection is in `references/capability-probe.md`. Manual-instruction templates per surface (backend / frontend / CLI / migration / worker / NFR) are in `references/manual-instructions.md`.

## Phase 0 — Capability probe + mode picker

This phase is **binding** for every invocation. Skipping it produces stale verdicts when the host repo cannot actually run what the PRD asks for.

1. **Probe.** Run the detection commands from `references/capability-probe.md`. Build the `caps` map (docker, compose, package runner + scripts, backend framework + run cmd + url, frontend framework + dev cmd + url, Playwright, browser MCPs, agent-browser, curl, DBs, test runners). Tolerate missing tools — never abort. Compute the verdict (`full | partial | none`).

2. **Map PRD requirements → capabilities.** For each AC / NFR / metric, decide which surface verifies it (backend HTTP, frontend UI, CLI, DB, worker, perf, security, a11y). Mark each item `runnable-here: true|false` based on `caps`.

3. **Pick the mode via `AskUserQuestion`.** The available options depend on the verdict:

   | Verdict | Options to expose | Recommendation |
   | --- | --- | --- |
   | `full` | `autonomous`, `hybrid`, `manual` | `autonomous` (Recommended) |
   | `partial` | `hybrid`, `manual` | `hybrid` (Recommended) |
   | `none` | `manual`, `hybrid` | `manual` (Recommended) — `hybrid` only useful if at least one shell-runnable NFR (lint/test) is callable |

   The question MUST surface, in one short paragraph, the probe summary (what was found / what was missing) so the operator picks an informed mode. Include the per-PRD-item runnable-here counts (e.g. "5 of 8 ACs are runnable here").

   Example question shape:

   > Probe: backend=fastify@8080 ✓, frontend=next@3001 ✓, Playwright ✗, browser MCP ✗, agent-browser ✓, postgres ✓. 5 of 8 ACs runnable here (3 require a browser surface).
   >
   > How should I run acceptance for `<featureId>`?
   > - **autonomous** — only available when verdict=full. Skip if exposed against your wishes.
   > - **hybrid (Recommended)** — I run the 5 runnable ACs + every shell-runnable NFR, then emit a checklist for the 3 UI ACs.
   > - **manual** — I emit the full runbook; you verify everything and reply.

4. **Persist the chosen mode** to `featureAcceptance.mode` (enum: `autonomous | hybrid | manual`). Stash the one-line probe summary in `featureAcceptance.modeNote` per `references/capability-probe.md §Persistence`.

5. **Edge case — non-interactive runs.** If the orchestrator marks the run as non-interactive (e.g. CI), skip `AskUserQuestion` and resolve the mode deterministically: `verdict=full → autonomous`, `verdict=partial → hybrid`, `verdict=none → manual`. Record `featureAcceptance.modeNote` with `auto-resolved (non-interactive)`.

## Process

After Phase 0:

1. For each AC: pick a verification method (build, test, http-probe, browser-probe, metric-query, manual-check) using the runnable-here mapping. Run it (autonomous, or hybrid+runnable-here) or write the runbook line from `references/manual-instructions.md` (manual, or hybrid+not-runnable-here).
2. For each NFR: same. See **Autonomous-mode shell-gate enforcement (FR-2)** below for the binding rule when `nfr.target` is a runnable shell command.
3. For each success metric: query the source (Langfuse, Grafana, Postgres, etc). For dashboard / `/ask` / `/sync` metrics that lack live evidence, do NOT auto-flip to `status: met` — record `status: unmet, resolved: false` and append an `operatorActionsRequested[]` entry per `references/live-verify.md §Phase 2.5.1`.
4. Aggregate the verdict.

In **hybrid** mode, the FR-2 shell-gate below still fires for every shell-runnable NFR. Items the agent cannot run (UI surfaces with no Playwright/MCP, missing infra, etc.) become `operatorActionsRequested[]` entries rendered through the templates in `references/manual-instructions.md`.

## Autonomous-mode shell-gate enforcement (FR-2)

This subsection is **binding** for every NFR whose `target` is a shell-runnable command when the resolved `featureAcceptance.mode == autonomous` (or when `mode == hybrid` AND the item is runnable-here).

### Mode resolution

Read the mode authoritatively in this order:

1. **Primary** — `featureAcceptance.mode` from the staged file (after Phase 0 wrote it).
2. **Fallback** — `CONFIG.mode` from `browzer get-step CONFIG --id <feat> --json` if Phase 0 did not run (e.g. mid-recovery).
3. **Last-resort default** — `autonomous` AND emit a single warning line (verbatim):

   ```
   [feature-acceptance] WARNING: featureAcceptance.mode not set; defaulting to autonomous. Operator: re-run the skill so Phase 0 records the resolved mode.
   ```

### Shell-runnable target detection

The **best-form contract** is explicit opt-in: PRD authors set `nfr.runnable: true` on every NFR object whose `target` is meant to execute as a shell command. Skills MUST honour the explicit field over any heuristic.

Resolution order:

1. **Explicit (preferred)** — if the NFR object carries `runnable: true`, treat the `target` as shell-runnable. If it carries `runnable: false`, treat it as narrative regardless of shape.
2. **Heuristic fallback (legacy NFRs that omit the field)** — treat `nfr.target` as shell-runnable when **ALL** of the following hold:
   - The string matches the tight regex (case-sensitive on the head, evaluated on the first 80 chars):

     ```
     ^[a-z][a-z0-9_-]*(\s--?[A-Za-z]|\s[\$\(<]|\s\|\||\s&&|\s\|\s|;).*
     ```

     i.e. the first token is a command-shaped identifier AND the remainder contains a flag (`-x`/`--xxx`), a shell metacharacter (`$`, `(`, `<`), or a chain/pipe/separator (`&&`, `||`, ` | `, `;`) within the first 80 characters.
   - The string MUST NOT contain any of these English connectors as separate words (case-insensitive): `the`, `is`, `should`, `must`, `verify`, `ensure`, `make sure`, `track`. A match here means the `target` is narrative prose that happens to start with a command-shaped word ("make sure latency drops", "go through the audit log", "git history is preserved", "node count stays under 50") — NOT runnable.

Anything else (free-prose criteria, dashboard probe descriptions, "operator visually confirms…") is NOT shell-runnable — fall back to the standard verification-methods playbook + the manual-instruction templates.

> Always prefer the explicit `runnable: true` contract for new PRDs. The heuristic exists only to keep legacy NFRs working; it is intentionally conservative and will reject ambiguous strings.

### Autonomous / hybrid-runnable contract (binding)

For every shell-runnable target, when the item is runnable-here under the resolved mode, the skill MUST:

1. Execute the target via the **Bash tool**. Do NOT mock, paraphrase, dry-run, or skip. Do NOT ask the operator to run it.
2. Capture exit code, stdout, and stderr. Truncate captured output to the first 4096 characters before recording.
3. Map the result to a status using exactly this table — no other outcomes are allowed:

   | Outcome | `status` | `evidence` |
   | --- | --- | --- |
   | Exit code `0` | `verified` | `"<command> → exit 0"` |
   | Exit code non-zero (other than 127) | `failed` (autonomous) / `partial` (hybrid, item still routed to the operator) | `"<command> → exit <code>; stderr: <truncated>"` |
   | Exit code `127` or stderr contains `command not found` | `partial` + add an `operatorActionsRequested[]` entry | `"<command> failed — binary not found"` |
   | Tool/config missing (e.g. config file absent, required env var unset, the command itself prints a "missing X" error before any real work) | `partial` + operator action | `"<command> failed — <missing tool/config detail>"` |

4. **`partial` is BANNED in autonomous mode for shell-runnable targets.** A non-zero or un-runnable result is `failed` (or routed to manual via the operator-action entry), never silently `partial`. A zero exit is `verified`, never `partial`. There is no third bucket. In **hybrid** mode `partial` is allowed ONLY when the un-runnable item is also recorded in `operatorActionsRequested[]` so the operator can finish it.
5. The `rationale` field on the NFR record MUST cite the exact command that ran AND the failure mode (or the success exit). Generic phrases like "tests passed" without the command are non-compliant.

### Manual-mode behavior

When `featureAcceptance.mode == manual`, the skill emits a per-item runbook block from `references/manual-instructions.md` for EVERY AC/NFR/metric. No Bash invocations. The operator replies with results, which are recorded into `acceptanceCriteria[]` / `nfrVerifications[]` / `successMetrics[]` via review-history exchange.

### Safety guardrails

Autonomous Bash execution is bounded by the following non-negotiable guardrails. They apply to every shell-runnable NFR target.

- **Per-command timeout: 600s (10 minutes).** If the command does not return within 600s, terminate it and record `status: failed` with `evidence: "<command> exceeded 600s timeout"`. Do not retry within the same run.
- **Sequential execution.** Run one shell-runnable NFR at a time by default. Operators MAY opt into parallel execution by setting `featureAcceptance.parallelism: <int>` in the PRD if the workflow schema admits the field; absent that, parallelism is `1`.
- **Refused-verb list.** Before executing, scan the resolved command string. If it contains ANY of the following patterns (substring match, case-sensitive unless noted), refuse it: `rm -rf`, `dd if=/`, `mkfs`, `:(){:|:&};:`, `sudo`, `chmod -R 000`, `git push --force`, `git reset --hard origin/`, `kubectl delete`, `terraform destroy`. Refused commands record `status: failed` with `evidence: "command refused for safety: <pattern>"` and a `rationale` naming the matched pattern. Do not prompt the operator to override.
- **Stack-up commands** (anything matching `/^(docker(-| )compose|<runner> (run )?(dev|dev:.*|start|up|infra:up))/`) run in the **background** via Bash `run_in_background: true` so they don't block the gate. Capture the PID, give the stack ≤30s to come up, then probe with curl/Playwright. Tear it down at end-of-skill (`docker compose down` or `kill <pid>`).
- **Working directory.** Execute commands from the repo root unless the NFR `target` itself uses `cd` explicitly to change directory. Never set CWD implicitly based on the NFR id or filename.

### Worked examples

Assume an NFR with `id: NFR-LINT` and `target: "<runner> --filter <package> lint"`. The detector classifies this as shell-runnable (verb + flag within 80 chars; no English connectors).

**Happy path (autonomous, exit 0):**

```jsonc
{
  "id": "NFR-LINT",
  "status": "verified",
  "evidence": "<runner> --filter <package> lint → exit 0",
  "rationale": "Executed lint via Bash; exit 0 confirms the lint NFR."
}
```

**Failure path (autonomous, exit ≠ 0):**

```jsonc
{
  "id": "NFR-LINT",
  "status": "failed",
  "evidence": "<runner> --filter <package> lint → exit 1; stderr: <first 4096 chars>",
  "rationale": "Executed lint via Bash; exit 1 with diagnostics — recorded as failed (autonomous-mode contract forbids `partial` for shell-runnable targets)."
}
```

**Hybrid + missing-binary path (routed to operator):**

```jsonc
{
  "id": "NFR-CARGO",
  "status": "partial",
  "evidence": "cargo test failed — binary not found",
  "rationale": "Executed `cargo test` via Bash; `command not found` (exit 127). In hybrid mode this is `partial` AND mirrored as an operatorActionsRequested[] entry with the `references/manual-instructions.md §CLI / script` template."
}
```

**Refused-verb path (autonomous, safety guardrail):**

Assume an NFR with `id: NFR-CLEAN` and `target: "rm -rf ./build && <runner> build"`. The string contains the refused pattern `rm -rf`, so the safety guardrail short-circuits before any Bash invocation:

```jsonc
{
  "id": "NFR-CLEAN",
  "status": "failed",
  "evidence": "command refused for safety: rm -rf",
  "rationale": "Target `rm -rf ./build && <runner> build` matched the refused-verb pattern `rm -rf`; not executed. Operator must rewrite the NFR to avoid destructive verbs (e.g. use the build tool's clean target)."
}
```

## Produce

Write `docs/browzer/<feat>/staging/FEATURE_ACCEPTANCE.json`.

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

`verdict` is one of `completed | paused-pending-operator | stopped`.

Verdict rules:

- Any `failed` AC/NFR → `stopped`.
- Any unresolved `operatorActionsRequested[]` of `kind: blocks-commit` → `stopped`.
- Any unresolved `operatorActionsRequested[]` of `kind: manual-verification | deferred-pre-commit` → `paused-pending-operator`. `commit` does not proceed until they resolve (deferred-post-merge entries are non-fatal — `commit` proceeds, the operator resolves them after merge).
- All `verified` / `met` (or deferred-post-merge only) → `completed`.

## Persistence

The autosave hook persists `staging/FEATURE_ACCEPTANCE.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — FEATURE_ACCEPTANCE is load-bearing: `commit` reads it back immediately after this phase completes.

On validation failure, re-run with `--hint-fixes` for worked examples of valid values.

## Done when

- File exists at `docs/browzer/<feat>/staging/FEATURE_ACCEPTANCE.json`.
- `featureAcceptance.mode` is set (Phase 0 ran).
- The autosave hook validates and persists.
- In `manual` / `hybrid` runs: every un-runnable item has an `operatorActionsRequested[]` entry with a fully-rendered instruction block from `references/manual-instructions.md` (no unresolved `<placeholder>` substrings).

Return one line: `feature-acceptance: mode=<autonomous|hybrid|manual>; verdict=<completed|paused-pending-operator|stopped>; deferred=<N>`.
