.steps[]
| select(.stepId == $stepId)
| "# Brainstorm — " + (.name // "BRAINSTORMING") +
  "\n\nStatus: " + .status +
  "\nQuestions asked: " + (.brainstorm.questionsAsked // 0 | tostring) +
  "\nResearch round run: " + (.brainstorm.researchRoundRun | tostring) +
  "\n\n## Convergent working model\n" +
  "\n- Primary user: " + (.brainstorm.dimensions.primaryUser // "—") +
  "\n- Job-to-be-done: " + (.brainstorm.dimensions.jobToBeDone // "—") +
  "\n- Success signal: " + (.brainstorm.dimensions.successSignal // "—") +
  "\n\n### In scope\n" + ((.brainstorm.dimensions.inScope // []) | map("- " + .) | join("\n")) +
  "\n\n### Out of scope\n" + ((.brainstorm.dimensions.outOfScope // []) | map("- " + .) | join("\n")) +
  "\n\n### Repo surface\n" + ((.brainstorm.dimensions.repoSurface // []) | map("- `" + . + "`") | join("\n")) +
  "\n\n### Tech constraints\n" + ((.brainstorm.dimensions.techConstraints // []) | map("- " + .) | join("\n")) +
  "\n\n### Failure modes\n" + ((.brainstorm.dimensions.failureModes // []) | map("- " + .) | join("\n")) +
  "\n\n### Acceptance criteria\n" + ((.brainstorm.dimensions.acceptanceCriteria // []) | map("- " + .) | join("\n")) +
  "\n\n### Dependencies\n" + ((.brainstorm.dimensions.dependencies // []) | map("- " + .) | join("\n")) +
  "\n\n### Open questions\n" + ((.brainstorm.dimensions.openQuestions // []) | map("- " + .) | join("\n")) +
  "\n\n## Assumptions\n" + ((.brainstorm.assumptions // []) | map("- " + .) | join("\n")) +
  "\n\n## Open risks\n" + ((.brainstorm.openRisks // []) | map("- " + .) | join("\n"))
