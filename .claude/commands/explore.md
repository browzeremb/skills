---
name: browzer:explore
description: Search the codebase by intent using hybrid vector + Graph RAG. Returns ranked file entries with paths, symbols, exports, imports, and relevance scores. Use before Grep/Read on a large monorepo.
argument-hint: "<search query>"
---

Invoke the Browzer `explore-workspace-graphs` skill:

```
Skill({ skill: "explore-workspace-graphs" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/explore-workspace-graphs/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. Use the provided query as the search target.
