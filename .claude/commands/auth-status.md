---
name: browzer:auth-status
description: Check Browzer authentication status and active workspace context — the cheapest pre-flight call before any explore/search/sync operation.
---

Invoke the Browzer `auth-status` skill:

```
Skill({ skill: "auth-status" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/auth-status/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly.
