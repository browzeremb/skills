.steps[]
| select(.stepId == $stepId)
| "# Commit\n\nStatus: " + .status +
  "\nSHA: " + (.commit.sha // "—") +
  "\nType: " + (.commit.conventionalType // "—") +
  "\nScope: " + (.commit.scope // "—") +
  "\n\n## Subject\n" + (.commit.subject // "—") +
  "\n\n## Body\n" + (.commit.body // "—") +
  "\n\n## Trailers\n" + ((.commit.trailers // []) | map("- " + .) | join("\n"))
