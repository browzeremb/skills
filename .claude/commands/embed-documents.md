---
name: browzer:embed-documents
description: Add, remove, replace, or audit the markdown/PDF/text documents indexed in a Browzer workspace. The only way to ingest documentation into Browzer.
argument-hint: "[add|remove|replace|audit] [<path-or-glob>]"
---

Invoke the Browzer `embed-documents` skill:

```
Skill({ skill: "embed-documents" })
```

Then follow the skill's instructions exactly. Use any arguments provided (add/remove/replace/audit + path) to determine the operation mode.
