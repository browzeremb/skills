# Daemon + cache warmup — Step 0.2 + Step 0.5 + Step 2.5

Operational warmup steps that reduce noise + cold-cache latency at orchestrator entry. All three are best-effort and non-blocking. They live here (rather than in `pipeline-phases.md`) because they are pre-pipeline concerns — the pipeline itself starts at Step 1 (init feat dir).

## Step 0.2 — Daemon pre-warm + health-check

Pre-warm the Browzer daemon so the FIRST workflow mutation hits the JSON-RPC fast path instead of falling back to standalone-sync (which pollutes stderr with `mode=fallback-sync reason=daemon_unreachable`). Single command, fire-and-forget:

```bash
browzer daemon status >/dev/null 2>&1 || browzer daemon start --background &
```

After the warm-up, confirm the daemon answered the protocol handshake. A daemon that started but is wedged in a stale-protocol state silently routes every mutation to fallback-sync — the warm-up appears to succeed but the whole pipeline pays the standalone cost. Quick sanity check:

```bash
# Allow the background start a moment to bind the socket. Short, bounded.
sleep 0.5

DAEMON_OK=$(browzer daemon status --json 2>/dev/null \
  | jq -r 'if .protocolVersion and .uptimeSec then "ok" else "stale" end' 2>/dev/null \
  || echo "down")

case "$DAEMON_OK" in
  # silent — happy path
  ok) : ;;
  # one explicit restart; if THIS still fails, fall through to "down"
  stale)
    browzer daemon stop >/dev/null 2>&1 || true
    browzer daemon start --background &
    sleep 0.5
    ;;
  *)
    echo "warn: daemon unreachable — every mutation will fall back to standalone-sync (slower but correct)" >&2
    ;;
esac
```

Best-effort — do NOT block longer than the bounded `sleep 0.5` waits. If both attempts fail, the standalone path still works; the warm-up is purely a noise-reduction optimization. Skip when the workflow runs on a host without socket support (Windows native — the daemon is Unix-only).

> **Why no `: "${BROWZER_LLM:=1}"; export …` block:** the previous orchestrator (76871ee2 WS-3) set this env var to silence the per-mutation audit line. In Claude Code agent shells each Bash tool call is **isolated** — `export` does not persist between calls. The plugin's PreToolUse(Bash) hook (`packages/skills/hooks/guards/browzer-rewrite-bash.mjs`, WF-SYNC-2) now injects `BROWZER_LLM=1` per-call automatically. Operator opt-out: prefix any specific `browzer …` command with `BROWZER_LLM=0` or pass `--llm=0`.

## Step 0.5 — Dependency install (one-time, conditional)

If the target repo carries a manifest+lockfile pair AND the lockfile cache is stale (or `node_modules/` is absent), pay the install cost once at orchestrator entry. See `references/pipeline-phases.md §Phase 0.5` for the exact detection block (Node/pnpm, npm, yarn, bun; Python/poetry, uv; Go) and the failure-mode stop hint. A 35s pnpm install up-front kills the class of `deferred-typecheck` / "workspace dep unresolved" findings that otherwise pollute every downstream code-review.

For repos with no Node/Python/Go manifest detected, this step is a no-op — proceed directly to Step 1.

## Step 2.5 — Pre-warm per-feature cache

After the Browzer queries (Step 2 in `SKILL.md`), pre-warm the per-feature cache by reading the task manifest (if it exists from a prior run) and priming key jq paths. This avoids cold-cache latency on the first Phase 3 dispatch:

```bash
TM=$(browzer workflow query tasks-manifest --workflow "$WORKFLOW")
if [ "$TM" != "null" ]; then
  # warm: task order + parallelizable groups + domain partition
  echo "$TM" | jq -r '.tasksOrder[]' > /tmp/orch-task-order.txt
  echo "$TM" | jq -c '.parallelizable' > /tmp/orch-parallel.json
fi
```

Best-effort — skip silently if `tasks-manifest` query fails or no prior manifest exists.

## Step 2.6 — Pre-warm `.schema-cache/` (single-pass step-type schemas)

Pre-fetch every step-type CUE shape the pipeline will dispatch, so downstream skills jq cached files instead of re-invoking `describe-step-type` per phase. Costs ~7 × 150ms once; saves 3+ roundtrips on the first validator rejection in any phase.

```bash
SCHEMA_CACHE="/tmp/${FEAT_ID}/.schema-cache"
mkdir -p "$SCHEMA_CACHE"
for stepName in PRD TASK CODE_REVIEW UPDATE_DOCS WRITE_TESTS COMMIT FEATURE_ACCEPTANCE; do
  browzer workflow describe-step-type "$stepName" --json --save "$SCHEMA_CACHE/$stepName.json" --quiet
done
```

> **Nested paths:** when a downstream skill needs the shape of a sub-tree (for example `task.execution.agents[]`), use `--field 'task.execution.agents'` on the SAME `describe-step-type` call rather than jq-filtering the cached file after the fact. Single call, only the path you need.
