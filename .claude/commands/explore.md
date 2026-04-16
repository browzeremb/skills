---
name: browzer:explore
description: Search the codebase by intent using hybrid vector + Graph RAG. Returns ranked file entries with paths, symbols, exports, imports, and relevance scores. Use before Grep/Read on a large monorepo.
argument-hint: "<search query>"
---

Invoke the Browzer `explore-workspace-graphs` skill:

```
Skill({ skill: "explore-workspace-graphs" })
```

Then follow the skill's instructions exactly. Use the provided query as the search target.
