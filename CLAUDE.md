# packages/skills — CLAUDE.md

This package is markdown-only. `lint` and `typecheck` are no-ops. The only executable scripts live under `scripts/` and are plain Node or `.mjs` files.

## Skill eval runner

`scripts/skills-evals.ts` (SKL-2) is a TypeScript Node script that walks the behavioral eval cases declared in each skill's `evals/evals.json` and dispatches one `claude -p` subagent per case to validate that SKILL.md changes preserve intended behavior.

### Trace-replay sub-modes (C2 + C4, on-demand)

`scripts/skills-evals.ts` also exposes two trace-replay modes that read Langfuse traces for a feature run and compute regression metrics. They're utility on-demand (NOT wired to CI by default).

```bash
# C2 — Step-0 skill-load adherence. For every TASK step's
# explorer.skillsFound[] relevance:high entries, verify the matching agent
# dispatch trace called Skill('<name>') BEFORE its first Read or Edit.
node --experimental-strip-types scripts/skills-evals.ts \
  --check-step0-adherence --feat feat-20260505-conversion-balance-liquidation
# Emits: METRIC_STEP0_ADHERENCE=<float>; exit 0 if ≥0.95, else 1.

# C4 — Round-trip-per-mutation ratio. For every Bash trace command matching
# `browzer workflow {init|append-step|patch|...}`, classify success/failure by
# stdout/stderr signature; report the ratio.
node --experimental-strip-types scripts/skills-evals.ts \
  --check-mutation-roundtrip --feat feat-20260505-conversion-balance-liquidation
# Emits: METRIC_MUTATION_ROUNDTRIP=<float>; exit 0 if ≥0.95, else 1.
```

Both modes require `npx langfuse-cli` reachable on PATH and `LANGFUSE_*` env vars (see `.claude/settings.local.json` `env` block — already provisioned for the operator). Targets: 95% adherence (today ~30%) and 0.95 round-trip ratio (today ~0.7).

### `pnpm test:skill-samples` (C1, CI gate)

`scripts/test-skill-samples.mjs` walks every `packages/skills/skills/<skill>/SKILL.md` + `references/**.md`, extracts every fenced `bash` block, and replays each `browzer workflow {verb}` invocation against a fresh fixture to verify the CLI accepts the shape (CUE round-trip).

```bash
pnpm --filter @browzer/skills test:skill-samples
# Refresh the failure baseline after a deliberate change:
node packages/skills/scripts/test-skill-samples.mjs --update-baseline
```

The eval fails CI when the failure SET drifts (a new `<file>:<verb>` pair appears). Pre-existing skill bugs are pinned in `packages/skills/scripts/__fixtures__/skill-samples-baseline.json`. To opt out a known-pseudo-code block, add a `# samples-eval: skip` comment on the line BEFORE the opening fence.

### `node packages/skills/scripts/audit/skill-shell-portability.mjs` (C5, CI gate)

Walks `packages/skills/{skills,references}/**/*.md` for fenced bash blocks and flags idioms that break across macOS bash 3.2 / zsh / GNU bash 4+: `declare -A`, `${VAR[<digit>]}` numeric array indexing, unquoted `*.config*` glob. (`<<EOF` heredoc is fixture-only — see the script header for rationale.)

```bash
node packages/skills/scripts/audit/skill-shell-portability.mjs              # real-mode
node packages/skills/scripts/audit/skill-shell-portability.mjs --self-test  # rule coverage
```

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

### Schema (v1)

The runner accepts three forms in each case's check list and normalises them into the canonical `{name, check}` shape internally:

```jsonc
{
  "id": <int>,
  "name": "<kebab-case>",                       // case identifier
  "prompt": "<what gets sent to claude -p>",
  "expected_output": "<human description>",
  "files": ["<optional fixture path>"],

  // Form A — canonical (preferred for new cases)
  "assertions": [
    { "name": "trailer-present", "check": "output contains 'on-behalf-of: @browzeremb'" }
  ],

  // Form B — typed (richer; commit/ uses this)
  "assertions": [
    { "text": "Subject starts with fix(api/documents):", "type": "regex",    "pattern": "^fix\\(api/documents\\):" },
    { "text": "Org-attribution trailer present",         "type": "contains", "value":   "on-behalf-of: @browzeremb" }
  ],

  // Form C — prose expectations (judge/human review; pipeline skills use this)
  "expectations": [
    "Agent invoked browzer explore",
    "Agent did not fall back to Grep"
  ]
}
```

**Loader normalisation:**

| Input form | How it lands in the runner |
|---|---|
| `{name, check}` (Form A) | unchanged |
| `{text, type:"regex", pattern}` (Form B) | `{name: slug(text), check: "matches /<pattern>/"}` |
| `{text, type:"contains", value}` (Form B) | `{name: slug(text), check: "output contains '<value>'"}` |
| `{name, check, type:"regex", pattern}` (Form B with explicit name) | name kept as-is; check derived from pattern |
| `expectations: ["..."]` (Form C) | each entry → `{name: slug(text), check: <text>}`; falls through to pattern handlers, else null-graded |

