---
name: browzer:use-rag-cli
description: Install, authenticate, and operate the browzer CLI. Use when setting up Browzer for the first time, logging in, or recovering from authentication errors.
---

Invoke the Browzer `use-rag-cli` skill:

```
Skill({ skill: "use-rag-cli" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/use-rag-cli/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly.
