---
name: browzer:search
description: Search the markdown documentation corpus of a Browzer workspace by meaning — READMEs, ADRs, runbooks, specs, and any third-party library docs ingested into the workspace.
argument-hint: "<search query>"
---

Invoke the Browzer `semantic-search` skill:

```
Skill({ skill: "semantic-search" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/semantic-search/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. Use the provided query as the search target.
