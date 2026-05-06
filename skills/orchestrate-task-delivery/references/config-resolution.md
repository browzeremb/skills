# Config resolution — Step 3 (mode + testExecutionDepth)

Two persistent config fields are resolved once at orchestrator entry (Step 3) and consumed by downstream skills. Both are persisted under `.config.<key>` via `browzer workflow set-config`; neither is a workflow step.

| Field | CUE values | Consumed by |
|-------|------------|-------------|
| `config.mode` | `autonomous | review` | Every dispatched skill — controls dispatch primitive (Agent vs Skill) and review-gate behavior. |
| `config.testExecutionDepth` | `static-only | scoped-execute | full-rehearse` | `code-review`'s regression-tester (Phase 4) and `feature-acceptance`'s execution-required AC gate (Phase 8). |

> **`config.executionStrategy` is NOT resolved at Step 3.** The strategy (`serial | parallel | parallel-worktrees | agent-teams`) is owned by `execute-task` and resolved when Phase 3 fires. The orchestrator never prompts for it — `execute-task` has access to the parsed task graph (domains, file scope, dependencies) and is in a better position to choose. See `execute-task/references/dispatch-pattern.md` for the resolution logic, including the `agent-teams` capability probe.

When BOTH `mode` and `testExecutionDepth` are unresolved (no explicit invocation arg, no inherited value in `workflow.json`), fire **a single `AskUserQuestion` call with up to two parallel questions** instead of two serialized prompts. Each section below describes per-field logic.

## §1 — Mode resolution

Resolve `config.mode` in this order:

1. **Explicit in invocation args** — `Skill(orchestrate-task-delivery, "mode: autonomous; <rest>")` or `mode: review`. Take it verbatim.
2. **Inherited from `workflow.json`** — if `.config.mode` is set (mid-flow entry), keep it.
3. **Terminal prompt** (alone or batched):

   ```
   Question header: "Mode"
   Before proceeding:
     (a) autonomous — skills chain with no pauses, no .md generated
     (b) review — gate between skills; you approve/adjust each output
   ```

`config.mode` is a **hard contract**, not a heuristic. Continuation phrases ("prossiga", "continue", "next", "go ahead", "ok") MUST NOT be interpreted as a mode signal. The mode is set EXACTLY ONCE at orchestrator entry (or inherited) and then frozen for the rest of the pipeline.

Persist:

```bash
browzer workflow set-config --await mode "$MODE" --workflow "$WORKFLOW"
browzer workflow set-config --await setAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --workflow "$WORKFLOW"
```

## §2 — Test-execution depth resolution

Mandatory before Phase 4 (CODE_REVIEW) + Phase 8 (FEATURE_ACCEPTANCE). The depth controls whether `code-review`'s regression-tester and `feature-acceptance`'s execution-required AC gate actually run integration / e2e suites or treat them as out-of-scope for the orchestrator turn. Resolving it once here keeps each downstream skill from re-prompting.

**Heuristic — only prompt when the repo HAS integration / e2e suites.** Skip on unit-tests-only repos and default to `static-only`.

```bash
HAS_INTEGRATION=$(find . -type f \( -name '*.integration.test.*' -o -name '*.integration.spec.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)
HAS_E2E=$(find . -type f \( -name '*.e2e.test.*' -o -name '*.e2e.spec.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)

if [ -z "$HAS_INTEGRATION" ] && [ -z "$HAS_E2E" ]; then
  # Repo has only unit tests; default and skip prompt
  browzer workflow set-config --await testExecutionDepth "static-only" --workflow "$WORKFLOW"
  browzer workflow set-config --await testExecutionDepthAuto "true" --workflow "$WORKFLOW"
else
  CURRENT=$(browzer workflow get-config testExecutionDepth --workflow "$WORKFLOW" 2>/dev/null || true)
  if [ -z "$CURRENT" ]; then
    # AskUserQuestion (header: "Test-exec depth"):
    #   (a) static-only       — lint + typecheck + unit only (fastest; CI catches the rest)
    #   (b) scoped-execute    — also run integration/e2e suites for newly added test files
    #   (c) full-rehearse     — run the entire test pipeline
    browzer workflow set-config --await testExecutionDepth "$DEPTH" --workflow "$WORKFLOW"
    browzer workflow set-config --await testExecutionDepthAuto "false" --workflow "$WORKFLOW"
  fi
fi
```

Downstream consumers:
- `code-review/references/regression-tester.md` to decide whether to augment the gate command with integration/e2e suites.
- `feature-acceptance/references/live-verify.md` to decide whether execution-required ACs can be locally verified or must defer with `kind: blocks-commit`.

## §3 — Batched `AskUserQuestion`

When both `mode` and `testExecutionDepth` are unresolved AND the integration/e2e probe at §2 returned non-empty, fire a SINGLE `AskUserQuestion` with two parallel questions (headers: `Mode`, `Test-exec depth`). Persist both with `browzer workflow set-config --await` immediately after the answer is captured. Do NOT serialize the prompts — that doubles the round-trip cost for no UX benefit.

When only one is unresolved, fire the single corresponding prompt. When both are resolved (explicit args or inherited), fire nothing.
