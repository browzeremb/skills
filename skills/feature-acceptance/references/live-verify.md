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

## Phase 2.5.1 — Success-metric anti-soft-override regex

**This gate fires before §2.5 marks any `successMetrics[i].resolved: true`.** It protects the
metric-verification path the same way §2.6 protects ACs. Without it, autonomous mode
silently flipped `M-3` (dashboard sync) and `M-4` (5-source `/ask`) to `resolved: true` with
rationale "resolved-via-test-equivalent" / "synthetic equivalent of the dogfood scenario" —
even though no live `/sync` ran and no `/ask` exercised a 5-source workspace. The dogfood
report friction §feature-acceptance verdict §M-3/M-4 is the canonical failure mode.

For each `successMetrics[i]`, scan `metric.description` AND `metric.target`:

```
/\b(dashboard|browser|UI|/ask\b|/sync\b|/dashboard|/login|live|in production|post[- ]merge|operator (action|reply))\b/i
```

If the regex matches AND `mode == "autonomous"`, the metric is reserved for human eyes —
MUST NOT be flipped to `resolved: true` based on a unit-test or synthetic-fixture run. The
common failure pattern is "X.test.ts asserts the same string the metric requests, therefore
M-N is met" — that's a code-correctness check, not the metric the PRD declared.

**Forbidden rationales** (auto-rejected, regardless of explanation):

```
/\b(test[- ]equivalent|synthetic equivalent|covered by unit test|asserted in (chain|api|web)\.test\.ts|equivalent fixture)\b/i
```

### Action when matched

1. Set `successMetrics[i].status = "unmet"` AND `successMetrics[i].resolved = false`.
2. Append to `operatorActionsRequested[]`:
   ```jsonc
   { "metric": "M-<n>", "kind": "deferred-post-merge",
     "description": "<verbatim metric text>",
     "target":      "<verbatim target>",
     "status": "pending", "at": "<ISO>", "resolved": false }
   ```
3. The metric flips to `resolved: true` ONLY when the operator replies with verification
   evidence (passing screen, log excerpt, Prometheus query result, etc.). Until then the
   step status remains `PAUSED_PENDING_OPERATOR` — `commit` still proceeds (deferred-post-merge
   is non-fatal) but the metric stays `unmet` in the verdict.

### Allowed exceptions

- The metric `description` AND `target` are both code-only (e.g. test-coverage % via
  `pnpm coverage`, mutation-pass rate via Stryker). Record `successMetrics[i].rationale`
  verbatim — mandatory, not optional.
- The operator pre-registered the metric as `auto-resolve-via: <runner>` in PRD args. Look
  for the literal string in `prd.successMetrics[i].autoResolveVia`.

Free-text rationales like "I think this is equivalent" are insufficient. The audit script
walks `successMetrics[]` post-write and rejects any `resolved: true` whose rationale
matches the forbidden-rationales regex.

---

## Phase 2.6.2 — Anti-inspect-on-execution-required ACs

**This gate fires BEFORE Phase 2.6's regex.** It guards the orthogonal failure mode where
an AC's text declares execution as the verification (e.g. "passes when run via CI", "all
green when the suite executes", "test executes against the live env"), and the autonomous
path silently downgrades that to `method: "inspect"` evidence ("file exists under X / test
file present" — file existence is structural, not behavioral).

For each AC whose `status` is about to be set, scan its text for execution-required
language. The regex covers English (canonical AC language per `non-negotiables: Output
language: English`) plus a small PT-BR / ES surface for AC text that slipped through in
the operator's locale — extend per project as needed:

```
/\b(passes? when (it )?run|all green when|test executes|when (the )?suite (runs|executes)|when (run|executed) (via|on|under) (CI|the runner|the harness)|each (test|file) (passes|runs (green|clean))|passa quando (executa|roda)|todos verdes quando|teste executa|cuando (la suite|las pruebas) (corren|ejecutan))\b/i
```

> **Locale guardrail.** When the project mixes English ACs with non-English ones, projects
> SHOULD enforce English-only AC text (matches the `feature-acceptance` non-negotiable).
> Projects that legitimately need other locales should extend the regex above by appending
> alternation branches per locale; do NOT loosen the match to a sub-string scan, as that
> dilutes the false-positive rate.

If the regex matches, the AC is **execution-required**. The skill MUST then choose ONE of:

1. **Actually execute the verification command locally.** Resolve from `package.json` scripts
   (`test`, `test:integration`, `test:e2e`) or the Phase 1.5 live-verify probe. Parse the
   pass/fail output. Mark the AC `verified` ONLY if the run actually returns success.
2. **Defer with an honest verdict.** Set `acceptanceCriteria[i].status = "unverified"` AND
   append to `operatorActionsRequested[]` with `kind: "blocks-commit"` (per Phase 2.6.3
   enum) AND `reason: "execution-required AC; runner/env not available locally"`.

**Forbidden** (auto-rejected by post-write audit):

- `acceptanceCriteria[i].status = "verified"` with `method: "inspect"` AND the AC text
  matches the execution-required regex. Inspect-only on execution-required ACs is exactly
  the "ls of a directory ⇒ verified" failure mode.
- `acceptanceCriteria[i].evidence` containing the substrings `"files exist"`, `"file
  present"`, `"directory listed"`, `"test execution deferred to CI"` when method is
  `inspect`. These phrases are markers of a downgrade, not evidence.

### Auditable record

Whichever path the skill takes, capture under
`acceptanceCriteria[i].executionRequiredProbe`:

```jsonc
{
  "matched": true,
  "regexHit": "<the matched substring>",
  "decision": "executed-locally" | "deferred-blocks-commit",
  "runnerCmd": "<command if executed-locally, else null>",
  "exitCode": 0 | <int> | null,
  "evidenceLog": "<path to /tmp log if executed, else null>"
}
```

Phase 2.6.3 verdict computation (see workflow-schema §featureAcceptance) treats
`deferred-blocks-commit` entries as PRE-COMMIT blockers, not post-merge — `commit` does NOT
proceed until they resolve. This is stricter than the Phase 2.6 manual-verification path
(deferred-post-merge, commit proceeds) because the AC author explicitly bound the AC to a
runnable check.

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
