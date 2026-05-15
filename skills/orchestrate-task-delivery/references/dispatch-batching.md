# Dispatch — output discipline & multi-tool-call batching

Loaded when the orchestrator wants the full prose around tool-call
batching and artefact-citation discipline. The body of `SKILL.md`
already carries the one-liner invariants; this doc explains the
reasoning.

## Multi-tool-call batching

When multiple independent tool calls can be batched (e.g. reading
several artefacts to compute COMPLEXITY), issue them in a single
response block. Inter-tool narration is ZERO — do not text between
parallel tool calls.

## Subagent output discipline (refs only)

When the dispatched skill emits its artefact, the orchestrator MUST
never re-cite the artefact's body. Refs only, by path. The
orchestrator's only output between dispatches is the trace bullet — the
artefact IS the canonical record.

Re-citing the artefact body would:

- Inflate the orchestrator's context window with content it already
  persisted to filesystem.
- Risk drift between the canonical artefact and the orchestrator's
  paraphrase.
- Waste tokens on every iteration that follows.

## Schema cache guidance

Subagents discover schema-shaped data via
`${CLAUDE_SKILL_DIR}/template.md` reads (cached per-skill); the legacy
runtime `describe-step-type --save` path is dead in the markdown-chains
era.
