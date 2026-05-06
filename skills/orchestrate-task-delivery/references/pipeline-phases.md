# Pipeline Phases — orchestrate-task-delivery

Detailed phase-by-phase descriptions for the 10-phase delivery pipeline (Phases 0–9). Load when executing or validating a specific phase.

## Workflow CLI — verbs disponíveis

Every mutation to `workflow.json` MUST go through `browzer workflow <verb>`. Raw `jq … > .tmp && mv` is deprecated. The CLI validates against the CUE SSOT post-mutation; an invalid payload exits non-zero before any bytes hit disk.

**Mutator verbs** (acquire advisory lock + validate post-mutation; emit stderr audit `verb=… stepId=… elapsedMs=…`):

| Verb | Use |
|---|---|
| `append-step` (stdin payload) | Add a new step (PRD, TASK, COMMIT, …). |
| `append-steps --payload <file\|->` | Plural variant — append N steps in one advisory-lock window. Payload is a JSON array of step objects; CUE validates ONCE against the post-mutation document. Use for batches like the 11-task TASKS_MANIFEST expansion. |
| `update-step <stepId>` | Replace fields on an existing step. |
| `complete-step <stepId>` | Mark step COMPLETED + auto-stamp `elapsedMin` + roll up `totalElapsedMin`. |
| `set-status <stepId> <status>` | Drive the lifecycle FSM (PENDING → RUNNING → AWAITING_REVIEW → COMPLETED/SKIPPED/STOPPED/FAILED). |
| `set-config <key> <value>` | Mutate top-level `config.{mode,executionStrategy,…}`. |
| `set-current-step <stepId>` | Set `currentStepId` + write the `.browzer/active-step` cache. |
| `append-review-history <stepId>` (stdin payload) | Append a `reviewHistory[]` exchange (review-mode). |
| `append-dispatch <stepId> --prompt-file <path>` | Spool a dispatch prompt to `.browzer/dispatch-spool/` + record digest in `dispatches[]`. |
| `append-dispatches --batch '<json-array>'` | Bulk variant — append N `#DispatchRecord` entries (across one or more steps) under one advisory-lock window. Each entry's payload mirrors `append-dispatch` (`promptFile` OR `promptText`, optional `agentId` / `renderTemplate`). One CUE validation, one fsync. |
| `set-finding-status <stepId> <findingId> <status>` | Update one `#Finding.status` (`open` \| `fixing` \| `fixed` \| `wontfix`). `--note <text>` optionally appends a sidecar `notes[]` entry. Bulk form: `set-finding-statuses --batch '<json-array>'`. |
| `audit-model-override <stepId> <from> <to> <reason>` | Record a model-tier override under `task.execution.modelOverride`. |
| `truncation-audit <stepId> --last-checkpoint <s>` | Record a suspected mid-stream truncation. |
| `reapply-additional-context <stepId>` | Walk `task.reviewer.additionalContext.changes[]` into `task.scope`. |
| `patch --jq '<expr>'` | Generic jq mutation — escape hatch when no semantic verb fits. Honors `--arg KEY=VALUE` / `--argjson KEY=<json>` (repeatable). **Single-token form is mandatory.** Space-separated jq-native `--arg name value` is REJECTED by the cobra parser — the second token is consumed as a positional and produces `unknown command "<value>"`. Use `--argjsonfile NAME=<path>` for JSON payloads larger than the env-arg cap. |

**Read verbs** (no mutation, no lock):

| Verb | Use |
|---|---|
| `get-step <stepId> [--field <jq-path>] [--render <template>] [--bash-vars] [--save <path>] [--quiet]` | Fetch one step. `--render` emits prompt-embed text for one of 5 templates (`execute-task`, `code-review`, `brainstorming`, `update-docs`, `generate-task`). `--bash-vars` emits `KEY=value` lines for `eval`. `--save + --quiet` writes to file with zero stdout. |
| `get-config <key>` | Fetch top-level config keys (`mode`, `currentStepId`, …). |
| `validate` | Structural CUE check; non-zero exit on schema violations. |
| `schema [--json-schema] [--field <path>]` | Emit Draft 2020-12 JSON Schema (or markdown summary) of the workflow shape. |
| `query <named>` | Pre-baked cross-step aggregations: `reused-gates`, `failed-findings`, `open-deferred-actions`, `task-gates-baseline`, `changed-files`, `deferred-scope-adjustments`, `open-findings`, `next-step-id`, `cache-warm-deps`, `cache-warm-mentions`, `first-step-by-name --arg name=<NAME>`. |
| `describe-step-type <NAME>` (alias: `describe-step`) | CUE-derived field spec for one step type. |

