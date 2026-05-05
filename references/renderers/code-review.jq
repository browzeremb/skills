# renderer-coverage-exclude: duplicationFindings, regressionRun, preRegistered
# Renders a CODE_REVIEW step as review-ready markdown.
#
# Excluded fields:
#   duplicationFindings — populated only when the duplication-detector
#                         specialist runs; rendered in-line with `findings`
#                         when present, intentionally omitted from the
#                         summary header.
#   regressionRun       — captured for trace correlation, not rendered as
#                         human-facing markdown.
#
# Note: mutation-testing data lives on the WRITE_TESTS step payload, not
# CODE_REVIEW — see write-tests rendering (TBD) when that skill ships.
.steps[]
| select(.stepId == $stepId)
| "# Code Review\n\nStatus: " + .status +
  "\nDispatch mode: " + (.codeReview.dispatchMode // "—") +
  "\nTier: " + (.codeReview.reviewTier // "—") +
  "\nToken cost estimate: " + ((.codeReview.tokenCostEstimate // 0) | tostring) +
  "\n\n## Team\n" +
  "- Mandatory: " + ((.codeReview.mandatoryMembers // []) | join(", ")) +
  "\n- Recommended: " + ((.codeReview.recommendedMembers // []) | join(", ")) +
  "\n- Custom: " + ((.codeReview.customMembers // []) | join(", ")) +
  "\n\n## Cyclomatic audit\n" +
  ((.codeReview.cyclomaticAudit.files // []) | map("- `" + .file + "` max=" + (.maxComplexity|tostring) + " threshold=" + (.threshold|tostring) + " → " + .verdict) | join("\n")) +
  "\n\n## Findings\n" +
  ((.codeReview.findings // []) | map("- **" + .id + "** [" + .severity + "/" + .category + "] `" + .file + ":" + (.line|tostring) + "` (" + .domain + ") — " + .description + "\n  → fix: " + .suggestedFix + "\n  → assigned: " + .assignedSkill + "\n  → status: " + .status) | join("\n\n"))
