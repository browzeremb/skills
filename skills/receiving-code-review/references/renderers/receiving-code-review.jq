.steps[]
| select(.stepId == $stepId)
| "# Receiving Code Review\n\nStatus: " + .status +
  "\nIteration: " + ((.receivingCodeReview.iteration // 1) | tostring) +
  "\n\n## Summary\n" +
  "- Dispatches: " + ((.receivingCodeReview.summary.total // 0) | tostring) +
  "\n- Fixed: " + ((.receivingCodeReview.summary.fixed // 0) | tostring) +
  "\n- Unrecovered: " + ((.receivingCodeReview.summary.unrecovered // 0) | tostring) +
  "\n\n## Dispatches\n" +
  ((.receivingCodeReview.dispatches // [])
   | map("- **" + .findingId + "** iter " + (.iteration | tostring) + " (" + .reason + ") → " + .role + " · " + .skill + " · " + .model + " → " + .status)
   | join("\n")) +
  (if ((.receivingCodeReview.unrecovered // []) | length) > 0 then
    "\n\n## Unrecovered (logged to tech-debt)\n" +
    ((.receivingCodeReview.unrecovered // [])
     | map("- **" + .findingId + "** [" + .severity + "] — " + .lastTrace + " (logged: " + (.loggedToTechDebt // "—") + ")")
     | join("\n"))
  else "" end)
