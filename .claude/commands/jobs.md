---
name: browzer:jobs
description: Inspect, poll, and troubleshoot async ingestion jobs for a Browzer workspace. Use after `sync --no-wait` to track a batch or when jobs are blocking re-parse.
argument-hint: "[<batchId>]"
---

Invoke the Browzer `ingestion-jobs` skill:

```
Skill({ skill: "ingestion-jobs" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/ingestion-jobs/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. If a batchId was provided as an argument, use it as the target job to poll.
