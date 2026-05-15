# Canonical README H2 closed-set

Single source of truth for the H2 headings every feat-root README.md emits. Both the README-writing skill (`finalize-feature`) and the README-auditing skill (`judge-skill-runs`) Read this file at runtime; their inline lists are replaced by one-line pointers to here.

## Canonical H2 closed-set (ordered)

Consumers MUST emit headings in the order listed. `always-emit` values: **yes** = unconditional, **conditional** = emit only when the corresponding data section is non-empty, **optional** = emit only when explicitly relevant.

| H2 heading | always-emit | rationale |
|---|---|---|
| Summary | yes | Narrative overview; required in every README |
| Original request | yes | Verbatim operator ask; required for traceability |
| Acceptance | yes | Gate verdict; required in every README |
| Tasks completed | yes | Always ≥ 1 task runs per feature |
| Code review | yes | Always runs; may note "no findings" |
| Fixes applied | conditional | Omit when CODE_REVIEW produced zero findings |
| Tests added | conditional | Omit when write-tests produced no new test files |
| Docs patched | conditional | Omit when update-docs found no stale docs |
| Tech debt | conditional | Omit when receiving-code-review produced zero tech-debt entries |
| Known issues | optional | Emit only when there are acknowledged defects left open |
| Deploy notes | optional | Emit only when infra/migration steps are required |
| Blast radius (top reverse dependencies) | conditional | Omit when no reverse-dep entries exist in the blast-radius probe |
| Blast-radius receipts | conditional | Omit when no `/tmp/rdeps-*.json` receipts were produced |
| Deferred actions / follow-ups | conditional | Omit when there are no deferred items |
| Phase summary | optional | Emit only for multi-phase orchestrator runs |
| Tasks | conditional | Omit when task list is captured in "Tasks completed" already |
| What was NOT verified | conditional | Omit when acceptance ran all checks successfully |
