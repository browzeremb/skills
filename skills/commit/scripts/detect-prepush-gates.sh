#!/usr/bin/env bash
# detect-prepush-gates.sh — enumerate and run the repo's local pre-push gates,
# then emit a single JSON document the `commit` skill consumes.
#
# Why this exists:
#   Phase 8.5 of the commit skill used to inline ~30 lines of bash that scanned
#   for lefthook / husky / raw-git-hook configurations and ran them in-place.
#   The inline form had no fixture coverage, regressed silently when the
#   markdown was edited, and was re-parsed by the agent on every commit.
#
# Output (stdout, single line, valid JSON):
#   {
#     "audits":  [ { "name": <str>, "source": <"lefthook"|"husky"|"git">,
#                    "exitCode": <int>, "durationMs": <int> }, ... ],
#     "failed":  [ <name>, ... ],
#     "runners": [ <"lefthook"|"husky"|"git">, ... ]
#   }
#
# Exit code:
#   Always 0 (presence of failures is signalled in the JSON, not the exit code,
#   so the caller can decide how to react). The skill's Phase 8.5 reads the
#   "failed" array and stops the commit on non-empty.

set -uo pipefail

audits_json=""
failed_json=""
runners_json=""

emit_audit() {
  local name="$1" source="$2" exit_code="$3" duration_ms="$4"
  local entry
  entry=$(jq -n \
    --arg n "$name" --arg s "$source" \
    --argjson e "$exit_code" --argjson d "$duration_ms" \
    '{ name: $n, source: $s, exitCode: $e, durationMs: $d }')
  if [ -z "$audits_json" ]; then
    audits_json="$entry"
  else
    audits_json="${audits_json},${entry}"
  fi
  if [ "$exit_code" != "0" ]; then
    if [ -z "$failed_json" ]; then
      failed_json="\"$name\""
    else
      failed_json="${failed_json},\"$name\""
    fi
  fi
}

add_runner() {
  local r="$1"
  if [ -z "$runners_json" ]; then
    runners_json="\"$r\""
  else
    runners_json="${runners_json},\"$r\""
  fi
}

_now_ms() {
  # Portable millisecond clock. GNU date supports `+%s%3N`; BSD/macOS does
  # not (it echoes the format literal `…%3N`, which then breaks the
  # arithmetic later). Node is already a hard dependency of this package, so
  # using it for timing avoids a second probe-and-fallback path.
  node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0
}

run_one() {
  local name="$1" source="$2" cmd="$3"
  local started ended exit_code duration_ms
  started=$(_now_ms)
  set +e
  eval "$cmd" >/dev/null 2>&1
  exit_code=$?
  set -e
  ended=$(_now_ms)
  duration_ms=$((ended - started))
  emit_audit "$name" "$source" "$exit_code" "$duration_ms"
}

# 1. Lefthook (preferred — used by this monorepo + most JS/TS projects)
if command -v lefthook >/dev/null 2>&1 && { [ -f lefthook.yml ] || [ -f lefthook.yaml ]; }; then
  add_runner "lefthook"
  cfg=""
  [ -f lefthook.yml ] && cfg="lefthook.yml"
  [ -z "$cfg" ] && [ -f lefthook.yaml ] && cfg="lefthook.yaml"
  cmds=""
  if command -v yq >/dev/null 2>&1 && [ -n "$cfg" ]; then
    cmds=$(yq -r '.pre-push.commands | keys // [] | .[]' "$cfg" 2>/dev/null || true)
  fi
  if [ -n "$cmds" ]; then
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      run_one "lefthook:$c" "lefthook" "lefthook run pre-push --commands $c"
    done <<< "$cmds"
  else
    run_one "lefthook:pre-push" "lefthook" "lefthook run pre-push"
  fi
fi

# 2. Husky
if [ -f .husky/pre-push ]; then
  add_runner "husky"
  run_one "husky:pre-push" "husky" "bash .husky/pre-push"
fi

# 3. Raw git hook (only when no higher-level manager is present)
if [ -x .git/hooks/pre-push ] && [ ! -f lefthook.yml ] && [ ! -f lefthook.yaml ] && [ ! -f .husky/pre-push ]; then
  add_runner "git"
  run_one "git:pre-push" "git" ".git/hooks/pre-push"
fi

# Final JSON document
printf '{"audits":[%s],"failed":[%s],"runners":[%s]}\n' \
  "$audits_json" "$failed_json" "$runners_json"
