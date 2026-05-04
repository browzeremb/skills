---
name: bad-bash-skill
description: Self-test fixture for Rule 11 — three Bash hygiene violations
allowed-tools: Bash(echo *), Bash(jq *)
---
# bad-bash-skill

## Violation (a) — inline comment

```bash
echo "first" # this is an inline comment
```

## Violation (b) — multi-step

```bash
foo && bar && baz
```

## Violation (c) — jq capture pattern

```bash
STEPS=$(jq -r '.steps[]' "$WORKFLOW")
echo "$STEPS" | jq '.taskId'
```
