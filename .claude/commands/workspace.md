---
name: browzer:workspace
description: List, inspect, delete, unlink, and relink Browzer workspaces in the organization. Use to audit workspaces, recover from orphan state, free plan slots, or repoint config.
argument-hint: "[list|get|delete|unlink|relink] [<workspace-id>]"
---

Invoke the Browzer `workspace-management` skill:

```
Skill({ skill: "workspace-management" })
```

Then follow the skill's instructions exactly. Use any arguments provided (list/get/delete/unlink/relink + workspace-id) to determine the operation.