**Write modes** — every mutating verb honors `--sync` (in-process standalone), `--async` (daemon FIFO, default), `--await` (daemon + fsync). Env `BROWZER_WORKFLOW_MODE=sync|async|await` overrides.

**Quiet modes** — three ways to suppress the per-mutation audit line on stderr (errors and hints still print):

- `--quiet` flag (persistent across the `workflow` command group),
- `BROWZER_WORKFLOW_QUIET=1` env (alternative),
- `BROWZER_LLM=1` or `--llm` (also strips banners + ANSI + spinners; the audit line routes to the SQLite tracker as `workflow-audit:llm-*` so `browzer gain` keeps aggregating).

**There is no `patch step` / `patch <stepId>` verb.** Generic mutations of a step's payload always go through `patch --jq '<expr>'` — for example, `patch --jq '.steps[] |= if .stepId=="STEP_04_TASK_01" then .task.execution.gates.baseline.tests = "pass" else . end'`. Composite verbs like `workflow patch step` do not exist; calling one returns `unknown command "step" for "browzer workflow patch"`.

## Workflow CLI — copy-paste invocations

Canonical literal invocations for every workflow verb. Skills MUST consume these instead of guessing flag shapes — the previous "Use:" tables documented intent without literal flag surface, forcing agents to `--help` each verb. The hook (`packages/skills/hooks/guards/browzer-rewrite-bash.mjs`, WF-SYNC-2) prefixes `BROWZER_LLM=1` on every `browzer …` call automatically; do not add it manually.

Common pattern: every mutator accepts `--workflow <path>`, `--await`, and `--lock-timeout <duration>`. Read verbs accept `--workflow <path>` only.

### init

```bash
browzer workflow init --await --workflow "$WORKFLOW" \
  --feature-id "$FEAT_ID" \
  --feature-name "$FEAT_NAME" \
  --operator-locale "$LOCALE" \
  --original-request "$ORIG_REQ"
# featDir is auto-derived from `--workflow` parent dir; do NOT pass `--feat-dir`.
# Pass `--force` to overwrite an existing seed.
```

### set-config `<key> <value>`

```bash
browzer workflow set-config --await mode "$MODE" --workflow "$WORKFLOW"
# Common keys: mode, executionStrategy, testExecutionDepth, testExecutionDepthAuto.
```

### append-step (stdin payload — preferred)

```bash
echo "$STEP_JSON" | browzer workflow append-step --await --workflow "$WORKFLOW"
# Or with file:  browzer workflow append-step --await --workflow "$WORKFLOW" --payload step.json
# Or with -:     browzer workflow append-step --await --workflow "$WORKFLOW" --payload -
```

### append-steps (plural — single advisory-lock batch)

```bash
# Stdin: a JSON array of step objects (canonical form — exercised in CI).
echo "$STEPS_JSON" | browzer workflow append-steps --await --workflow "$WORKFLOW"
```

Alternative forms (placeholder file path; not exercised in CI):

<!-- # samples-eval: skip — placeholder file path (steps-batch.json) is runtime-only -->
```bash
# With file:
browzer workflow append-steps --await --workflow "$WORKFLOW" --payload steps-batch.json
# Or with - (explicit stdin):
cat steps-batch.json | browzer workflow append-steps --await --workflow "$WORKFLOW" --payload -

# Use append-steps when you have ≥2 steps to append in the same dispatch
# (e.g. TASKS_MANIFEST expansion to 11 TASK_* steps). The whole array is
# applied under ONE advisory lock, validated against CUE ONCE against the
# post-mutation document, persisted via ONE tmp+rename. Saves N–1
# round-trips through the daemon vs. N sequential append-step calls.
#
# Errors:
#   - empty array (`[]`) is rejected — fail loudly when a template
#     expanded to zero entries instead of writing a no-op.
#   - non-array payload (e.g. a single step object) is rejected — use
#     `append-step` for the singular case.
#   - any element that is not a JSON object → indexed error
#     (`payload[N] is not a JSON object`).
```

### update-step `<stepId>`

```bash
browzer workflow update-step "$STEP_ID" --await --workflow "$WORKFLOW" --set status=RUNNING
# Repeatable: pass multiple --set field=value pairs to mutate several fields
# in one advisory-lock window. Use `browzer workflow patch --jq` for shape
# changes that go beyond top-level field=value assignment.
```

### complete-step `<stepId>`

```bash
browzer workflow complete-step "$STEP_ID" --await --workflow "$WORKFLOW"
# Auto-stamps elapsedMin + rolls up totalElapsedMin.
```

