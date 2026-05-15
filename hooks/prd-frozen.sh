#!/usr/bin/env bash
# Browzer hook wrapper — delegates to `browzer hook prd-frozen`.
# Exit-code protocol: 0=allow (payload on stdout), 1=passthrough,
# 2=deny, 3=ask.
set -uo pipefail

# Dep guard: silent short-circuit if jq or browzer is missing.
command -v jq      >/dev/null 2>&1 || exit 0
command -v browzer >/dev/null 2>&1 || exit 0

# Optional audit log (opt-in via BROWZER_HOOK_AUDIT=1).
_audit() {
  if [ "${BROWZER_HOOK_AUDIT:-0}" = "1" ]; then
    local dir="${BROWZER_AUDIT_DIR:-${HOME}/.local/share/browzer}"
    mkdir -p "$dir" 2>/dev/null
    printf '%s | prd-frozen | %s\n' "$(date -u +%FT%TZ)" "$1" \
      >> "${dir}/hook-audit.log" 2>/dev/null || true
  fi
}

# Read stdin (Claude Code hook input JSON).
INPUT="$(cat)"

# Dispatch.
OUTPUT="$(printf '%s' "$INPUT" | browzer hook prd-frozen 2>/dev/null)"
CODE=$?

case "$CODE" in
  0)
    _audit "allow"
    printf '%s' "$OUTPUT"
    ;;
  1)
    _audit "passthrough"
    exit 0
    ;;
  2)
    _audit "deny"
    if [ -n "$OUTPUT" ] && printf '%s' "$OUTPUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
      printf '%s\n' "$OUTPUT"
    else
      jq -n --arg reason "denied by browzer hook prd-frozen" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
    fi
    ;;
  3)
    _audit "ask"
    if [ -n "$OUTPUT" ] && printf '%s' "$OUTPUT" | jq -e '.hookSpecificOutput.permissionDecision == "ask"' >/dev/null 2>&1; then
      printf '%s\n' "$OUTPUT"
    else
      jq -n --arg reason "ask user (browzer hook prd-frozen)" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
    fi
    ;;
  *)
    _audit "unknown"
    exit 0
    ;;
esac
