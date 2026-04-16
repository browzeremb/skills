---
name: browzer:commit
description: Craft, review, and validate a git commit message following Conventional Commits v1.0.0 + the repo's house style. Step 4 of the prd → task → execute → commit → sync workflow.
---

Invoke the Browzer `commit` skill:

```
Skill({ skill: "commit" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/commit/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly.