**Form C philosophy:** wave-2 pipeline skills (auth-status, semantic-search, …) describe expected behavior in prose. Patterns matching common wave-2 idioms (e.g. `agent ran 'browzer explore'`, `agent did not fall back to Grep`) ARE recognised programmatically — see the table below. Anything else is null-graded (visible in the report, not counted as a failure) until a judge layer ships.

### Assertion patterns (check field)

The runner recognises these patterns. New wave-2 patterns marked **(WV2)**.

| Pattern | Behavior |
|---|---|
| `output contains '<needle>'` | Case-insensitive substring match on subagent output |
| `output contains '<X>' and '<Y>' [and '<Z>'…]` | All needles must appear in output (n-ary) |
| `matches /<pattern>/` **(WV2)** | JS regex applied to subagent output |
| `agent ran 'browzer <subcommand>'` **(WV2)** | Bash tool calls contain `browzer <subcommand>` (any flags) |
| `agent saved JSON to <path-or-glob>` **(WV2)** | Bash tool calls contain `--save <path>` matching the glob |
| `agent did not fall back to grep` / `…to read` **(WV2)** | Bash tool calls contain NO `grep`/`Read` invocations on source files |
| `subagent transcript shows browzer explore OR browzer search was run with Bash tool` | Bash-call probe (legacy form, kept for backward compat) |
| `no file named BRAINSTORM.md was created in docs/browzer/feat-*/` | Filesystem absence check |
| `no directory docs/browzer/feat-*/.meta/ was created by this run` | Filesystem absence check |
| Named assertions (e.g. `research-round-offered`, `phase-7-confirmation-emitted`) | Hard-coded text pattern matchers — see `scripts/skills-evals.ts` `evaluateAssertion()` |
| Anything else | Fuzzy fallback: check string used as needle; unrecognised = `passed: null` (skipped, not a failure) |

Assertions with `passed: null` are skipped (not counted as failures) — use them for cases that require human review.

### Adding a new skill to the eval suite

The runner **auto-discovers** every `packages/skills/skills/*/evals/evals.json`. There is no `EVAL_SOURCES` registry to edit any more.

1. Create `packages/skills/skills/<skill-name>/evals/evals.json` using one of the three schema forms above.
2. Run `pnpm --filter @browzer/skills test:evals -- --dry-run` to confirm the case appears.
3. Add any new named assertion handlers to `evaluateAssertion()` in `scripts/skills-evals.ts` if a one-off check needs custom logic (rare — most cases are covered by the patterns above).

The bespoke `browzer-bootstraper` shape (top-level `common_assertions[]` + per-case `planted_drifts[]` + sandbox dir) is currently **skipped with a warning** by the loader. Migrating it to the hybrid schema (or giving it its own runner path) is tracked as a follow-up.

## Workflow contract sync (WF-SYNC-1, 2026-05-04)

Three changes from the WF-SYNC-1 mega-PR affect this package directly:

- **`validate-frontmatter.mjs` Rule 10** — skills that declare `mutates: true` in frontmatter are now cross-checked against `packages/cli/schemas/workflow-v1.schema.json`. Every field path listed in `mutates` must exist in the CUE-derived schema; unknown paths cause a lint failure. This runs as part of the `quality` CI job (`audit:validate-frontmatter`). When the schema gains a new field, re-run `make all` in `packages/cli/schemas/` before editing skill frontmatter.

- **`validate-frontmatter.mjs` Rule 11** — bash hygiene gate: a skill with raw `jq ... > workflow.json.tmp && mv ...` mutations in its body MUST declare `Bash(jq *)` + `Bash(mv *)` in `allowed-tools` AND must be added to the migration-window allowlist (`scripts/audit/.jq-mutation-allowlist.json`) during the transition period. Post-migration, raw `jq | mv` mutations are deprecated in favour of `browzer workflow` mutator verbs.

- **`judge-skill-runs/SKILL.md` rewritten** over `browzer workflow validate --json --since-version` (WF-SYNC-1 commit 11). The rubric shrank from ~250 to ~50 LOC by eliminating hand-curated ISO-cutoff clauses — the CLI now returns a structured `ValidationResult` that the judge reads directly instead of parsing free-form JSON. If you edit the judge rubric, run `browzer workflow validate --json --since-version` against a recent run to confirm the rubric still evaluates correctly before pushing.

- **Shared-ref sync**: `packages/skills/references/workflow-schema.md` (markdown) and `packages/skills/scripts/renderers/*.jq` (executable jq programs, moved from `references/renderers/` 2026-05-05 to match Claude Code's `${CLAUDE_SKILL_DIR}/scripts/` convention) are **generated artifacts** (from `workflow-v1.cue` via `scripts/cue-to-markdown.mjs` and the renderer codegen step). Do not hand-edit them. After any edit to `packages/cli/schemas/workflow-v1.cue` or the renderer templates, re-run:
  ```bash
  node packages/skills/scripts/sync-shared-refs.mjs
  ```
  This regenerates the markdown reference and all renderer `.jq` files; the `render-coverage.mjs` audit in CI will fail if they drift from the schema.
