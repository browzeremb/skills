---
name: browzer:embed-documents
description: Add, remove, replace, or audit the markdown/PDF/text documents indexed in a Browzer workspace. The only way to ingest documentation into Browzer.
argument-hint: "[add|remove|replace|audit] [<path-or-glob>]"
---

Invoke the Browzer `embed-documents` skill:

```
Skill({ skill: "embed-documents" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/embed-documents/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. Use any arguments provided (add/remove/replace/audit + path) to determine the operation mode.
