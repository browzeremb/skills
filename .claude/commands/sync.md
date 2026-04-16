---
name: browzer:sync
description: Re-index code structure AND re-sync already-indexed documents in one call via `browzer workspace sync`. Ideal for post-merge CI hooks or after a pull/rebase.
argument-hint: "[--dry-run] [--skip-code] [--skip-docs] [--force]"
---

Invoke the Browzer `sync` skill:

```
Skill({ skill: "sync" })
```

If the skill is not found via the `Skill` tool, fall back to reading it directly:
```bash
printf '%s\n' "$CLAUDE_PLUGIN_ROOT/skills/sync/SKILL.md"
```
Then `Read` the path from the output above and follow the skill's instructions exactly. Pass any flags provided as arguments to the CLI call.
