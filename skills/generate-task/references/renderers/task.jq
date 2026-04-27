.steps[]
| select(.stepId == $stepId)
| "# " + .stepId + " — " + (.task.title // "—") +
  "\n\nStatus: " + .status +
  "\nTrivial: " + (.task.trivial | tostring) +
  "\nSuggested model: " + (.task.suggestedModel // "sonnet") +
  "\n\n## Scope\n" + ((.task.scope // []) | map("- " + .) | join("\n")) +
  "\n\n## Depends on\n" + ((.task.dependsOn // []) | map("- " + .) | join("\n")) +
  "\n\n## Invariants\n" + ((.task.invariants // []) | map("- **" + .rule + "** (from " + .source + ")") | join("\n")) +
  "\n\n## Acceptance criteria\n" + ((.task.acceptanceCriteria // []) | map("- **" + .id + "**: " + .description) | join("\n")) +
  "\n\n## Explorer output\n" +
  "- Files to modify: " + ((.task.explorer.filesModified // []) | map("`" + . + "`") | join(", ")) +
  "\n- Files to read: " + ((.task.explorer.filesToRead // []) | map("`" + . + "`") | join(", ")) +
  "\n- Domains: " + ((.task.explorer.domains // []) | join(", ")) +
  "\n- Skills found: " + ((.task.explorer.skillsFound // []) | map(.skill + " [" + .relevance + "]") | join(", ")) +
  "\n\n## Reviewer decisions\n" +
  "- TDD applicable: " + ((.task.reviewer.tddDecision.applicable // false) | tostring) +
  "\n- TDD reason: " + (.task.reviewer.tddDecision.reason // "—") +
  "\n- Additional context: " + (.task.reviewer.additionalContext // "—") +
  "\n\n### Test specs\n" + ((.task.reviewer.testSpecs // []) | map("- **" + .testId + "** [" + .type + "] `" + .file + "`: " + .description) | join("\n")) +
  (if .task.execution then
    "\n\n## Execution\n" +
    "- Agents: " + ((.task.execution.agents // []) | map(.role + " (" + .model + ") → " + .status) | join(", ")) +
    "\n- Files created: " + ((.task.execution.files.created // []) | map("`" + . + "`") | join(", ")) +
    "\n- Files modified: " + ((.task.execution.files.modified // []) | map("`" + . + "`") | join(", ")) +
    "\n- Baseline: " + (.task.execution.gates.baseline.tests // "—") +
    "\n- Post-change: " + (.task.execution.gates.postChange.tests // "—")
  else "" end)
