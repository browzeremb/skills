---
name: bad-skill-fixture
description: Self-test fixture for Rule 10 — mutates path that does not exist in schema
allowed-tools: Bash(browzer workflow *)
mutates:
  - path: steps[].nonexistent.payload
    requires: [thisFieldDoesNotExist]
---
# bad-skill-fixture

This is a fixture file used by validate-frontmatter.mjs --self-test-rule-10.
