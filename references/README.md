# `packages/skills/references/` — global cross-skill references

This directory holds **only** markdown reference docs that are loaded by **two
or more skills**. Single-skill content lives INSIDE the consuming skill's
folder (`packages/skills/skills/<skill>/references/<file>.md`) per Anthropic's
Agent Skills spec — a skill installed standalone (without the rest of the
plugin) must work without reaching outside its own folder.

> **CLI v3.0.0 / skills v5.0.0 refactor (2026-05-07)**: the `sync-shared-refs.mjs`
> mirror flow was retired. The previous global references that were heavily
> mirrored (`workflow-schema.md`, `pipeline-phases.md`, plus their per-skill
> copies) are gone — phase contracts are now inlined in each skill body,
> and skills read phase artefacts directly via `Read` on
> `docs/browzer/<feat>/staging/*.md`. Pipeline-phase guidance was inlined
> where it belongs (the orchestrator and the per-phase skills). Surviving
> globals are referenced in place; no mirroring step is required when
> editing them.

## Contents

| Filename                          | Loaded by                                                                                                                              | Summary                                                                                                                                                                                       | Why global (≥2 skills)                                                                       |
|-----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `subagent-preamble.md`            | `code-review`, `execute-task`, `finalize-feature`, `generate-task`, `orchestrate-task-delivery`, `receiving-code-review`, `regression-guard` (7) | Universal subagent preamble — blast-radius probe (`browzer deps --reverse`), library lookup order, `startedAt` stamping, `mktemp` hygiene, bash/zsh portability rules, skill invocation rules. | Pasted verbatim into every `Agent(...)` / `Task(...)` dispatch prompt across all dispatchers. |
| `preambles/code-subagent.md`      | same 7 as `subagent-preamble.md`                                                                                                       | Role-specific preamble for implementation subagents (execute-task, receiving-code-review).                                                                                                    | Referenced by the universal preamble.                                                          |
| `preambles/review-subagent.md`    | same 7                                                                                                                                 | Role-specific preamble for `code-review` reviewer dispatches.                                                                                                                                 | Same.                                                                                          |
| `preambles/truncation-recovery.md`| same 7                                                                                                                                 | Role-specific preamble for high-risk dispatches that may hit subagent output-budget exhaustion.                                                                                               | Same.                                                                                          |
| `scripts/detect-quality-gate.mjs` | `execute-task`, `regression-guard` (2)                                                                                                  | Host-quality-gate command resolver — returns `{runner, lint, typecheck, test, build?}` arrays. Invoked from the two skills that run the host gate.                                            | Both skills run the host gate; central script avoids per-skill copies of the detector.        |

## Single-skill references (NOT in this directory)

Per the Agent Skills spec, these live INSIDE the consuming skill's folder:

| File                                                                | Loaded by                  | Why per-skill                                                                       |
|---------------------------------------------------------------------|----------------------------|-------------------------------------------------------------------------------------|
| `skills/orchestrate-task-delivery/references/mode-contract.md`      | `orchestrate-task-delivery` | autonomous-vs-review loop contract is orchestrator-only.                            |
| `skills/orchestrate-task-delivery/references/agent-dispatch-contract.md` | `orchestrate-task-delivery` | dispatch primitive selection is orchestrator-only.                                  |
| `skills/orchestrate-task-delivery/references/operator-discipline.md` | `orchestrate-task-delivery` | operator self-audit rules — orchestrator-only.                                      |
| `skills/orchestrate-task-delivery/references/dispatch-warmup.md`    | `orchestrate-task-delivery` | warm-up snippet for first dispatch — orchestrator-only.                             |
| `skills/code-review/references/dispatch-modes.md`                   | `code-review`              | reviewer dispatch primitive selection — code-review-only.                           |
| `skills/execute-task/references/dispatch-pattern.md`                | `execute-task`             | per-task fan-out pattern — execute-task-only.                                       |
| `skills/execute-task/references/parallel-dispatch.md`               | `execute-task`             | parallel-task heuristics — execute-task-only.                                       |
| `skills/generate-task/references/explorer-pass.md`                  | `generate-task`            | first decomposer pass contract — generate-task-only.                                |
| `skills/generate-task/references/reviewer-pass.md`                  | `generate-task`            | second decomposer pass contract — generate-task-only.                               |
| `skills/receiving-code-review/references/iteration-ladder.md`       | `receiving-code-review`    | model-escalation ladder for fix dispatches — receiving-code-review-only.            |

## Editing rules

- **Globals**: edit in place; no mirror sync step is required (the
  `sync-shared-refs.mjs` flow was removed in the v3.0.0 refactor).
- **Adding a new global**: only when ≥2 skills will load it. Document it in
  the table above and confirm the consuming skills reference the canonical
  path (`${CLAUDE_PLUGIN_ROOT}/references/<file>.md`) rather than mirroring.
- **Demoting a global to per-skill**: when only one skill ends up loading a
  file, `git mv` the canonical into that skill's `references/` and update
  the per-skill table above.
