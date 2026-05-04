# renderer-coverage-exclude: researchAgents, researchFindings
# Renders a BRAINSTORMING step as review-ready markdown.
#
# Excluded fields:
#   researchAgents    — book-keeping count surfaced at the manifest layer.
#   researchFindings  — verbose research notes, intentionally not echoed
#                       in the human review surface (operator can grep
#                       workflow.json directly for the full list).
.steps[]
| select(.stepId == $stepId)
| "# Brainstorm — " + (.name // "BRAINSTORMING") +
  "\n\nStatus: " + .status +
  "\nQuestions asked: " + (.brainstorming.questionsAsked // 0 | tostring) +
  "\nResearch round run: " + (.brainstorming.researchRoundRun | tostring) +
  "\n\n## Convergent working model\n" +
  "\n- Primary user: " + (.brainstorming.dimensions.primaryUser // "—") +
  "\n- Job-to-be-done: " + (.brainstorming.dimensions.jobToBeDone // "—") +
  "\n- Success signal: " + (.brainstorming.dimensions.successSignal // "—") +
  "\n\n### In scope\n" + ((.brainstorming.dimensions.inScope // []) | map("- " + .) | join("\n")) +
  "\n\n### Out of scope\n" + ((.brainstorming.dimensions.outOfScope // []) | map("- " + .) | join("\n")) +
  "\n\n### Repo surface\n" + ((.brainstorming.dimensions.repoSurface // []) | map("- `" + . + "`") | join("\n")) +
  "\n\n### Tech constraints\n" + ((.brainstorming.dimensions.techConstraints // []) | map("- " + .) | join("\n")) +
  "\n\n### Failure modes\n" + ((.brainstorming.dimensions.failureModes // []) | map("- " + .) | join("\n")) +
  "\n\n### Acceptance criteria\n" + ((.brainstorming.dimensions.acceptanceCriteria // []) | map("- " + .) | join("\n")) +
  "\n\n### Dependencies\n" + ((.brainstorming.dimensions.dependencies // []) | map("- " + .) | join("\n")) +
  "\n\n### Open questions\n" + ((.brainstorming.dimensions.openQuestions // []) | map("- " + .) | join("\n")) +
  "\n\n## Assumptions\n" + ((.brainstorming.assumptions // []) | map("- " + .) | join("\n")) +
  "\n\n## Open risks\n" + ((.brainstorming.openRisks // []) | map("- " + .) | join("\n"))
