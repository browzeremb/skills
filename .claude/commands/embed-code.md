---
name: browzer:embed-code
description: Index a codebase's structure (folders, files, symbols) into Browzer's workspace graph via `browzer init` + `browzer workspace index`. Use when onboarding a new repo or after large refactors.
---

Invoke the Browzer `embed-workspace-graphs` skill:

```
Skill({ skill: "embed-workspace-graphs" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/embed-workspace-graphs/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly.
