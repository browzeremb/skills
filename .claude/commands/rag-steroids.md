---
name: browzer:rag-steroids
description: One-shot bootstrapper that turns any repo into a fully Browzer-powered RAG workspace — initializes, indexes, generates ARCHITECTURE_BLUEPRINT.md, maps skills to the codebase, and commits everything.
---

Invoke the Browzer `give-claude-rag-steroids` skill:

```
Skill({ skill: "browzer:give-claude-rag-steroids" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/browzer-marketplace}/skills/give-claude-rag-steroids/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly.