### set-status `<stepId> <status>`

```bash
browzer workflow set-status "$STEP_ID" RUNNING --await --workflow "$WORKFLOW"
# Status enum: PENDING, RUNNING, AWAITING_REVIEW, COMPLETED, STOPPED,
#              PAUSED_PENDING_OPERATOR, SKIPPED, FAILED.
```

### set-current-step `<stepId>`

```bash
browzer workflow set-current-step "$STEP_ID" --await --workflow "$WORKFLOW"
# Also writes the .browzer/active-step cache (consumed by langfuse_hook.py).
```

### append-review-history `<stepId>`

```bash
echo "$ENTRY_JSON" | browzer workflow append-review-history "$STEP_ID" \
  --await --workflow "$WORKFLOW" --payload -
```

### append-dispatch `<stepId>`

<!-- # samples-eval: skip — illustrative bash; prompt file path is runtime-only -->
```bash
browzer workflow append-dispatch "$STEP_ID" --await --workflow "$WORKFLOW" --prompt-file prompt.md --agent-id "$AGENT_ID"
# Spools the prompt to .browzer/dispatch-spool/ and records digest in dispatches[].
# Optional: --render-template <name> for skill-specific renderers.
```

### append-dispatches `--batch '<json-array>'`

<!-- # samples-eval: skip — illustrative bash; prompt file paths are runtime-only -->
```bash
browzer workflow append-dispatches --await --workflow "$WORKFLOW" --batch '[
  {"stepId":"STEP_05_CODE_REVIEW","payload":{"promptFile":"/tmp/dispatch-1.txt","agentId":"agent-a","renderTemplate":"code-review"}},
  {"stepId":"STEP_05_CODE_REVIEW","payload":{"promptText":"…","agentId":"agent-b"}}
]'
# Appends N #DispatchRecord entries (across one or more steps) in ONE
# advisory-lock window with a single CUE validation and one fsync —
# replaces the per-dispatch loop pattern that previously took N round-trips.
# Each entry's payload mirrors append-dispatch:
#   promptFile (path) OR promptText (literal bytes)  — required
#   agentId            — optional, defaults to a fresh uuid v4 per entry
#   renderTemplate     — optional skill-specific renderer name
# Spool layout matches the singular form: .browzer/dispatch-spool/<feat-slug>/<stepId>/<agentId>.txt.
```

### set-finding-status `<stepId> <findingId> <status>`

<!-- # samples-eval: skip — illustrative bash; runtime placeholders ($STEP_ID, F-1, $WORKFLOW) require a real workflow fixture -->
```bash
# Singular form — update one #Finding's status under one advisory-lock window.
browzer workflow set-finding-status "$STEP_ID" F-1 fixed --await --workflow "$WORKFLOW"

# Optional --note attaches a sidecar notes[] entry without modifying the
# canonical #Finding shape (CUE validation continues to pass):
browzer workflow set-finding-status "$STEP_ID" F-2 wontfix \
  --note "out of scope for this PR" --await --workflow "$WORKFLOW"

# Status MUST be one of: open | fixing | fixed | wontfix.
# findingId MUST match ^F-[0-9]+$.
# Bulk form for multi-finding updates (replaces the historic loop):
browzer workflow set-finding-statuses --await --workflow "$WORKFLOW" --batch '[
  {"stepId":"STEP_05_CODE_REVIEW","findingId":"F-1","status":"fixed"},
  {"stepId":"STEP_05_CODE_REVIEW","findingId":"F-2","status":"wontfix","note":"out of scope"}
]'
# Both forms validate every entry BEFORE acquiring the lock — a typo in any
# status fails the whole batch with a per-entry index, no partial writes.
```

### audit-model-override `<stepId> <fromModel> <toModel> <reason>`

```bash
browzer workflow audit-model-override "$STEP_ID" sonnet opus "scope-large" \
  --await --workflow "$WORKFLOW"
```

### reapply-additional-context `<stepId>`

```bash
browzer workflow reapply-additional-context "$STEP_ID" --await --workflow "$WORKFLOW"
# Walks task.reviewer.additionalContext.changes[] (kind/from/to/path shape) into task.scope.
# Idempotent NoOp when no changes pending.
```

### truncation-audit `<stepId>`

```bash
browzer workflow truncation-audit "$STEP_ID" --await --workflow "$WORKFLOW" --payload audit.json
```

### patch `--jq <expr>`

