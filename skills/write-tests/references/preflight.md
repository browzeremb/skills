# preflight.md — Phase 1.0 infra preflight + mutation operator taxonomy

Reference for `write-tests` Phases 1.0 and 4. Phase 1.0 runs BEFORE the
existing `detect-test-setup.mjs` probe. Phase 4 content is the full mutation
operator checklist extracted from the inline skill table.

---

## Phase 1.0 — Infra preflight (BEFORE detect-test-setup.mjs)

Run once at skill entry. Record every probe result under
`writeTests.infraProbe[]` in the step payload.

### Probe sequence

```bash
# 1. Test-env scripts available
jq -r '.scripts | to_entries[] | select(.key | test("test:env|test:integration|test:e2e")) | "\(.key): \(.value)"' \
  package.json 2>/dev/null || true

# 2. Wake test env if needed (only when test:env:wake exists)
HAS_WAKE=$(jq -r '.scripts["test:env:wake"] // empty' package.json 2>/dev/null)
if [ -n "$HAS_WAKE" ]; then
  # Check last wake — skip if woken within 30min
  LAST_WAKE_FILE=".tmp/test-env-last-wake"
  NOW_EPOCH=$(date +%s)
  if [ -f "$LAST_WAKE_FILE" ]; then
    LAST=$(cat "$LAST_WAKE_FILE")
    AGE=$(( NOW_EPOCH - LAST ))
  else
    AGE=99999
  fi
  if [ "$AGE" -gt 1800 ]; then
    echo "infra-preflight: waking test env (last wake ${AGE}s ago)"
    pnpm test:env:wake && mkdir -p .tmp && echo "$NOW_EPOCH" > "$LAST_WAKE_FILE"
  else
    echo "infra-preflight: test env recently woken (${AGE}s ago), skipping wake"
  fi
fi

# 3. Playwright chromium check (only when a Playwright spec is in scope)
if echo "$TARGET_FILES" | grep -qE '\.spec\.(ts|js)|playwright'; then
  pnpm exec playwright --version 2>/dev/null || \
    echo "infra-preflight: playwright not installed"
  # Check chromium specifically
  pnpm exec playwright install --dry-run chromium 2>&1 | grep -i "chromium" || true
fi

# 4. Docker fixture status (for integration tests using Docker)
if command -v docker &>/dev/null; then
  docker ps --filter "name=browzer-" --format "{{.Names}}: {{.Status}}" 2>/dev/null || true
fi
```

### Record probe results

Append to `writeTests.infraProbe[]` for each check attempted:

```jsonc
{ "tool": "pnpm test:env:wake",
  "attempted": true,
  "outcome": "ok|skipped|failed",
  "duration": 12,
  "note": "env woken after 45min idle" }
```

### Deferral rule

Emitting "no infra detected" and stopping is valid ONLY AFTER this probe
returns no usable test environment. If the probe finds `test:env:wake` or
Docker fixtures, the skill MUST attempt them before deferring.

---

## Phase 4 — Mutation operator taxonomy

For each test case authored in Phase 3, run it mentally through this checklist
before writing. A test that passes under all rows is a useless test.

### Operator checklist

| Mutation | Test must catch? | Typical shape |
| --- | --- | --- |
| `<` → `<=`, `>` → `>=` (boundary) | yes | Assert at the exact boundary AND one past it. |
| `&&` → `\|\|`, `\|\|` → `&&` (logical) | yes | At least one test per branch of compound conditions. |
| `true` → `false` (literal) | yes | Don't stub with a dummy `true`; pass real inputs. |
| `+` → `-`, `*` → `/` (arithmetic) | yes | Assert exact numeric outcome, not truthiness. |
| `return x` → `return` | yes | Assert on the return value, never on the call itself. |
| `if (x)` → `if (true)` | yes | At least one test must take the FALSE branch. |
| Loop off-by-one | yes | Test with length 0, 1, N, and N+1 inputs. |
| Early-return removed | yes | Test that side effects DON'T happen when they shouldn't. |
| String literal replaced | yes | Assert on exact strings where semantic (error messages, type tags). |

### Anti-patterns (do NOT commit these)

- **Testing mock behaviour** — you're testing the mock, not the code.
- **Production `destroy()` / `__reset()` / `setMock*()` methods** — put cleanup in a test util.
- **Partial mocks** — if you mock, mirror the real API; don't omit fields the code-under-test consumes.
- **Over-mocking** — mocking the thing whose side effects the test depends on.
- **Tests without assertions** — a test that never calls `expect` is noise.
- **Tautological tests** — compute expected values independently; don't re-derive them from the same expression under test.

Full reasoning + examples in `references/mutation-principles.md`.
