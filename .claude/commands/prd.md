---
name: browzer:prd
description: Step 1 of dev workflow (prd → task → execute → commit → sync). Produces a structured Product Requirements Document grounded in the actual repo surface via browzer explore/search.
argument-hint: "<feature idea | bug report | business requirement>"
---

Invoke the Browzer `prd` skill:

```
Skill({ skill: "prd" })
```

Then follow the skill's instructions exactly. The argument provided is the feature/bug/requirement to document.
