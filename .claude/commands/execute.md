---
name: browzer:execute
description: Step 3 of dev workflow (prd → task → execute → commit → sync). Implements a single task from the task list end-to-end: grounds with browzer context, delegates to specialist subagents, enforces invariants, runs quality gates.
argument-hint: "[TASK_N | task-number | free-form task description]"
---

Invoke the Browzer `execute` skill:

```
Skill({ skill: "execute" })
```

Then follow the skill's instructions exactly. The task identifier or description provided as an argument is the target to implement.
