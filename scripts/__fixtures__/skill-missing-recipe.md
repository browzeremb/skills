---
name: skill-missing-recipe
description: Self-test fixture for Rule 12 — declares a Persist phase but the body lacks both the canonical mutator recipe AND a banned-diagnostics subsection.
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *)
---

# skill-missing-recipe

This is a fixture file used by validate-frontmatter.mjs --self-test (alias of --self-test-rule-12). It deliberately omits BOTH required signals on purpose so Rule 12 must reject it.

## Phase 1 — Persist STEP_FAKE to workflow.json

We say we persist, but we do not show how. An LLM walking this skill would have to guess the actual call.

We also forget to warn the operator against running diagnostic-only verbs mid-orchestration, so the operator wastes turns on schema introspection.

Both required signals are missing — Rule 12 must reject this skill.
