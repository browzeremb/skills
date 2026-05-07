---
name: feature-acceptance
description: "Verify a finished feature against its PRD acceptance criteria, NFRs, and success metrics — autonomous mode (agent executes every shell-runnable NFR target via Bash; non-zero exit ⇒ pending, never partial) or manual mode (operator runs a how-to-verify checklist out of band). Use before `commit` to confirm 'is this actually done?'. Triggers: feature acceptance, acceptance gate, verify acceptance criteria, check AC/NFR/metrics, 'is this feature ready', 'is the feature done', final verification, pre-commit acceptance, sign-off check."
argument-hint: "<featureId>"
---

You are the acceptance gate. Verify every AC, NFR, and success metric from the PRD before commit.

## Read context

```
!`browzer get-step FEATURE_ACCEPTANCE --id $ARGUMENTS 2>/dev/null || echo "(no prior FEATURE_ACCEPTANCE step — first run)"`
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`.

The blob includes the PRD's acceptance criteria, NFRs, success metrics, and the list of completed TASK_NN execution receipts.

## Modes

| Mode | Behavior |
| ---- | -------- |
| `autonomous` | The skill runs every verifiable check itself (build, lint, test, dashboard probe, metric query). |
| `manual` | The skill emits a checklist; the operator runs it out-of-band and reports back. |

The mode comes from the orchestrator; default is `autonomous`. Live-verify procedures (dashboard / `/ask` / `/sync` probes) are in `references/live-verify.md`. Verification methods per AC type are in `references/verification-methods.md`.

## Process

1. For each AC: pick a verification method (build, test, http-probe, metric-query, manual-check). Run it (autonomous) or write the runbook line (manual).
2. For each NFR: same. See **Autonomous-mode shell-gate enforcement (FR-2)** below for the binding rule when `nfr.target` is a runnable shell command.
3. For each success metric: query the source (Langfuse, Grafana, Postgres, etc). For dashboard / `/ask` / `/sync` metrics that lack live evidence, do NOT auto-flip to `status: passed` — record `status: pending` with `instructions: "pending operator verification"` instead.
4. Aggregate the verdict.

## Autonomous-mode shell-gate enforcement (FR-2)

This subsection is **binding** for every NFR whose `target` is a shell-runnable command when `CONFIG.mode == autonomous`.

### Mode resolution

Read `CONFIG.mode` authoritatively:

```bash
browzer get-step CONFIG --id <feat> --json
```

The resolved mode lives at `CONFIG.mode`. Resolution cascade:

