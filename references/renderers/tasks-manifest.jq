.steps[]
| select(.stepId == $stepId)
| "# Tasks Manifest\n\nStatus: " + .status +
  "\nTotal tasks: " + (.tasksManifest.totalTasks | tostring) +
  "\n\n## Order\n" + ((.tasksManifest.tasksOrder // []) | map("1. " + .) | join("\n")) +
  "\n\n## Dependency graph\n" +
  ((.tasksManifest.dependencyGraph // {}) | to_entries | map("- **" + .key + "** depends on: " + (if (.value | length) == 0 then "none" else (.value | join(", ")) end)) | join("\n")) +
  "\n\n## Parallelizable batches\n" +
  ((.tasksManifest.parallelizable // []) | map("- [" + (. | join(", ")) + "]") | join("\n"))
