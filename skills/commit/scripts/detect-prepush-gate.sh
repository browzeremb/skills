#!/usr/bin/env bash
# detect-prepush-gate.sh — discover (do NOT run) the repo's pre-push gates and
# emit a JSON manifest that the `commit` skill consumes.
#
# Why a separate detection script instead of inlining prose in the skill body:
#   Prose-only gate detection hands the enumeration logic to the LLM, which
#   then re-derives the conventions on every commit. A deterministic script is
#   parsed once at edit-time, produces stable JSON, and is testable in isolation.
#
# What this script does:
#   Walks three detection layers in priority order and emits every gate it finds
#   WITHOUT executing any of them. The caller (`commit` skill or a sibling
#   run-script) decides which ones to execute and in what mode.
#
# Output (stdout, valid JSON, exit 0 always):
#   {
#     "gatesDetected": [
#       { "name": "<id>", "path": "<relative-path>", "kind": "<shell|npm-script|manifest>" }
#     ]
#   }
#
# Discovery layers:
#   1. .git/hooks/pre-push      — raw git hook (any executable file at that path)
#   2. Hook-manager manifests   — well-known YAML/TOML manifests at the project root.
#      Discovery is operator-driven via env var GATE_MANIFESTS; when unset, the
#      script falls back to a deliberately empty default (callers configure their
#      own host's known manifest names — the plugin is agnostic about which hook
#      manager you use).
#      Examples:
#        GATE_MANIFESTS=my-hook.yml,.my-hook.yaml,.hooks/pre-push
#   3. package.json scripts     — "pre-push" or "prepush" entries under "scripts:"
#
# Exit code: always 0. No external commands beyond bash built-ins + optional
# node for JSON prettying; jq is NOT required.

set -uo pipefail

# --------------------------------------------------------------------------- #
# Helpers                                                                       #
# --------------------------------------------------------------------------- #

# Accumulator: newline-separated JSON object strings
_entries=""

_add() {
  local name="$1" path="$2" kind="$3"
  # Manually compose the object — no jq dependency.
  local obj
  obj="{\"name\":\"${name}\",\"path\":\"${path}\",\"kind\":\"${kind}\"}"
  if [ -z "$_entries" ]; then
    _entries="$obj"
  else
    _entries="${_entries},${obj}"
  fi
}

# --------------------------------------------------------------------------- #
# Layer 1 — raw git hook                                                        #
# --------------------------------------------------------------------------- #
if [ -x ".git/hooks/pre-push" ]; then
  _add "git-hook" ".git/hooks/pre-push" "shell"
fi

# --------------------------------------------------------------------------- #
# Layer 2 — hook-manager manifest files                                         #
# --------------------------------------------------------------------------- #
# Operator-supplied list. Plugin ships agnostic — callers (the `commit` skill
# or host CI) declare which manifest names to probe. Empty default means
# layer 2 is a no-op unless GATE_MANIFESTS is set in the environment.
_default_manifests=""

if [ -n "${GATE_MANIFESTS:-}" ]; then
  # Comma-separated → space-separated
  _manifest_list="${GATE_MANIFESTS//,/ }"
else
  _manifest_list="$_default_manifests"
fi

for _mf in $_manifest_list; do
  if [ -f "$_mf" ]; then
    # Derive a stable name from the manifest filename (strip leading dot, drop extension)
    _mf_base="${_mf##*/}"          # basename
    _mf_base="${_mf_base#.}"       # strip leading dot
    _mf_name="${_mf_base%%.*}"     # strip extension
    _add "manifest:${_mf_name}" "$_mf" "manifest"
  fi
done

# --------------------------------------------------------------------------- #
# Layer 3 — package.json scripts: pre-push / prepush                           #
# --------------------------------------------------------------------------- #
# Shell-only grep; no node/jq dependency.
if [ -f "package.json" ]; then
  # Match "pre-push" or "prepush" as a key under "scripts": section.
  # Heuristic: look for the JSON key pattern "pre-push" or "prepush" anywhere
  # in package.json (common layout keeps scripts at top level).
  if grep -qE '"(pre-push|prepush)"[[:space:]]*:' package.json 2>/dev/null; then
    # Determine which key exists to set an accurate path fragment.
    if grep -qE '"pre-push"[[:space:]]*:' package.json 2>/dev/null; then
      _add "package-script" "package.json#scripts.pre-push" "npm-script"
    fi
    if grep -qE '"prepush"[[:space:]]*:' package.json 2>/dev/null; then
      _add "package-script-prepush" "package.json#scripts.prepush" "npm-script"
    fi
  fi
fi

# --------------------------------------------------------------------------- #
# Emit JSON                                                                     #
# --------------------------------------------------------------------------- #
printf '{"gatesDetected":[%s]}\n' "$_entries"
