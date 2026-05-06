# renderer-coverage-exclude: prePushAuditsRun, pushAttempts, prePushAudits
# Renders a COMMIT step as review-ready markdown.
#
# Excluded fields:
#   prePushAuditsRun, prePushAudits — pre-push gate provenance lives in
#                                     the gate audit log; not duplicated here.
#   pushAttempts                    — push retry timeline; surfaced via
#                                     `git log` + commit.sha, not the
#                                     review-mode markdown.
.steps[]
| select(.stepId == $stepId)
| "# Commit\n\nStatus: " + .status +
  "\nSHA: " + (.commit.sha // "—") +
  "\nType: " + (.commit.conventionalType // "—") +
  "\nScope: " + (.commit.scope // "—") +
  "\n\n## Subject\n" + (.commit.subject // "—") +
  "\n\n## Body\n" + (.commit.body // "—") +
  "\n\n## Trailers\n" + ((.commit.trailers // []) | map("- " + .) | join("\n"))
