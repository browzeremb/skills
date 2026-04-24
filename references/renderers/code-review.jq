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
  "\n\n## Mutation testing\n" +
  "- Tool: " + (.codeReview.mutationTesting.tool // "—") +
  "\n- Score: " + ((.codeReview.mutationTesting.score // 0) | tostring) + " / target " + ((.codeReview.mutationTesting.target // 0) | tostring) +
  "\n- Tests to update: " + (((.codeReview.mutationTesting.testsToUpdate // []) | length) | tostring) +
  "\n\n## Findings\n" +
  ((.codeReview.findings // []) | map("- **" + .id + "** [" + .severity + "/" + .category + "] `" + .file + ":" + (.line|tostring) + "` (" + .domain + ") — " + .description + "\n  → fix: " + .suggestedFix + "\n  → assigned: " + .assignedSkill + "\n  → status: " + .status) | join("\n\n"))
