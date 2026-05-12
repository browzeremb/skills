---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics. First detects what verification capabilities the host repo offers (Docker, dev/start scripts, API + DB, frontend dev server, Playwright, browser MCPs, agent-browser), then asks the operator to pick a mode — autonomous (all gates runnable here), autonomous-with-stack-boot (boots the full stack first, then runs gates), hybrid (run what's possible, defer the rest with concrete how-to-verify steps), or manual (operator runs everything, skill emits the runbook). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, smoke test the feature, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check, boot stack and verify."
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
| `autonomous` | Skill runs every verifiable check itself (build, lint, test, http probe, metric query, browser/Playwright probe). Services must already be running. Used when the capability probe returns `verdict=full` and the stack is already up. |
| `autonomous-with-stack-boot` | Same as `autonomous`, but Phase 0 boots the full application stack before running probes. Used when the probe detects that services are not yet running and the stack can be booted within the agent environment in <120s. Degrades to `hybrid` if the boot fails or takes longer. |
| `hybrid` | Skill runs the items it can; emits a manual checklist for the residue with concrete how-to-verify steps. Default when the probe returns `verdict=partial`. |
| `manual` | Skill emits the full how-to-verify checklist; operator runs everything out-of-band and reports back. Always available regardless of probe verdict. |

### Mode picker orthogonality

`CONFIG.mode` (from `browzer get-step CONFIG --id <feat>`) is the **suggested default** surfaced in the `AskUserQuestion` prompt — it is NOT binding. The operator may freely pick any available mode regardless of what `CONFIG.mode` says.

Concretely:
- If `CONFIG.mode=autonomous`, the Phase 0 question pre-selects `autonomous` but also exposes `autonomous-with-stack-boot` if the probe finds a bootable stack.
- If `CONFIG.mode=hybrid`, the question pre-selects `hybrid` but the operator can escalate to `autonomous-with-stack-boot` if they want a full live run.
- The resolved mode is written to `featureAcceptance.mode` — downstream (verdict, `commit`) reads ONLY `featureAcceptance.mode`, never `CONFIG.mode`.

`featureAcceptance.mode` enum: `autonomous | autonomous-with-stack-boot | hybrid | manual`.

### autonomous-with-stack-boot — Phase 0 boot procedure

When the operator picks (or the CI auto-resolves to) `autonomous-with-stack-boot`, run this boot sequence **before** any AC/NFR verification:

#### Capability checklist (all must pass to proceed — otherwise degrade)

| Check | Probe |
| ----- | ----- |
| Docker daemon running | `docker info >/dev/null 2>&1` |
| Compose file present | `test -f docker-compose.yml -o -f compose.yaml -o -f docker-compose.yaml` |
| OR: dev/start script available | `caps.scripts[]` contains at least one of `dev`, `dev:local`, `start`, `up`, `infra:up`, `stack:up` |
| No services already bound on required ports | `curl -sf <backend.url>/health` exits non-zero (i.e. port is free) |
| Boot command resolves (no missing env vars) | dry-run check: `command -v <runner>` exits 0 AND required `env` vars (`DATABASE_URL`, `REDIS_URL`, etc.) are present in `.env*` or shell env |

If Docker + Compose are present, prefer `docker compose up -d` (background). If only a dev/start script exists, use `<runner> <script>` in background (`run_in_background: true`).

#### Boot sequence

1. Run the boot command in background (`run_in_background: true`). Capture PID / process handle.
2. **Readiness probe loop (max 120s):** every 5s, probe `caps.backend.url + /health` (or equivalent) with `curl -sf --max-time 3`. Stop as soon as the probe returns exit 0 — do NOT wait the full 120s.
3. If no health endpoint is known, wait up to 30s then run a lightweight `curl -sf <url>` for any 2xx/3xx; if still failing after 30s, probe `caps.frontend.url` as fallback.
4. If the stack is NOT ready within 120s: emit one log line `[feature-acceptance] autonomous-with-stack-boot: stack not ready after 120s — degrading to hybrid` and switch to `hybrid` mode. Update `featureAcceptance.mode = "hybrid"` and `featureAcceptance.modeNote` to include `"degraded-from: autonomous-with-stack-boot; reason: boot-timeout-120s"`.
5. If a capability check fails before boot (missing env var, Docker not running, etc.): emit `[feature-acceptance] autonomous-with-stack-boot: capability check failed (<reason>) — degrading to hybrid` and degrade similarly.
6. On success: record `featureAcceptance.modeNote` with `"stack-booted: <command>; ready-after: <Xs>"`.

#### Teardown

After all AC/NFR/metric verification completes (regardless of verdict), tear the stack down: run `docker compose down` (if Docker was used) or `kill <pid>` (if a dev script was used). Emit one log line confirming teardown. Do NOT leave background services running.

Live-verify procedures (dashboard / `/ask` / `/sync` probes) are in `references/live-verify.md`. Verification methods per AC type are in `references/verification-methods.md`. Stack-agnostic capability detection is in `references/capability-probe.md`. Manual-instruction templates per surface (backend / frontend / CLI / migration / worker / NFR) are in `references/manual-instructions.md`.

## Precondition — TASK-phase completion check

Run this block before Phase 0. Acceptance cannot begin until every TASK step has exited the execution phase.

1. Load the tasks manifest: `browzer get-step TASKS_MANIFEST --id $ARGUMENTS --json`. If the command exits non-zero OR the manifest's `tasks[]` array is empty, **skip this entire precondition block and proceed directly to Phase 0**. This is the defensive path for hand-crafted workflows or mid-pipeline entries where no TASKS_MANIFEST has been persisted yet.

2. For each `stepId` in the manifest, load its status: `browzer get-step <stepId> --id $ARGUMENTS --json`. Read the `status` field.

3. If any step whose `name == "TASK"` has `status == "PENDING"`, **halt immediately** and emit:

   ```
   feature-acceptance: HALTED — the following TASK steps have not completed:
     - <taskId>: status=PENDING
     ...
   Re-run execute-task for the listed tasks, then re-invoke feature-acceptance.
   ```

   `IN_PROGRESS` is **tolerated** — it falls within the autosave race window under `parallel`, `parallel-worktrees`, and `agent-teams` strategies. If a step remains `IN_PROGRESS` after several minutes, re-invoke `feature-acceptance` to recheck; if it is still `IN_PROGRESS` at that point, treat it as a stuck execution and run `execute-task` for the affected task.

   Do not proceed to Phase 0 until this check passes. This catches the regression class where the autosave hook did not fire (or fired but failed CUE validation), leaving the task status unflipped in `workflow.json` — which would otherwise allow acceptance to run against an incomplete execution.

4. If all TASK steps have `status == "COMPLETED"` (or `IN_PROGRESS` within the tolerated window), proceed to Phase 0.

## Phase 0 — Capability probe + mode picker

This phase is **binding** for every invocation. Skipping it produces stale verdicts when the host repo cannot actually run what the PRD asks for.

1. **Probe.** Run the detection commands from `references/capability-probe.md`. Build the `caps` map (docker, compose, package runner + scripts, backend framework + run cmd + url, frontend framework + dev cmd + url, Playwright, browser MCPs, agent-browser, curl, DBs, test runners). Tolerate missing tools — never abort. Compute the verdict (`full | partial | none`).

2. **Map PRD requirements → capabilities.** For each AC / NFR / metric, decide which surface verifies it (backend HTTP, frontend UI, CLI, DB, worker, perf, security, a11y). Mark each item `runnable-here: true|false` based on `caps`.

3. **Pick the mode via `AskUserQuestion`.** The available options depend on the verdict. `CONFIG.mode` is the **suggested default** — pre-select it in the question but do NOT restrict the operator's choice (see Mode picker orthogonality above).

   | Verdict | Boot-capable? | Options to expose | Recommended default |
   | --- | --- | --- | --- |
   | `full` | yes (stack not running + bootable) | `autonomous-with-stack-boot`, `autonomous`, `hybrid`, `manual` | `autonomous-with-stack-boot` |
   | `full` | no (stack already running or no boot path) | `autonomous`, `hybrid`, `manual` | `autonomous` |
   | `partial` | yes | `autonomous-with-stack-boot`, `hybrid`, `manual` | `hybrid` |
   | `partial` | no | `hybrid`, `manual` | `hybrid` |
   | `none` | — | `manual`, `hybrid` | `manual` — `hybrid` only useful if at least one shell-runnable NFR (lint/test) is callable |

   "Boot-capable" means: `caps.docker=true` AND `caps.compose=true` (or a dev script present), AND all required env vars are resolvable, AND the expected service ports are currently free.

   The question MUST surface, in one short paragraph, the probe summary (what was found / what was missing) so the operator picks an informed mode. Include the per-PRD-item runnable-here counts (e.g. "5 of 8 ACs are runnable here").

   Example question shape:

   > Probe: docker=yes compose=yes pnpm=yes scripts=[dev:local,e2e:smoke] backend=fastify@8080 (not running) frontend=next@3001 (not running) Playwright=yes browser-MCP=no agent-browser=yes; verdict=full boot-capable=yes. 8 of 8 ACs runnable here (CONFIG.mode=autonomous suggested; stack can be booted for fuller live coverage).
   >
   > How should I run acceptance for `<featureId>`?
   > - **autonomous-with-stack-boot (Recommended)** — I boot the stack (<120s), run all 8 ACs live including 3 UI ACs via Playwright, then tear down.
   > - **autonomous** — I run all 8 ACs assuming services are already running (skip if services are not up).
   > - **hybrid** — I run the runnable ACs + all shell-runnable NFRs, then emit a checklist for the rest.
   > - **manual** — I emit the full runbook; you verify everything and reply.

4. **Persist the chosen mode** to `featureAcceptance.mode` (enum: `autonomous | autonomous-with-stack-boot | hybrid | manual`). Stash the one-line probe summary in `featureAcceptance.modeNote` per `references/capability-probe.md §Persistence`.

5. **Edge case — non-interactive runs.** If the orchestrator marks the run as non-interactive (e.g. CI), skip `AskUserQuestion` and resolve the mode deterministically:
   - `verdict=full` + boot-capable + `preRegistered=true` → `autonomous-with-stack-boot`
   - `verdict=full` + (not boot-capable OR `preRegistered=false`) → `autonomous`
   - `verdict=partial` → `hybrid`
   - `verdict=none` → `manual`

   The `autonomous-with-stack-boot` mode is only auto-selected in non-interactive runs when `featureAcceptance.preRegistered=true` in the PRD (the operator must explicitly opt in before the CI run). Record `featureAcceptance.modeNote` with `auto-resolved (non-interactive)`.

## Process

After Phase 0:

1. For each AC: pick a verification method (build, test, http-probe, browser-probe, metric-query, manual-check) using the runnable-here mapping. Run it (autonomous, or hybrid+runnable-here) or write the runbook line from `references/manual-instructions.md` (manual, or hybrid+not-runnable-here).
2. For each NFR: same. See **Autonomous-mode shell-gate enforcement (FR-2)** below for the binding rule when `nfr.target` is a runnable shell command.
3. For each success metric: query the source (Langfuse, Grafana, Postgres, etc). For dashboard / `/ask` / `/sync` metrics that lack live evidence, do NOT auto-flip to `status: met` — record `status: unmet, resolved: false` and append an `operatorActionsRequested[]` entry per `references/live-verify.md §Phase 2.5.1`.
4. Aggregate the verdict.

In **hybrid** mode, the FR-2 shell-gate below still fires for every shell-runnable NFR. Items the agent cannot run (UI surfaces with no Playwright/MCP, missing infra, etc.) become `operatorActionsRequested[]` entries rendered through the templates in `references/manual-instructions.md`.

## Autonomous-mode shell-gate enforcement (FR-2)

This subsection is **binding** for every NFR whose `target` is a shell-runnable command when the resolved `featureAcceptance.mode == autonomous` OR `featureAcceptance.mode == autonomous-with-stack-boot` (or when `mode == hybrid` AND the item is runnable-here). The `autonomous-with-stack-boot` mode follows identical rules to `autonomous` for shell-runnable targets — the only difference is the Phase 0 boot procedure that preceded this gate.

### Mode resolution

Read the mode authoritatively in this order:

1. **Primary** — `featureAcceptance.mode` from the staged file (after Phase 0 wrote it). Valid values: `autonomous | autonomous-with-stack-boot | hybrid | manual`.
2. **Fallback** — `CONFIG.mode` from `browzer get-step CONFIG --id <feat> --json` if Phase 0 did not run (e.g. mid-recovery). `CONFIG.mode` is treated as a suggestion; default to `autonomous` if it maps to `autonomous-with-stack-boot` but Phase 0 never completed.
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

4. **`partial` is BANNED in autonomous / autonomous-with-stack-boot mode for shell-runnable targets.** A non-zero or un-runnable result is `failed` (or routed to manual via the operator-action entry), never silently `partial`. A zero exit is `verified`, never `partial`. There is no third bucket. In **hybrid** mode `partial` is allowed ONLY when the un-runnable item is also recorded in `operatorActionsRequested[]` so the operator can finish it.
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

## Render/display AC gate (binding)

Any acceptance criterion whose verbatim text contains at least one of the following words or phrases (case-insensitive, whole-word or substring match) is a **render-class AC**:

- `render` / `renders` / `rendering`
- `display` / `displays` / `displayed`
- `visible` / `visibility`
- `UI` (case-sensitive match also covers `ui` for case-insensitive contexts)

**Binding rule:** render-class ACs MUST NOT be marked `coversAcceptanceSignal: deferred-post-merge`. The only allowed signals are `pass | warn | block`.

- `pass` — the runtime check confirmed the AC (Playwright assertion, browser MCP screenshot, agent-browser interaction, or visual diff output).
- `warn` — the skill attempted runtime verification but could not complete it in the current mode (e.g. no browser surface available); a `nextSteps` entry MUST describe what the operator must verify manually and by what deadline.
- `block` — the AC explicitly failed the runtime check.

**`deferred-post-merge` is NEVER an acceptable signal for render-class ACs.** If runtime verification is impossible in the current mode (no Playwright, no browser MCP, no agent-browser), emit `coversAcceptanceSignal: warn` AND append a `nextSteps` entry with the verbatim AC text, the exact browser/Playwright step needed to verify it, and why the current environment cannot run it.

> Rationale: render-class ACs are by definition UI correctness claims. Deferring them post-merge means shipping unverified visual regressions. The `warn` path keeps the acceptance gate honest while giving the operator a concrete follow-up task.

### Enforcement algorithm

For every `acceptanceCriteria[]` entry before writing the output JSON:

1. Compute `isRenderClass = /\b(render|display|visible|visibility|UI)\b/i.test(ac.verbatimText)`.
2. If `isRenderClass` AND the resolved signal is `deferred-post-merge`: **rewrite** the signal to `warn`, append to `nextSteps`:
   ```
   [RENDER-CLASS AC <ac.id>] Runtime UI verification was not completed.
   AC text: "<verbatim text>"
   To verify: <concrete Playwright/screenshot/interaction step>.
   Reason not run: <why the current mode/environment could not execute this check>.
   ```
3. Never silently pass a render-class AC without at least a `warn` + `nextSteps` entry when verification was not run.

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
- `featureAcceptance.mode` is set (Phase 0 ran). Valid: `autonomous | autonomous-with-stack-boot | hybrid | manual`.
- The autosave hook validates and persists.
- In `autonomous-with-stack-boot` runs: stack was booted OR a degradation log line was emitted and mode was rewritten to `hybrid`; stack was torn down at end.
- No render-class AC (text contains `render`, `display`, `visible`, `visibility`, or `UI`) has `coversAcceptanceSignal: deferred-post-merge`. Any that could not be runtime-verified carry `coversAcceptanceSignal: warn` with a `nextSteps` entry.
- In `manual` / `hybrid` runs: every un-runnable item has an `operatorActionsRequested[]` entry with a fully-rendered instruction block from `references/manual-instructions.md` (no unresolved `<placeholder>` substrings).

Return one line: `feature-acceptance: mode=<autonomous|hybrid|manual>; verdict=<completed|paused-pending-operator|stopped>; deferred=<N>`.
