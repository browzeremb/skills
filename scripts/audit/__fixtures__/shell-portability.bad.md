# Bad fixture for skill-shell-portability.mjs --self-test

This file MUST contain at least one violation per RULES entry in
`packages/skills/scripts/audit/skill-shell-portability.mjs`. The audit's
self-test verifies coverage by counting distinct rule names triggered.

## Idiom #1 — declare -A (bash 4+ only; fails in macOS bash 3.2)

```bash
declare -A FIX_MAP
FIX_MAP[F-1]="fixed:..."
FIX_MAP[F-2]="deferred:..."
echo "${FIX_MAP[F-1]}"
```

## Idiom #2 — array numeric indexing (bash 0-based, zsh 1-based silently differ)

```bash
ARR=(alpha beta gamma)
FIRST=${ARR[0]}
echo "$FIRST"
```

## Idiom #3 — bare <<EOF heredoc (binding semantics differ in zsh-default macOS)

```bash
cat <<EOF
this heredoc is unwrapped, so $VAR expansion can diverge between bash and zsh
EOF
```

## Idiom #4 — unquoted *.config* glob (zsh aborts on no-match without nullglob)

```bash
cp web.config* /tmp/
```