```bash
# Generic jq mutation — escape hatch when no semantic verb fits.
browzer workflow patch --await --workflow "$WORKFLOW" \
  --arg "KEY=VAL" --argjson "NUM=42" \
  --jq '(.steps[] | select(.stepId==$KEY)).retryCount = $NUM'
# Single-token form is MANDATORY. Space-separated jq-native form
# `--arg name value` is REJECTED by the cobra parser — the second
# token is consumed as a positional and produces
# `unknown command "<value>"`.
# For payloads larger than the shell env cap (typically ~1-2 MB),
# write to a temp file and inline-read it with `--argjson "NAME=$(cat <path>)"`:
#   FILE=$(mktemp -t patch-payload.XXXXXX.json)
#   echo "$BIG_JSON" > "$FILE"
#   browzer workflow patch --argjson "step=$(cat "$FILE")" --jq '. + $step'
#   rm -f "$FILE"
# Bind variables route through gojq's WithVariables (v1.6.0+).
# There is NO `patch step` / `patch <stepId>` subverb.
```

### get-step `<stepId>` (read-only)

```bash
browzer workflow get-step "$STEP_ID" --workflow "$WORKFLOW"
# Variants:
#   --field '<jq-path>'   extract one field
#   --render <template>   prompt-embed text (execute-task | code-review | brainstorming | update-docs | generate-task | finding)
#   --bash-vars           emit KEY=value lines (consumable by `eval`)
#   --save <path>         write to disk + emit confirmation
#   --quiet               suppress audit telemetry on success
# --field / --render / --bash-vars are mutually exclusive.
```

### get-config `<key>` (read-only)

```bash
browzer workflow get-config mode --workflow "$WORKFLOW"
# Optional: --save <path> + --quiet for zero-stdout writes.
```

### validate (read-only)

```bash
browzer workflow validate --workflow "$WORKFLOW"
# Optional: --json (emit ValidationResult struct), --since-version <RFC3339>.
```

### schema (read-only)

```bash
browzer workflow schema --workflow "$WORKFLOW"
# Optional: --json-schema (Draft 2020-12 JSON Schema), --field <path>.
```

### query `<named>` (read-only)

```bash
browzer workflow query open-findings --workflow "$WORKFLOW"
# Named registry:
#   reused-gates, failed-findings, open-deferred-actions, task-gates-baseline,
#   changed-files, deferred-scope-adjustments, open-findings, next-step-id,
#   cache-warm-deps, cache-warm-mentions, first-step-by-name --arg name=<NAME>
```

### describe-step-type `<NAME>` (read-only) — alias: `describe-step`

```bash
browzer workflow describe-step-type TASK --workflow "$WORKFLOW"
# Same byte-for-byte:
browzer workflow describe-step      TASK --workflow "$WORKFLOW"
# Returns CUE-derived field spec; canonical reference for required/optional fields.
```

## Async vs await — when to drop the durability fence

Every mutator verb honours `--async` (returns immediately, daemon flushes
in the background) and `--await` (default; blocks until the daemon's
durable fsync completes — typically 50–120 ms via daemon, ~500 ms via
standalone fallback). The env knob `BROWZER_WORKFLOW_MODE=sync|async|await`
overrides the per-call default.

**Default — `--await`.** When in doubt, await is correct. The savings
from `--async` only show up on chains of 3+ intermediate writes per
phase; isolated calls do not benefit.

### When `--async` is safe and pays off

| Situation | Mutator pattern | Rationale |
|---|---|---|
| Bulk seed at orchestrator entry (3+ steps queued in a row) | `--async` for the first N-1; `--await` for the Nth | Saves N-1 fsyncs. Daemon serialises per-key; durability order is preserved. |
| Chain of intermediate writes (e.g. `seed-step → set-current-step → set-status RUNNING`) where the next read is at least 2 writes downstream | `--async` for intermediates; `--await` on the final | Pays for one fsync, not N. The trailing `--await` acts as a fence. |
| Single mutation with no follow-up read in the same shell | `--async` | Loop terminates without depending on durability; daemon flushes within ~1 s. |

### When `--await` is mandatory (never `--async`)

| Situation | Why |
|---|---|
| Any write immediately followed by `query` / `get-step` of the same key | Read-after-write ordering required across the daemon ↔ caller boundary. |
| `complete-step` (terminal write of a phase) | The next loop iteration in `SKILL.md §Step 3` assumes the step is durably committed. |
| Any write inside a Skill that another Skill will read | Cross-skill rendezvous — durability boundary. Reading uncommitted state from another skill is a contract violation. |
| Writes from a process whose lifetime is shorter than the daemon flush window | Daemon may still be writing when the caller exits; the write can be lost. |

### Anti-patterns (silent regressions)

- `--async` immediately before `set-current-step <stepId>` with the same
  `<stepId>` from the just-async'd `append-step` — race against the daemon.
  Use `--await` on the `append-step` instead.
