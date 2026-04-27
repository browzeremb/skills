#!/usr/bin/env bash
# jq-helpers.sh — shared shell helpers for skills that mutate workflow.json.
#
# Why this file exists:
#   Every per-phase skill (generate-prd, generate-task, execute-task,
#   code-review, update-docs, feature-acceptance, commit, plus
#   orchestrate-task-delivery itself) writes the same shape of jq | mv
#   block ~3-6 times: stamp a step, complete it, append review history,
#   bump a counter, validate gates. The blocks rot independently across
#   skills and contract-level invariants (like "gates.regression must
#   exist when gates.baseline does") become impossible to enforce
#   uniformly.
#
#   This file is the single source of truth for those mutations. Skills
#   `source` it once at the top of their bash sections and call the
#   helpers directly. New skills get the same atomicity, the same
#   enforcement, and the same temp-file cleanup as everyone else.
#
# How to use it:
#   The dispatching skill is read from the plugin's skills/ tree, but
#   bash blocks inside the skill execute in the *user's repo* CWD. The
#   skill must therefore know where to find this helper. Both paths
#   below are valid lookups (try them in order):
#
#     # canonical — always present in the plugin install:
#     source packages/skills/references/jq-helpers.sh
#
#     # mirror — co-located with the skill (works for vendored skills):
#     source "$(dirname "$0")/references/jq-helpers.sh"
#
#   Skills already declare `Bash(source *)` in `allowed-tools` for any
#   skill that calls these helpers — `validate-frontmatter.mjs` enforces
#   it.
#
# Required environment:
#   FEATURE     — the workflow's feat-<date>-<slug> directory name. The
#                 helpers compute WORKFLOW from this so every skill
#                 reads/writes the same file.
#
# Atomicity:
#   Every mutation goes through `<filter> > "$WORKFLOW.tmp" && mv
#   "$WORKFLOW.tmp" "$WORKFLOW"`. If jq fails for any reason, the temp
#   file is left for inspection and the canonical workflow.json stays
#   unchanged. This is the only sanctioned mutation pattern — never
#   `Read`/`Write`/`Edit` workflow.json from a skill.

set -euo pipefail

# Resolve the workflow path lazily so callers can `source` this file
# before they've decided on a feature dir (e.g. orchestrate-task-delivery
# may discover FEATURE later in its bootstrap).
_workflow_path() {
  : "${FEATURE:?FEATURE env var must be set before calling jq-helpers}"
  printf 'docs/browzer/%s/workflow.json' "$FEATURE"
}

_now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# seed_step STEP_ID NAME KIND
#   Create a new step entry with status=RUNNING. Idempotent: re-seeding
#   an already-running step refreshes startedAt without losing existing
#   reviewHistory or warnings.
seed_step() {
  local step_id="$1" name="$2" kind="$3"
  local workflow now
  workflow="$(_workflow_path)"
  now="$(_now_utc)"
  jq --arg id "$step_id" --arg name "$name" --arg kind "$kind" --arg now "$now" '
    .steps[$id] = (
      (.steps[$id] // {}) + {
        name: $name,
        kind: $kind,
        status: "RUNNING",
        startedAt: $now,
        retries: ((.steps[$id].retries // 0)),
        warnings: ((.steps[$id].warnings // [])),
        reviewHistory: ((.steps[$id].reviewHistory // []))
      }
    )
  ' "$workflow" > "$workflow.tmp" && mv "$workflow.tmp" "$workflow"
}

# complete_step STEP_ID PAYLOAD_JQ_EXPR
#   Stamp status=COMPLETED + endedAt, then merge the caller's
#   payload-jq-expression onto the step. The expression must yield a
#   JSON object; it's evaluated in the same jq invocation so the caller
#   can reference `.steps[$id]` if they need read-modify-write semantics.
complete_step() {
  local step_id="$1" payload_expr="$2"
  local workflow now
  workflow="$(_workflow_path)"
  now="$(_now_utc)"
  jq --arg id "$step_id" --arg now "$now" "
    .steps[\$id].status = \"COMPLETED\"
    | .steps[\$id].endedAt = \$now
    | .steps[\$id].payload = ($payload_expr)
  " "$workflow" > "$workflow.tmp" && mv "$workflow.tmp" "$workflow"
}

# append_review_history STEP_ID ROUND OPERATOR DECISION NOTE CHANGES_JSON
#   Push a review-mode entry onto steps[id].reviewHistory[]. CHANGES_JSON
#   is a JSON string (already-encoded); pass `[]` for no changes.
append_review_history() {
  local step_id="$1" round="$2" operator="$3" decision="$4" note="$5" changes="$6"
  local workflow now
  workflow="$(_workflow_path)"
  now="$(_now_utc)"
  jq --arg id "$step_id" \
     --arg round "$round" \
     --arg op "$operator" \
     --arg decision "$decision" \
     --arg note "$note" \
     --arg now "$now" \
     --argjson changes "$changes" '
    .steps[$id].reviewHistory += [{
      round: ($round | tonumber),
      ts: $now,
      operator: $op,
      decision: $decision,
      note: $note,
      changes: $changes
    }]
  ' "$workflow" > "$workflow.tmp" && mv "$workflow.tmp" "$workflow"
}

# bump_completed_count
#   Recount summary.completedSteps from .steps[*] | select(.status ==
#   "COMPLETED"). Idempotent. Call after any complete_step / step status
#   change so the orchestrator's roll-up never drifts.
bump_completed_count() {
  local workflow
  workflow="$(_workflow_path)"
  jq '
    .summary.completedSteps = ([.steps[] | select(.status == "COMPLETED")] | length)
  ' "$workflow" > "$workflow.tmp" && mv "$workflow.tmp" "$workflow"
}

# validate_regression STEP_ID
#   Returns non-zero (and prints to stderr) if .steps[id].payload.gates
#   has a non-null baseline but a null regression. This is the
#   subagent-preamble Step 2.5 contract: any step that captured a
#   baseline owes the orchestrator a regression diff before claiming
#   COMPLETED. Use as a guard inside execute-task / code-review's
#   post-edit gate-merge step.
validate_regression() {
  local step_id="$1"
  local workflow
  workflow="$(_workflow_path)"
  if ! jq -e --arg id "$step_id" '
    (.steps[$id].payload.gates.baseline == null)
    or (.steps[$id].payload.gates.regression != null)
  ' "$workflow" >/dev/null; then
    echo "validate_regression: gates.regression is null but gates.baseline is set on $step_id" >&2
    return 1
  fi
}
