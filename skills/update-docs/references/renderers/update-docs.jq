.steps[]
| select(.stepId == $stepId)
| "# Update Docs\n\nStatus: " + .status +
  "\nBudget used: " + ((.updateDocs.budgetUsed // 0) | tostring) + " / " + ((.updateDocs.budgetMax // 1) | tostring) +
  "\nTwo-pass run: directRef=" + ((.updateDocs.twoPassRun.directRef // false) | tostring) + " conceptLevel=" + ((.updateDocs.twoPassRun.conceptLevel // false) | tostring) +
  "\n\n## Docs mentioning changed files\n" +
  ((.updateDocs.docsMentioning // []) | map("- `" + .sourceFile + "`\n" + ((.mentionedBy // []) | map("  - `" + .doc + "` (confidence " + (.confidence|tostring) + ")") | join("\n"))) | join("\n")) +
  "\n\n## Patches\n" +
  ((.updateDocs.patches // []) | map("- `" + .doc + "` — " + .reason + " (+/-" + (.linesChanged|tostring) + ") → " + .verdict) | join("\n"))