- `--async` in a loop with `|| break` semantics — you cannot distinguish
  daemon-accepted-but-rejected-async from real failure without an
  `--await` fence.

## Path discipline — bash CWD persists between tool calls

Every Bash tool call in an agent shell starts at the same CWD the previous
call ended at. A `cd <subdir>` inside one call leaks into the next; a
relative path like `WORKFLOW="docs/<feat>/workflow.json"` then resolves
relative to whatever `<subdir>` the prior call left behind, producing
errors that masquerade as something else (e.g. a daemon `lock timeout` on
a non-existent path).

**Two safe patterns** — pick by which call you are writing:

| Pattern | When | Example |
|---|---|---|
| **Absolute paths everywhere** | One-shot calls, `WORKFLOW=...`, every `--workflow` flag | `WORKFLOW="$(git rev-parse --show-toplevel)/docs/<feat>/workflow.json"` (or any other absolute resolver) |
| **Subshell scope for `cd`** | Multi-step calls that genuinely need a different CWD (build, vendored CLI) | `( cd <subdir> && <cmd> )` — parentheses isolate the CWD change to the subshell |

**Anti-patterns** that surface as confusing errors:

- `cd <subdir> && <cmd>` (no parens) followed by another Bash call that
  uses a relative path — the second call still sees `<subdir>` as CWD.
- Relying on `pwd` between calls — there's no guarantee a hook or wrapper
  hasn't `cd`'d the shell since you last looked.
- Quoting an absolute path with `~` (`"~/foo"`) — the tilde is not
  expanded inside double quotes; resolve via `"$HOME/foo"` instead.

When a `lock timeout` / `path not found` / "another browzer workflow
command is mutating ..." error names a path you don't recognise, suspect
CWD drift first. The recovery is one extra `cd "$REPO_ROOT" &&` (or an
absolute path) before the offending call.

## Daemon — best-effort warm-up

```bash
browzer daemon status >/dev/null 2>&1 || browzer daemon start --background &
# Non-blocking; suppresses `mode=fallback-sync reason=daemon_unreachable` on first mutation.
# Run ONCE at orchestrator entry (Step 0.2).
```

## Phase 0.5 — Dependency install first-action (one-time, blocking)

Run BEFORE Phase 0/1/2 in any repo whose lockfile + manifest disagree.
Pays the install cost once at orchestrator entry rather than letting N
downstream tasks observe `deferred-typecheck` warnings or false test
failures. Skip silently when the manifest is absent OR already in sync.

```bash
# Detect manifest+lockfile pair, run the matching install verb when stale.
# Stale = manifest missing OR mtime newer than the lockfile/cache marker.
# Each branch is a one-shot: success → continue; failure → STOP with hint.
if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then
    if [ ! -f node_modules/.modules.yaml ] || \
       [ package.json -nt node_modules/.modules.yaml ]; then
      pnpm install --frozen-lockfile=false || \
        { echo "orchestrate-task-delivery: stopped at Phase 0.5 — pnpm install failed"; exit 1; }
    fi
  elif [ -f yarn.lock ]; then
    [ -d node_modules ] && [ ! package.json -nt yarn.lock ] || yarn install
  elif [ -f bun.lockb ] || [ -f bun.lock ]; then
    [ -d node_modules ] && [ ! package.json -nt bun.lockb 2>/dev/null ] || bun install
  else
    [ -d node_modules ] || npm install
  fi
elif [ -f pyproject.toml ]; then
  if [ -f poetry.lock ]; then
    poetry check --quiet 2>/dev/null || poetry install --no-interaction
  elif [ -f uv.lock ]; then
    uv sync --frozen 2>/dev/null || uv sync
  fi
elif [ -f go.mod ]; then
  go mod download
fi
```

A typical Node monorepo cold-install is ~35s; a Go module download is
seconds. The cost is amortised across every subsequent phase that runs
`lint` / `typecheck` / unit tests, so paying it now eliminates the
class of "test failed because workspace dep wasn't resolved" findings
that otherwise contaminate code-review.

## Phase 0 — Brainstorming (conditional)

Invoke `brainstorming` ONLY when input is vague. Heuristics:

- < 20 words AND no file path, persona, or verb-object pair.
- Starts with "what if" / "could we" / "would it be cool if".
- Names a capability with no success signal ("add X").

Else skip and chain to Phase 1.

## Phase 1 — PRD

`Skill(skill: "generate-prd", args: "feat dir: $FEAT_DIR")`. This skill does NOT auto-chain — the orchestrator drives the next phase.

