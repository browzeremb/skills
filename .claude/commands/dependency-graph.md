---
name: browzer:dependency-graph
description: Show what a file imports and what imports it — blast radius analysis before refactoring. Wraps `browzer deps`.
argument-hint: "<file-path>"
---

Invoke the Browzer `dependency-graph` skill:

```
Skill({ skill: "browzer:dependency-graph" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/browzer-marketplace}/skills/dependency-graph/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. If a file path was provided as an argument, pass it to the skill as the target.
