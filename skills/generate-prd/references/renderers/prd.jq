# Renders a PRD step as review-ready markdown.
.steps[]
| select(.stepId == $stepId)
| "# PRD — " + (.prd.title // "—") +
  "\n\nStatus: " + .status +
  "\n\n## Overview\n" + (.prd.overview // "—") +
  "\n\n## Personas\n" + ((.prd.personas // []) | map("- **" + .id + "**: " + .description) | join("\n")) +
  "\n\n## Objectives\n" + ((.prd.objectives // []) | map("- " + .) | join("\n")) +
  "\n\n## Functional requirements\n" + ((.prd.functionalRequirements // []) | map("- **" + .id + "** (" + (.priority // "must") + "): " + .description) | join("\n")) +
  "\n\n## Non-functional requirements\n" + ((.prd.nonFunctionalRequirements // []) | map("- **" + .id + "** [" + .category + "]: " + .description + (if .target then " — target: " + .target else "" end)) | join("\n")) +
  "\n\n## Success metrics\n" + ((.prd.successMetrics // []) | map("- **" + .id + "**: " + .metric + " → target " + .target + " (method: " + .method + ")") | join("\n")) +
  "\n\n## Acceptance criteria\n" + ((.prd.acceptanceCriteria // []) | map("- **" + .id + "**: " + .description + " (binds: " + ((.bindsTo // []) | join(", ")) + ")") | join("\n")) +
  "\n\n## Assumptions\n" + ((.prd.assumptions // []) | map("- " + .) | join("\n")) +
  "\n\n## Risks\n" + ((.prd.risks // []) | map("- **" + .id + "**: " + .description + " — mitigation: " + .mitigation) | join("\n")) +
  "\n\n## Deliverables\n" + ((.prd.deliverables // []) | map("- " + .) | join("\n")) +
  "\n\n## In scope\n" + ((.prd.inScope // []) | map("- " + .) | join("\n")) +
  "\n\n## Out of scope\n" + ((.prd.outOfScope // []) | map("- " + .) | join("\n")) +
  "\n\n## Task granularity\n" + (.prd.taskGranularity // "one-task-one-commit")