## Phase 2 — Task manifest + per-task steps

`Skill(skill: "generate-task", args: "feat dir: $FEAT_DIR")`. Produces `STEP_03_TASKS_MANIFEST` + `STEP_04_TASK_01 … STEP_NN_TASK_MM` with Explorer + Reviewer payloads.

## Phase 2.5 — Execution strategy resolution (silent unless multi-domain)

Before dispatching Phase 3, compute the domain partition from the just-written tasksManifest and decide between `serial` (default) and `agent-teams` strategy. The two strategies are **orthogonal** to `config.mode` (autonomous|review): `mode` decides WHEN the operator gates between phases; `executionStrategy` decides HOW Phase 3 dispatches work.

```bash
DOMAINS=$(jq -r '
  [ .steps[]
    | select(.name == "TASK")
    | .task.scope.files[]?
    | split("/")[0:2] | join("/")
  ] | unique
' "$WORKFLOW")
TASK_COUNT=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" | jq '.TASK // [] | length')
DOMAIN_COUNT=$(echo "$DOMAINS" | jq 'length')
```

Decision rules — silent defaults; only ask when team mode is plausibly useful:

- `TASK_COUNT < 2` → `serial` silently. Team overhead with no benefit.
- `DOMAIN_COUNT < 2` → `serial` silently. No domain partition possible.
- `DOMAIN_COUNT ≥ 2` AND `TASK_COUNT ≥ 2` → `AskUserQuestion`:

  ```
  Phase 3 has <TASK_COUNT> tasks across <DOMAIN_COUNT> domain roots:
    <comma-separated domain list>

  Execution strategy:
    (a) serial — current default; per-task execute-task dispatch (sequential
        within tasks; worktree-parallel within tasksManifest.parallelizable[][]
        when the heuristic in Phase 3 fires)
    (b) agent-teams — domain-bound parallel team via TeamCreate + TaskList +
        N specialists (one per domain). Zero merge conflicts when domain
        isolation holds. Saves wall-clock when domains are orthogonal.
  ```

Persist the choice to workflow.json:

```bash
browzer workflow set-config --await executionStrategy "$STRATEGY" --workflow "$WORKFLOW"
# Note: `config.setAt` is the mode-set timestamp (autonomous/review) and is
# stamped during orchestrator entry — do not re-stamp it on strategy choice.
```

Inheritance: if `.config.executionStrategy` is already set (re-entry mid-flow), keep it. Don't re-prompt.

## Phase 3 — Execute each task

Branch on `.config.executionStrategy`:

- `agent-teams` → `Skill(skill: "execute-with-teams", args: "feat dir: $FEAT_DIR")`. The skill writes `STEP_<NN>_TASK_TEAM_EXEC` with `status: COMPLETED` aggregating per-specialist deliverables; orchestrator's Step 4 reads it as the Phase 3 completion gate and chains directly to Phase 4 (CODE_REVIEW). Skip the rest of Phase 3 below.
- `serial` (or unset for legacy workflows) → continue with the per-task path below.

### Phase 3 — serial path

Read the manifest:

```bash
TM=$(browzer workflow query tasks-manifest --workflow "$WORKFLOW")
TASKS=$(echo "$TM" | jq -r '.tasksOrder[]')
PARALLEL=$(echo "$TM" | jq -c '.parallelizable')
```

For each task in order:

- **Sequential case**: `Skill(skill: "execute-task", args: "TASK_N; feat dir: $FEAT_DIR")`. Wait for COMPLETED before the next.
- **Parallel case**: for each group in `parallelizable[]`, dispatch all tasks in ONE response turn via `Task(..., isolation: "worktree")`. See `references/parallel-dispatch.md` for worktree rendezvous.

**Render the task context, never inline the raw payload.** When the dispatcher passes task context into a parallel-worktree agent (worktree mode loses live `workflow.json` access — see `references/parallel-dispatch.md §Step 2.1`), use the renderer instead of dumping the raw `.task` payload:

```bash
TASK_CONTEXT=$(browzer workflow get-step "$STEP_ID" --render task --workflow "$WORKFLOW")
```

The renderer at `scripts/renderers/task.jq` emits a compressed prompt-embed text block (scope, invariants, files, AC ids, dependencies). Inlining the raw payload duplicates ~3KB per dispatch and drifts when the operator edits the PRD mid-flow. Adoption metric: `render-template-adoption` should sit at ~100% — the dogfood report's 0% baseline came from dispatchers free-writing the prompt body. Use the renderer.

Trivial-task fast path: if `.task.trivial == true`, `execute-task` uses the ≤15-line integration glue path, skips the test-specialist dispatch, and goes directly to aggregation. The orchestrator still invokes `execute-task` — the fast path lives inside that skill.

