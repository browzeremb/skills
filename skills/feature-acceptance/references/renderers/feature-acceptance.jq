# renderer-coverage-exclude: modeNote, acRelaxations, executionRequiredProbe, liveVerificationAttempt
# Renders a FEATURE_ACCEPTANCE step as review-ready markdown.
#
# Excluded fields:
#   modeNote                — operator-facing free-form note; rendered
#                             when the skill dispatches a manual-mode
#                             prompt, not in the summary surface.
#   acRelaxations           — operator-recorded AC tweaks; reviewed
#                             in-line during the manual-mode dialogue,
#                             not echoed in the summary.
#   executionRequiredProbe  — boolean signal routing the skill's
#                             execution-required AC gate; the AC list
#                             already implies it for the operator.
#   liveVerificationAttempt — boolean signal that Phase 1.5 ran a live
#                             verification probe; the result is
#                             surfaced via nfrVerifications when relevant.
.steps[]
| select(.stepId == $stepId)
| "# Feature Acceptance\n\nStatus: " + .status +
  "\nMode: " + (.featureAcceptance.mode // "—") +
  "\n\n## Acceptance criteria\n" +
  ((.featureAcceptance.acceptanceCriteria // []) | map("- **" + .id + "** [" + .status + "] (" + .method + "): " + .evidence) | join("\n")) +
  "\n\n## NFR verifications\n" +
  ((.featureAcceptance.nfrVerifications // []) | map("- **" + .id + "** [" + .status + "] measured=" + (.measured // "—") + " target=" + (.target // "—") + " → " + .evidence) | join("\n")) +
  "\n\n## Success metrics\n" +
  ((.featureAcceptance.successMetrics // []) | map("- **" + .id + "** measured=" + (.measured|tostring) + " target=" + (.target|tostring) + " → " + .status) | join("\n")) +
  "\n\n## Operator actions requested\n" +
  ((.featureAcceptance.operatorActionsRequested // []) | map("- [" + (if .resolved then "x" else " " end) + "] " + .description + (if .resolved then " → " + (.resolution // "") else "" end)) | join("\n"))
