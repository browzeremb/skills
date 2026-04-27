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
