---
name: browzer:jobs
description: Inspect, poll, and troubleshoot async ingestion jobs for a Browzer workspace. Use after `sync --no-wait` to track a batch or when jobs are blocking re-parse.
argument-hint: "[<batchId>]"
---

Invoke the Browzer `ingestion-jobs` skill:

```
Skill({ skill: "ingestion-jobs" })
```

Then follow the skill's instructions exactly. If a batchId was provided as an argument, use it as the target job to poll.
