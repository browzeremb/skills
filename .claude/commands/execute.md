---
name: browzer:execute
description: Step 3 of dev workflow (prd → task → execute → commit → sync). Implements a single task from the task list end-to-end: grounds with browzer context, delegates to specialist subagents, enforces invariants, runs quality gates.
argument-hint: "[TASK_N | task-number | free-form task description]"
---

Invoke the Browzer `execute` skill:

```
Skill({ skill: "browzer:execute" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/browzer-marketplace}/skills/execute/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. The task identifier or description provided as an argument is the target to implement.
