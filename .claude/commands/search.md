---
name: browzer:search
description: Search the markdown documentation corpus of a Browzer workspace by meaning — READMEs, ADRs, runbooks, specs, and any third-party library docs ingested into the workspace.
argument-hint: "<search query>"
---

Invoke the Browzer `semantic-search` skill:

```
Skill({ skill: "semantic-search" })
```

Then follow the skill's instructions exactly. Use the provided query as the search target.
