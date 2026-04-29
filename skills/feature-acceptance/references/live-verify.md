# live-verify.md — Phase 1.5 live-verify + Phase 2.6 anti-soft-override

Reference for `feature-acceptance` Phases 1.5 and 2.6. The skill sources this
content via `browzer workflow get-step` and the helpers in `references/jq-helpers.sh`.

---

## Phase 1.5 — Live-verify probe (autonomous mode, BEFORE §2.6 regex gate)

Before classifying any AC as manual-only via the §2.6 regex, probe whether
live verification is actually possible in this environment. Run the probe once
per skill invocation, not per AC.

### Infra detection

```bash
# 1. Package scripts available
jq -r '.scripts | keys[]' package.json 2>/dev/null \
  | grep -E 'dev:local|e2e:smoke|dev:docker|test:env' || true

# 2. Stack-up scripts in scripts/
ls scripts/ 2>/dev/null | grep -E 'stack-up|dev-stack' || true

# 3. MCP browser tools available
test -f ~/.claude/settings.json && \
  node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")); \
  const keys=Object.keys(s.mcpServers||{}); \
  console.log(keys.filter(k=>k.includes("chrome")||k.includes("browser")).join(","));}catch{console.log("");}' || true

# 4. agent-browser skill available (check settings)
test -f .claude/settings.json && \
  node -e 'try{const s=JSON.parse(require("fs").readFileSync(".claude/settings.json")); \
  console.log(Object.keys(s.mcpServers||{}).join(","));}catch{console.log("");}' || true

# 5. Playwright installed
pnpm exec playwright --version 2>/dev/null | head -1 || \
  npx --no playwright --version 2>/dev/null | head -1 || true
```

### Decision table

| Infra found | Mode | Action |
| --- | --- | --- |
| `e2e:smoke` or `dev:local` in scripts AND `mode == autonomous` | Live-verify via `pnpm run e2e:smoke` or target sub-command | Dispatch subagent, call `verify_acceptance` |
| MCP browser tools (`mcp__claude-in-chrome__*`) found | Live-verify via browser MCP | Dispatch subagent with browser tool, call `verify_acceptance` |
| `agent-browser` skill available | Live-verify via agent-browser | Dispatch agent, call `verify_acceptance` |
| Playwright installed AND spec file in scope | Live-verify via playwright | Run spec, call `verify_acceptance` |
| None of the above | No live-verify available | Skip to §2.6 regex gate; no `verify_acceptance` call |

### Record the probe

For each AC probed, call the `verify_acceptance` helper:

```bash
source "$BROWZER_SKILLS_REF/jq-helpers.sh"
verify_acceptance "$STEP_ID" "AC-<n>" "<tool>" "<verified|failed|inconclusive>" "<evidence>"
```

`verify_acceptance` writes `acceptanceCriteria[i].liveVerificationAttempt` into
the step payload. Defer to `operatorActionsRequested[]` ONLY when
`outcome != "verified"`.

### Dispatch pattern (when live-verify is possible)

Dispatch a single `Agent` (sonnet) per AC batch. The subagent:
1. Starts the minimal stack needed (e.g. `pnpm infra:up` or existing running services).
2. Runs the target verification command scoped to the AC's route or surface.
3. Returns `{ outcome: "verified|failed|inconclusive", evidence: "<log excerpt or metric>" }`.

Cap the subagent at 3 minutes wall-clock. If it times out, record `outcome: "inconclusive"`.

---

## Phase 2.6 — Manual-AC anti-soft-override regex

**This gate runs AFTER Phase 1.5.** ACs that were `verified` by a live-verify
probe bypass this gate entirely.

For each remaining AC (not yet `verified`), scan its description:

```
/\b(manual smoke|smoke harness|full[- ]stack smoke|staging|click|human[- ]in[- ]the[- ]loop|deploy[- ]time|verify in (browser|UI))\b/i
```

If the regex matches AND `mode == "autonomous"`, the AC is reserved for human
eyes — MUST NOT be silently marked `verified` with a "code-correctness portion"
rationalization.

**Exception** — split allowed only when the AC text explicitly contains
`code-only` or `code-correctness`. Record rationale verbatim under
`acceptanceCriteria[i].rationale` (mandatory, not optional).

### Action when matched

1. Set `acceptanceCriteria[i].status = "unverified"`.
2. Append to `operatorActionsRequested[]`:
   ```jsonc
   { "ac": "AC-<n>", "kind": "manual-verification",
     "description": "<verbatim AC text>",
     "status": "pending", "at": "<ISO>", "resolved": false }
   ```
3. Emit pause line and wait for operator reply:
   ```
   feature-acceptance: paused at STEP_<NN>_FEATURE_ACCEPTANCE — operator action required
     <description>
     Reply with the result when done (pass/fail + evidence).
   ```

On operator reply, resolve the entry (`resolved: true` + `resolution`) and resume.

### Phase 2.6.1 — AC-target relaxations

When the operator amends an AC's target at acceptance time, record under
`featureAcceptance.acRelaxations[]`:

```jsonc
{ "acId": "AC-4",
  "originalTarget": "≤5s",
  "relaxedTarget": "≤10s",
  "rationale": "<verbatim operator phrasing>",
  "source": "operator",
  "at": "<ISO>" }
```

Evaluate the AC's status against the relaxed target, not the original.
Free-text relaxations buried in `reviewHistory[]` are insufficient.

---

## Phase 2.7 — Manual + hybrid checklist template

Render this template when running `manual` (covers everything) or `hybrid`
(covers residual items the autonomous path couldn't resolve):

```
## Feature acceptance checklist

### Routes / surfaces affected
  - <path or component>

### Acceptance criteria
  AC-1 (binds FR-1): <description>
    How to verify: <derived method>

### Non-functional requirements
  NFR-1 (perf): <description> — target <target>
    How to verify: run `<command>`, compare to target.

### Success metrics
  M-1: <metric> — target <target>, method <method>

Reply with pass/fail per item + evidence.
```

Record operator replies into the same `acceptanceCriteria[]` /
`nfrVerifications[]` / `successMetrics[]` arrays as the autonomous path.
