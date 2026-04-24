.steps[]
| select(.stepId == $stepId)
| "# Fix Findings\n\nStatus: " + .status +
  "\nTotal findings: " + ((.fixFindings.totalFindings // 0) | tostring) +
  "\nFixed: " + ((.fixFindings.fixedFindings // 0) | tostring) +
  "\nSkipped: " + ((.fixFindings.skippedFindings // 0) | tostring) +
  "\n\n## Dispatches\n" +
  ((.fixFindings.dispatches // []) | map("- **" + .findingId + "** [" + .role + "] → " + .skill + " (" + .model + ") → " + .status) | join("\n")) +
  "\n\n## Quality gates\n" +
  "- Lint: " + (.fixFindings.qualityGates.lint // "—") +
  "\n- Typecheck: " + (.fixFindings.qualityGates.typecheck // "—") +
  "\n- Tests: " + (.fixFindings.qualityGates.tests // "—") +
  "\n\n## Regression tests\n" +
  "- Blast-radius files: " + (((.fixFindings.regressionTests.blastRadiusFiles // []) | length) | tostring) +
  "\n- Tests run: " + ((.fixFindings.regressionTests.testsRun // 0) | tostring) +
  "\n- Passed: " + ((.fixFindings.regressionTests.testsPassed // 0) | tostring) +
  "\n- Failed: " + ((.fixFindings.regressionTests.testsFailed // 0) | tostring) +
  "\n- Duration: " + (.fixFindings.regressionTests.duration // "—")
