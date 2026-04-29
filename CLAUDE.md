# packages/skills — CLAUDE.md

This package is markdown-only. `lint` and `typecheck` are no-ops. The only executable scripts live under `scripts/` and are plain Node or `.mjs` files.

## Skill eval runner

`scripts/skills-evals.ts` (SKL-2) is a TypeScript Node script that walks the behavioral eval cases declared in each skill's `evals/evals.json` and dispatches one `claude -p` subagent per case to validate that SKILL.md changes preserve intended behavior.

> **Local-only — NOT a CI gate.** The runner depends on (a) the Claude Code CLI being on `PATH` and (b) a valid `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). The GitHub Actions runner has neither, and provisioning the token would burn API quota on every PR. Run it on a developer laptop before shipping a SKILL.md change. The CI step was removed in 2026-04-29 after a first attempt at gating quality on `claude` availability surfaced the cost/feasibility trade. To re-introduce a CI gate later: install the CLI in a workflow step, provision the token as a repo secret, and gate the eval step on `if: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}` — preferably in a separate workflow (`skills-evals.yml`) triggered by `workflow_dispatch` + cron, NOT on every PR.

### Running

```bash
# From repo root (recommended):
node --experimental-strip-types --env-file=.env.local scripts/skills-evals.ts

# Via pnpm filter (cwd = packages/skills):
pnpm --filter @browzer/skills test:evals

# Dry-run: lists all cases without dispatching subagents (no API quota consumed):
pnpm --filter @browzer/skills test:evals -- --dry-run

# Filter to a single skill:
pnpm --filter @browzer/skills test:evals -- --skill brainstorming
pnpm --filter @browzer/skills test:evals -- --skill generate-task

# Verbose output (subagent stderr + first 400 chars of response):
pnpm --filter @browzer/skills test:evals -- --verbose

# Override per-case timeout in seconds (default: 180):
pnpm --filter @browzer/skills test:evals -- --timeout 300
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes (or `ANTHROPIC_API_KEY`) | Authentication for `claude -p` subagents. Set in `.env.local` or CI secrets. |
| `ANTHROPIC_API_KEY` | Alternative to OAuth token | Direct API key auth for claude CLI. |

The runner itself does not call the Anthropic API directly — it spawns `claude -p` subprocesses which inherit the shell environment. Ensure one of the above auth mechanisms is set before running.

### Output format

```
METRIC_PASS_RATE=<float in [0.0, 1.0]>
passed=<int> total=<int>
```

Per-case lines are emitted to stdout with `PASS` / `FAIL` / `?` (skipped assertion) indicators. `METRIC_PASS_RATE` is always the last summary metric emitted — CI can `grep METRIC_PASS_RATE` to extract it.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All cases passed (pass rate = 1.0) |
| `1` | One or more cases failed |
| `2` | `claude` CLI not found on PATH, or `evals.json` unreadable |

### Concurrency and wall-clock budget

Cases are dispatched with a concurrency cap of 4 (`Promise.all` over a chunked queue). At 180s timeout per case and 11 total cases, worst-case wall-clock is ≤ 3 × 180s = 9 minutes (well within the 15-min AC-7 budget). The cap is hardcoded as `CONCURRENCY = 4` in the script.

### How to add a new eval case

1. Open the skill's `evals/evals.json` file (e.g. `packages/skills/skills/brainstorming/evals/evals.json`).
2. Append a new object to the `evals` array with the following required keys:

```json
{
  "id": <next integer>,
  "name": "<kebab-case-identifier>",
  "prompt": "<the full prompt sent to claude -p>",
  "expected_output": "<human-readable description of what the skill should produce>",
  "files": ["<optional list of fixture file paths>"],
  "assertions": [
    {
      "name": "<assertion-id>",
      "check": "<check description — see Assertion patterns below>"
    }
  ]
}
```

3. Run `pnpm --filter @browzer/skills test:evals -- --dry-run` to confirm your case appears in the list without consuming API quota.
4. Run the full suite (`pnpm --filter @browzer/skills test:evals`) to verify the new case passes.

### Assertion patterns (check field)

The runner recognises several assertion patterns based on the `check` string:

| Pattern | Behavior |
|---|---|
| `output contains '<needle>'` | Case-insensitive substring match on subagent output |
| `output contains '<X>' and '<Y>'` | Both needles must appear in output |
| `subagent transcript shows browzer explore OR browzer search was run with Bash tool` | Checks bash tool calls for `browzer explore`/`browzer search` |
| `no file named BRAINSTORM.md was created in docs/browzer/feat-*/` | Filesystem absence check |
| `no directory docs/browzer/feat-*/.meta/ was created by this run` | Filesystem absence check |
| Named assertions (e.g. `research-round-offered`, `phase-7-confirmation-emitted`) | Hard-coded text pattern matchers — see `scripts/skills-evals.ts` `evaluateAssertion()` |
| Anything else | Fuzzy fallback: check string itself used as needle; unrecognized = `null` (skipped, not a failure) |

Assertions with `passed: null` are skipped (not counted as failures) — use them for cases that require human review.

### Adding a new skill to the eval suite

To add a third skill (e.g. `execute-task`):

1. Create `packages/skills/skills/execute-task/evals/evals.json` following the same schema.
2. Add an entry to `EVAL_SOURCES` in `scripts/skills-evals.ts`:
   ```ts
   { skill: 'execute-task', path: join(PKG_SKILLS, 'skills', 'execute-task', 'evals', 'evals.json') },
   ```
3. Add any new named assertion handlers to `evaluateAssertion()` in the same script.