## Phase 4 — Code review

After ALL task steps complete, invoke code-review.

In **autonomous mode**, the orchestrator MUST pre-register sensible defaults to skip the dispatch+tier prompts that would otherwise re-prompt operator consent already given at orchestrator entry. Compute:

- `dispatchMode`: `parallel-with-consolidator` (always available regardless of Agent Teams flag).
- `tier`: derive from changed-file count via the same scope formula code-review uses internally — `small` ≤ 3 files, `medium` 4–10 files, `large` ≥ 11 files. Map to the recommended tier: `small` → `recommended`, `medium` → `recommended`, `large` → `recommended`.

Pass them in args:

```
Skill(skill: "code-review", args: "feat dir: $FEAT_DIR; dispatchMode: parallel-with-consolidator; tier: recommended")
```

In **review mode**, omit the pre-registered values so the operator sees the prompts.

Writes `STEP_<NN>_CODE_REVIEW` with `findings[]`.

## Phase 5 — Receiving code review

`Skill(skill: "receiving-code-review", args: "feat dir: $FEAT_DIR")`. Reads `codeReview.findings[]` from the prior `CODE_REVIEW` step and dispatches per-finding fix agents until every finding reaches `status: fixed` (or — after exhausting the 7-iteration ladder — gets logged to `receivingCodeReview.unrecovered[]` AND the repo's tech-debt doc).

Skipping `RECEIVING_CODE_REVIEW` entirely when `codeReview.findings[]` is non-empty is a contract violation.

## Phase 6 — Write tests + mutation testing

Branch on `.config.executionStrategy`:

- `agent-teams` → **SKIP this phase**. Record Phase 6 as a SKIPPED step.
  `#WriteTests` requires `skipped: bool` even when the step is SKIPPED — the
  payload below sets it explicitly.

  ```bash
  NN=$(browzer workflow query next-step-id --workflow "$WORKFLOW")
  STEP_ID="STEP_$(printf '%02d' $NN)_WRITE_TESTS"
  TEAM_EXEC_REF=$(browzer workflow query steps-by-name --workflow "$WORKFLOW" | jq -r '[.TASK[]? | select(.taskId=="TEAM_EXEC")][-1].stepId')

  PAYLOAD=$(jq -n \
    --arg id "$STEP_ID" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg ref "$TEAM_EXEC_REF" \
    '{
       stepId: $id, name: "WRITE_TESTS", status: "SKIPPED",
       applicability: {
         applicable: false,
         reason: ("rolled into team execution; see " + $ref + ".task.teamExecution.testAndMutation")
       },
       startedAt: $now, completedAt: $now, elapsedMin: 0,
       retryCount: 0, itDependsOn: [$ref], nextStep: "",
       skillsToInvoke: [], skillsInvoked: [],
       owner: null, worktrees: { used: false, worktrees: [] },
       warnings: [], reviewHistory: [], dispatches: [],
       writeTests: {
         skipped: true,
         skipReason: ("rolled into team execution; see " + $ref + ".task.teamExecution.testAndMutation"),
         runner: null,
         filesAuthored: [],
         notes: ""
       }
     }')
  echo "$PAYLOAD" | browzer workflow append-step --await --workflow "$WORKFLOW"
  ```

  Then chain directly to Phase 7 (UPDATE_DOCS).

- `serial` (or unset for legacy workflows) → `Skill(skill: "write-tests", args: "feat dir: $FEAT_DIR")`. Runs AFTER `receiving-code-review` so tests cover the final state.

  Skipped automatically when the repo carries no test setup — `write-tests`'s detector returns `hasTestSetup: false` and the step is recorded as `SKIPPED` with `applicability.reason: "no test setup detected"`.

## Phase 7 — Update docs

`Skill(skill: "update-docs", args: "feat dir: $FEAT_DIR")`. Uses `browzer mentions` + direct-ref + concept-level signals. Writes `STEP_<NN>_UPDATE_DOCS`.

## Phase 8 — Feature acceptance

`Skill(skill: "feature-acceptance", args: "feat dir: $FEAT_DIR")`. Always prompts autonomous/manual/hybrid (regardless of `config.mode`). Three terminal verdicts:

- `COMPLETED` — all checks verified. Chain to commit.
- `PAUSED_PENDING_OPERATOR` — automated checks passed, but `operatorActionsRequested[]` carries unresolved `kind: "deferred-post-merge"` entries. STILL chain to commit; emit success line with `; ⚠ <N> deferred-post-merge actions pending`.
- `STOPPED` — at least one AC/NFR/metric failed. Stop the chain; hint back to `receiving-code-review` or `execute-task`.

## Phase 9 — Commit

`Skill(skill: "commit", args: "feat dir: $FEAT_DIR")`. Writes `STEP_<NN>_COMMIT` with the SHA. In review mode, `commit` renders `commit.jq` and loops on operator edits before firing the git commit.

### Phase 9 closure narrative — what "completed" actually means

The orchestrator's scope ENDS at the local `git commit`. State (a)–(b) are inside scope;
(c)–(e) are explicitly OUT of scope. The closure line and the operator-facing one-line
summary MUST distinguish these states so "pipeline complete" is not interpreted as "PR
mergeable".

| Stage | Owner | In orchestrator scope? |
| --- | --- | --- |
| (a) Local commit created (SHA stamped, hooks ran via Phase 8.5) | `commit` skill | YES |
| (b) Local pre-push gates passed (audit simulation in Phase 8.5) | `commit` skill | YES |
| (c) `git push` to remote | operator | NO |
| (d) CI pipeline green (remote test runs, integration / e2e on shared infra) | CI | NO |
| (e) PR review + merge | reviewer / merge bot | NO |

Closure line shape (autonomous mode, success):

```
orchestrate-task-delivery: pipeline complete; <N> steps written to workflow.json; SHA <sha> ready for operator-driven push
```

Closure line shape (autonomous mode, paused-pending-operator):

```
orchestrate-task-delivery: pipeline paused; <N> steps written to workflow.json; SHA <sha> ready for operator-driven push; <P> deferred-post-merge actions pending
```

**Banned closure phrases** (rot when CI catches bugs the orchestrator's static skills did
not — e.g. type drift on integration tests, FK seed-order violations, env-var gaps):

- "PR mergeable"
- "ready to merge"
- "ship it"
- "all green"
- "100% complete"

These phrases conflate (a)+(b) with (c)+(d)+(e) and produce the failure mode where the
operator pushes only to discover lefthook + CI catch additional bugs the orchestrator
declared resolved. The honest framing is "ready for operator-driven push" — local work is
done, remote validation is the operator's next action.

## Step 4 — Validate skill output

After every Skill returns its tool_result, the loop body in `SKILL.md §Step 3` reads the just-written step via jq before iterating to the next phase:

```bash
LAST=$(browzer workflow get-config currentStepId --workflow "$WORKFLOW")
STATUS=$(browzer workflow get-step "$LAST" --field status --workflow "$WORKFLOW")
```

- `COMPLETED` → chain to the next phase.
- `AWAITING_REVIEW` → review mode is driving; wait for the skill to return a final status.
- `PAUSED_PENDING_OPERATOR` → only valid for `feature-acceptance`. Chain to commit; surface the deferred-action count.
- `STOPPED` → stop the chain; emit stop line + hint.
- `SKIPPED` → chain to the next phase.

Also validate the payload schema matches `references/workflow-schema.md` §4. If malformed, append `globalWarnings[]` and re-dispatch once; on second failure, STOP.

## Step 6 — Stop conditions

Stop the chain when any of these fire:

- **3-strike external failure**: a non-skill tool (git, pnpm, browzer CLI) fails 3 times for the same reason.
- **Feature-acceptance verdict STOPPED**: one or more AC/NFR/metrics failed. Hint to `receiving-code-review` re-entry or `execute-task` remediation.
- **Operator abort**: operator replies with "stop" / "abort" / "cancel" to any gate prompt.
- **Schema corruption**: `jq empty "$WORKFLOW"` fails, or a step's payload fails schema §4 shape check twice.

Stop line shape:

```
orchestrate-task-delivery: stopped at <stepId> — <one-line cause>
hint: <single actionable next step>
```

## Step 7 — Completion

On success, backfill elapsed-time fields BEFORE printing the success line:

<!-- # samples-eval: skip — multi-line jq expression cannot be replayed by the line-oriented test harness -->
```bash
browzer workflow patch --workflow "$WORKFLOW" --jq '
  ((.startedAt | fromdateiso8601) as $start
   | (.updatedAt | fromdateiso8601) as $end
   | .totalElapsedMin = (($end - $start) / 60 | floor))
  | .steps |= map(
      if (.startedAt and .completedAt) then
        ((.startedAt | fromdateiso8601) as $s
         | (.completedAt | fromdateiso8601) as $e
         | .elapsedMin = (($e - $s) / 60 | floor))
      else . end)'
```

Then print:

```
orchestrate-task-delivery: completed <featureId> in <elapsedMin>m; commit <SHA>
```