1. **Primary** — `CONFIG.mode` from the JSON above.
2. **Fallback** — if `CONFIG.mode` is absent (e.g. the orchestrator did not thread `--mode` to `workflow init`), fall back to the dispatch-context `Mode:` line passed by the orchestrator on this skill's invocation.
3. **Default** — if both are absent, default to `autonomous` AND emit a single warning line (verbatim):

   ```
   [feature-acceptance] WARNING: CONFIG.mode not set; defaulting to autonomous. Operator: consider re-running with explicit --mode or set CONFIG.mode.
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

Anything else (free-prose criteria, dashboard probe descriptions, "operator visually confirms…") is NOT shell-runnable — fall back to the standard verification-methods playbook.

> Always prefer the explicit `runnable: true` contract for new PRDs. The heuristic exists only to keep legacy NFRs working; it is intentionally conservative and will reject ambiguous strings.

### Autonomous-mode contract (binding)

For every shell-runnable target, when `mode == autonomous`, the skill MUST:

1. Execute the target via the **Bash tool**. Do NOT mock, paraphrase, dry-run, or skip. Do NOT ask the operator to run it.
2. Capture exit code, stdout, and stderr. Truncate captured output to the first 4096 characters before recording.
3. Map the result to a status using exactly this table — no other outcomes are allowed:

   | Outcome | `status` | `evidence` |
   | --- | --- | --- |
   | Exit code `0` | `verified` | `"<command> → exit 0"` |
   | Exit code non-zero (other than 127) | `pending` | `"<command> → exit <code>; stderr: <truncated>"` |
   | Exit code `127` or stderr contains `command not found` | `pending` | `"<command> failed — binary not found"` |
   | Tool/config missing (e.g. config file absent, required env var unset, the command itself prints a "missing X" error before any real work) | `pending` | `"<command> failed — <missing tool/config detail>"` |

4. **`partial` is BANNED in autonomous mode for shell-runnable targets.** A non-zero or un-runnable result is `pending`, never `partial`. A zero exit is `verified`, never `partial`. There is no third bucket.
5. The `rationale` field on the NFR record MUST cite the exact command that ran AND the failure mode (or the success exit). Generic phrases like "tests passed" without the command are non-compliant.

### Review-mode behavior (unchanged)

When `mode == review`, the skill MAY emit a per-NFR checklist for the operator to execute out-of-band, then accept the operator's verdict (`verified | partial | pending`) and rationale via the standard review-history exchange. Narrative-only verification (no Bash invocation) is acceptable in review mode.

### Safety guardrails

Autonomous Bash execution is bounded by the following non-negotiable guardrails. They apply to every shell-runnable NFR target.

- **Per-command timeout: 600s (10 minutes).** If the command does not return within 600s, terminate it and record `status: pending` with `evidence: "<command> exceeded 600s timeout"`. Do not retry within the same run.
- **Sequential execution.** Run one shell-runnable NFR at a time by default. Operators MAY opt into parallel execution by setting `featureAcceptance.parallelism: <int>` in the PRD if the workflow schema admits the field; absent that, parallelism is `1`.
- **Refused-verb list.** Before executing, scan the resolved command string. If it contains ANY of the following patterns (substring match, case-sensitive unless noted), refuse it: `rm -rf`, `dd if=/`, `mkfs`, `:(){:|:&};:`, `sudo`, `chmod -R 000`, `git push --force`, `git reset --hard origin/`, `kubectl delete`, `terraform destroy`. Refused commands record `status: pending` with `evidence: "command refused for safety: <pattern>"` and a `rationale` naming the matched pattern. Do not prompt the operator to override.
- **Working directory.** Execute commands from the repo root unless the NFR `target` itself uses `cd` explicitly to change directory. Never set CWD implicitly based on the NFR id or filename.

### Worked examples

Assume an NFR with `id: NFR-LINT` and `target: "pnpm --filter @<workspace>/<package> lint"`. The detector classifies this as shell-runnable (verb `pnpm` + `--filter` flag within 80 chars; no English connectors).

**Happy path (autonomous, exit 0):**

```jsonc
{
  "id": "NFR-LINT",
  "status": "verified",
  "evidence": "pnpm --filter @<workspace>/<package> lint → exit 0",
  "rationale": "Executed `pnpm --filter @<workspace>/<package> lint` via Bash; exit 0 confirms the lint NFR."
}
```

**Failure path (autonomous, exit ≠ 0):**

```jsonc
{
  "id": "NFR-LINT",
  "status": "pending",
  "evidence": "pnpm --filter @<workspace>/<package> lint → exit 1; stderr: <first 4096 chars of stderr>",
  "rationale": "Executed `pnpm --filter @<workspace>/<package> lint` via Bash; exit 1 with lint diagnostics — recorded as pending (autonomous-mode contract forbids `partial` for shell-runnable targets)."
}
```

**Missing-binary path (autonomous, exit 127):**

```jsonc
{
  "id": "NFR-CARGO",
  "status": "pending",
  "evidence": "cargo test failed — binary not found",
  "rationale": "Executed `cargo test` via Bash; `command not found` (exit 127). Recorded as pending per FR-2; not partial."
}
```

**Refused-verb path (autonomous, safety guardrail):**

Assume an NFR with `id: NFR-CLEAN` and `target: "rm -rf ./build && pnpm build"`. The string contains the refused pattern `rm -rf`, so the safety guardrail short-circuits before any Bash invocation:

```jsonc
{
  "id": "NFR-CLEAN",
  "status": "pending",
  "evidence": "command refused for safety: rm -rf",
  "rationale": "Target `rm -rf ./build && pnpm build` matched the refused-verb pattern `rm -rf`; not executed. Operator must rewrite the NFR to avoid destructive verbs (e.g. use the build tool's clean target)."
}
```

## Produce

Write `docs/browzer/<feat>/staging/FEATURE_ACCEPTANCE.json`.

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

`verdict` is one of `APPROVED` or `BLOCKED`.

Verdict rules: any `failed` AC/NFR → `BLOCKED`. All `passed` or `deferred-with-rationale` → `APPROVED`. `pending` items: in **autonomous** mode they block the verdict (treat as incomplete → `BLOCKED`); in **manual** mode they are allowed and the verdict can still be `APPROVED` provided each `pending` item is also recorded under `deferredActions[]` with a rationale.

## Persistence

The autosave hook persists `staging/FEATURE_ACCEPTANCE.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --await` — FEATURE_ACCEPTANCE is load-bearing: `commit` reads it back immediately after this phase completes.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Done when

- File exists at `docs/browzer/<feat>/staging/FEATURE_ACCEPTANCE.json`.
- The autosave hook validates and persists.

Return one line: `feature-acceptance: verdict=<APPROVED|BLOCKED>; deferred=<N>`.
