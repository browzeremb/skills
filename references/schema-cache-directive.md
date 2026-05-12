# Schema-cache consumption contract

> Read this file BEFORE writing any staging artifact that is persisted via `browzer save-step`.

**Required before Write** — if `.browzer/.schema-cache/<PHASE>.json` exists, Read it FIRST. Its `fields[]` and `enum[]` are authoritative and supersede any inline example. Fields not present in the cache are dropped on `save-step` (CUE-validated).

**Note**: the cache is a session-scoped snapshot from `orchestrate-task-delivery` S5. If your `browzer --version` differs from the CLI that wrote the cache, fall back to runtime `browzer workflow describe-step-type <PHASE> --required-only --json` for authoritative shape.

Also invoke `Read ${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/template.md` BEFORE composing the staging payload. The template is auto-generated from the workflow CUE schema and is the canonical scaffold. Fields not present in `template.md`'s field reference are dropped on `save-step`. Do not paste schema-claiming JSON inline into this body; reference the template instead.
