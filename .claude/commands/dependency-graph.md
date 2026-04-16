---
name: browzer:dependency-graph
description: Show what a file imports and what imports it — blast radius analysis before refactoring. Wraps `browzer deps`.
argument-hint: "<file-path>"
---

Invoke the Browzer `dependency-graph` skill:

```
Skill({ skill: "dependency-graph" })
```

Then follow the skill's instructions exactly. If a file path was provided as an argument, pass it to the skill as the target.
