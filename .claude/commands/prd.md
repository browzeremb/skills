---
name: browzer:prd
description: Step 1 of dev workflow (prd → task → execute → commit → sync). Produces a structured Product Requirements Document grounded in the actual repo surface via browzer explore/search.
argument-hint: "<feature idea | bug report | business requirement>"
---

Invoke the Browzer `prd` skill:

```
Skill({ skill: "prd" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/prd/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. The argument provided is the feature/bug/requirement to document.
