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
#   Recount the workflow-level roll-up counters from the live .steps[]
#   array. Idempotent. Call after any complete_step / step status change
#   so the orchestrator's roll-up never drifts.
#
#   Fields refreshed:
#     - summary.completedSteps  ← steps with status == "COMPLETED"
#     - completedSteps          ← same count, top-level mirror (legacy
#                                 schema field; kept in sync to avoid drift
#                                 with consumers that read either path).
#     - totalSteps              ← .steps | length (recount; the manual
#                                 increment in some skills drifted past
#                                 the array length — see dogfood report
#                                 friction §workflow.totalSteps).
#     - totalElapsedMin         ← sum of .steps[].elapsedMin (per-step
#                                 elapsedMin is stamped by the CLI on
#                                 status=COMPLETED transitions; this
#                                 helper aggregates them so the workflow
#                                 root reflects total wall-clock).
bump_completed_count() {
  local workflow
  workflow="$(_workflow_path)"
  # `.steps` is allowed to be either an object (legacy seed_step layout,
  # keyed by stepId) or an array (newer schema with stepId as a field).
  # The expressions below normalise to an iterable so the helper works
  # in either shape.
  jq '
    (.steps // {}) as $steps
    | (if ($steps | type) == "array" then $steps else ($steps | to_entries | map(.value)) end) as $arr
    | .summary.completedSteps = ([$arr[] | select(.status == "COMPLETED")] | length)
    | .completedSteps          = ([$arr[] | select(.status == "COMPLETED")] | length)
    | .totalSteps              = ($arr | length)
    | .totalElapsedMin         = ([$arr[] | (.elapsedMin // 0)] | add // 0)
  ' "$workflow" > "$workflow.tmp" && mv "$workflow.tmp" "$workflow"
}

# compute_severity_counts FINDINGS_JSON
#   Compute {high,medium,low} from a JSON array of findings. Echoes the
#   resulting object to stdout. Use this output as the canonical
#   severityCounts payload — never free-write the counts inline. The
#   dogfood report friction §code-review.severityCounts caught a 1+7+19
#   payload value that disagreed with the actual 1+10+16 findings[]
#   distribution. Compute, don't trust the agent.
#
#   FINDINGS_JSON is the raw findings[] array as a JSON string.
compute_severity_counts() {
  local findings_json="$1"
  jq -c '
    [.[] | .severity] | group_by(.)
    | map({key: .[0], value: length}) | from_entries
    | { high: (.high // 0), medium: (.medium // 0), low: (.low // 0) }
  ' <<< "$findings_json"
}

# assert_severity_counts STEP_ID
#   Compare the persisted severityCounts on a code-review step against
#   the live findings[] distribution. Returns non-zero if they disagree.
#   Call as a guard after writing the step.
assert_severity_counts() {
  local step_id="$1"
  local workflow
  workflow="$(_workflow_path)"
  local actual expected
  actual=$(jq -c --arg id "$step_id" '
    (.steps // []) as $steps
    | (if ($steps | type) == "array" then $steps else ($steps | to_entries | map(.value)) end)
    | .[] | select(.stepId == $id) | .codeReview.severityCounts // .payload.codeReview.severityCounts
  ' "$workflow")
  expected=$(jq -c --arg id "$step_id" '
    (.steps // []) as $steps
    | (if ($steps | type) == "array" then $steps else ($steps | to_entries | map(.value)) end)
    | .[] | select(.stepId == $id)
    | (.codeReview.findings // .payload.codeReview.findings // [])
    | [.[] | .severity] | group_by(.)
    | map({key: .[0], value: length}) | from_entries
    | { high: (.high // 0), medium: (.medium // 0), low: (.low // 0) }
  ' "$workflow")
  if [ "$actual" != "$expected" ]; then
    echo "assert_severity_counts: drift on $step_id" >&2
    echo "  persisted: $actual"  >&2
    echo "  computed:  $expected" >&2
    return 1
  fi
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

# ============================================================================
# Phase 1 spine helpers (canonical CLI-backed; no inline jq pipelines).
#
# These wrap `browzer workflow ...` invocations so every skill writes the
# same audit lines, honors the same locks, and gets the same atomic
# guarantees for free. Skills should `source` this file once at the top
# of any bash block that mutates workflow.json (Phase 1 router contract).
#
# Required env: WORKFLOW (path to the workflow.json being mutated). All
# four helpers below pass `--workflow "$WORKFLOW"` explicitly so they work
# from any CWD without relying on walk-up resolution.
# ============================================================================

# start_step STEP_ID
#   Flip a step's status to RUNNING. The CLI auto-stamps `startedAt` on
#   the first transition (and PRESERVES an existing startedAt on re-entry
#   per Risk Checkpoint #2 in the Phase 1 plan). Skills MUST NOT manually
#   set startedAt anymore — call this helper instead.
#
#   Idempotent: re-invocation on an already-RUNNING step is a legal no-op
#   from the CLI's perspective (transition table allows the cycle); the
#   original startedAt is preserved.
start_step() {
  local step_id="$1"
  : "${WORKFLOW:?WORKFLOW must be set before calling start_step}"
  browzer workflow set-status --await "$step_id" RUNNING --workflow "$WORKFLOW"
}

# clarification_audit QUESTION ANSWER RATIONALE
#   Persist a record of an AskUserQuestion clarification (mode resolution,
#   strategy choice, "Execute TASK_N?" budget question, FA mode prompt)
#   into the workflow root's `notes[]` array. Without this, the audit
#   trail loses every operator interaction that didn't fit a review-gate
#   slot — and "why did we dispatch opus on TASK_01?" becomes
#   unanswerable post-merge (friction §7 in the dogfood report).
#
#   Caps the array at 50 entries via LRU drop (Risk Checkpoint #6) so
#   long-running workflows don't bloat the schema.
clarification_audit() {
  local question="$1" answer="$2" rationale="$3"
  : "${WORKFLOW:?WORKFLOW must be set before calling clarification_audit}"
  local now
  now="$(_now_utc)"
  browzer workflow patch --await --workflow "$WORKFLOW" --jq \
    --arg q "$question" --arg a "$answer" --arg r "$rationale" --arg now "$now" \
    '.notes = ((.notes // []) + [{
        at: $now,
        kind: "clarification-budget",
        question: $q,
        answer: $a,
        rationaleAtTime: $r
      }])
    | .notes = (.notes | if length > 50 then .[length - 50:] else . end)'
}

# truncation_audit STEP_ID FILES_MODIFIED LAST_CHECKPOINT
#   Record a suspected mid-stream truncation (subagent stopped without
#   reaching Step-4 atomic write AND without emitting Step-4.5 partial-
#   status JSON, but DID modify files). FILES_MODIFIED must be a JSON
#   array string (e.g. '["a.ts","b.go"]'). The orchestrator's audit
#   inspects this entry to decide whether to re-dispatch with explicit
#   "ALWAYS emit partial-status" emphasis (Phase 2 friction §7).
truncation_audit() {
  local step_id="$1" files_modified="$2" last_checkpoint="$3"
  : "${WORKFLOW:?WORKFLOW must be set before calling truncation_audit}"
  local now
  now="$(_now_utc)"
  browzer workflow patch --await --workflow "$WORKFLOW" --jq \
    --arg id "$step_id" \
    --arg now "$now" \
    --arg checkpoint "$last_checkpoint" \
    --argjson files "$files_modified" \
    '(.steps[] | select(.stepId == $id)) |= (
        .warnings = ((.warnings // []) + [{
          at: $now,
          kind: "truncation-suspected",
          filesModified: $files,
          lastCheckpoint: $checkpoint,
          remediation: "re-dispatch with subagent-preamble §4.5 emphasis"
        }])
      )'
}

# verify_acceptance STEP_ID AC_ID TOOL OUTCOME EVIDENCE
#   Record a live-verify probe attempt against an acceptance-criterion.
#   feature-acceptance §1.5 calls this BEFORE the §2.6 manual-AC regex
#   defer; the entry lets retros see whether autonomous-mode tried to
#   live-verify before falling back to operator action.
#
#   OUTCOME ∈ {verified, failed, inconclusive}. Defer to operator action
#   ONLY when outcome != "verified".
verify_acceptance() {
  local step_id="$1" ac_id="$2" tool="$3" outcome="$4" evidence="$5"
  : "${WORKFLOW:?WORKFLOW must be set before calling verify_acceptance}"
  local now
  now="$(_now_utc)"
  browzer workflow patch --await --workflow "$WORKFLOW" --jq \
    --arg id "$step_id" \
    --arg ac "$ac_id" \
    --arg tool "$tool" \
    --arg outcome "$outcome" \
    --arg evidence "$evidence" \
    --arg now "$now" \
    '(.steps[] | select(.stepId == $id) | .featureAcceptance.acceptanceCriteria[]
      | select(.id == $ac)) |= (
        .liveVerificationAttempt = {
          tool: $tool,
          outcome: $outcome,
          evidence: $evidence,
          at: $now
        }
      )'
}
