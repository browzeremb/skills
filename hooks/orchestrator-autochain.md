# orchestrator-autochain hook

Stop hook that enforces the autonomous-mode chain contract for the
`orchestrate-task-delivery` workflow. When a phase-end confirmation line
fires (`<skill>: …STEP_NN_NAME…status COMPLETED|AWAITING_REVIEW|PAUSED_PENDING_OPERATOR`)
and the same response did NOT call the next phase's `Skill(...)`, the hook
blocks the stop and surfaces a remediation hint pointing at the chain
contract in `orchestrate-task-delivery/SKILL.md §Step 3` and
`references/mode-contract.md §Step 4.0.5`.

## Activation

Auto-installed via `packages/skills/hooks/hooks.json` (the plugin's `Stop`
array). Operators with the `browzer@browzer-marketplace` plugin enabled get
it for free — no manual `~/.claude/settings.json` edit required. Verify the
plugin is enabled:

```bash
jq -r '.enabledPlugins["browzer@browzer-marketplace"]' ~/.claude/settings.json
# → true
```

## Behavior

| Condition                                                             | Action      |
| --------------------------------------------------------------------- | ----------- |
| `stop_hook_active == true`                                            | no-op       |
| No `docs/browzer/feat-*/workflow.json` in cwd                         | no-op       |
| Newest workflow's `.config.mode != "autonomous"`                      | no-op       |
| Last assistant message has a `Skill` tool_use block                   | no-op       |
| Last assistant message matches `orchestrate-task-delivery: completed` | no-op       |
| Last assistant message matches `<skill>: paused at STEP_…`            | no-op       |
| Last assistant message matches phase-end pattern WITHOUT Skill call   | **BLOCK**   |

The block emits `{"decision":"block","reason":"<hint>"}` and lets the
operator (or the agent on next turn) fire the next-phase `Skill(...)` to
resume the chain.

## Disabling

The hook respects `stop_hook_active` so a single re-prompt cycle is the
worst case — it never loops. To disable entirely (e.g. a flow where the
operator wants to iterate manually outside the autonomous chain), set
`config.mode != "autonomous"` in the active workflow.json:

```bash
browzer workflow set-config --await mode review --workflow "$WORKFLOW"
```

## Testing

Smoke-test all branches:

```bash
HOOK="${CLAUDE_PLUGIN_ROOT:-packages/skills}/hooks/orchestrator-autochain.py"

# 1. stop_hook_active short-circuit
python3 "$HOOK" <<< '{"stop_hook_active": true}'

# 2. block path (autonomous + phase-end + no Skill call)
mkdir -p /tmp/oa-test/docs/browzer/feat-x && echo '{"config":{"mode":"autonomous"}}' \
  > /tmp/oa-test/docs/browzer/feat-x/workflow.json
cat > /tmp/oa-test/transcript.jsonl <<'TXT'
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"code-review: updated workflow.json STEP_09_CODE_REVIEW; status COMPLETED"}]}}
TXT
python3 "$HOOK" <<< '{"transcript_path":"/tmp/oa-test/transcript.jsonl","cwd":"/tmp/oa-test"}'
# → {"decision": "block", "reason": "..."}
```
