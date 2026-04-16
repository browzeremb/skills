---
name: browzer:task
description: Step 2 of dev workflow (prd → task → execute → commit → sync). Decomposes a PRD into an ordered list of mergeable, PR-sized engineering tasks directly executable by the execute skill.
---

Invoke the Browzer `task` skill:

```
Skill({ skill: "task" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/task/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. The PRD should already be in conversation context (from `/prd` or pasted directly).
