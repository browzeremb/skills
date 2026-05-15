# Code-subagent role addendum (markdown-chains era)

> **Applicability** — dispatcher-only paste-include addendum for
> implementation-agent dispatches: `execute-task`, `receiving-code-review`.
> (The `write-tests` skill was removed in Lever C — tests are now
> authored inline by `execute-task`'s coder.) Layered on top of the
> compact dispatch template at
> `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`. Adds
> code-edit specifics that don't apply to read-only roles. Keep it short
> — every line counts in N parallel dispatches.

The compact template's seven invariants already cover skill-loading,
blast-radius, scope, comments policy, no-`git stash`, browzer-first,
and one-line return. This addendum extends them with code-edit
specifics: host-rule anchoring, baseline gate capture, loop-escape
discipline, and the structured-report shape.

## Step 1 — Anchor on the host repo's rules

Before editing any code:

1. Read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` at the repo root
   — the "Cross-cutting invariants" section (or equivalent) is
   authoritative. Always read this in full.
2. For per-package / per-app `CLAUDE.md`: FIRST run `browzer search
   '<package or area> invariants'` and `browzer explore '<package>
   conventions'`. Read the per-package doc in full ONLY when (a) the
   search returns no relevant chunks, OR (b) Scope explicitly modifies
   invariant-bearing files (auth seed, billing migrations, security
   middleware).
3. Run `browzer search "<topic>"` before touching any library, framework,
   or configuration syntax you did not author. Training data may be
   stale or not match the pinned version.

If a rule in the dispatcher's prompt conflicts with a rule in
`CLAUDE.md`, follow `CLAUDE.md` and flag the conflict in your `##
Subagent report` under `### Scope adjustments`. `CLAUDE.md` is the
host's source of truth.

## Step 2 — Capture baseline BEFORE editing anything

Run the host's declared quality gates **scoped to your Scope block**.
Never run the repo-wide gate command when your Scope is a subset of
files.

**Discovery order**:

1. **Dispatcher passes scoped gate commands** → use those verbatim.
   Preferred path.
2. **Discover toolchain** and pick scoped form:
   - pnpm + Turborepo → `pnpm turbo lint typecheck test --filter=<pkg>`
   - npm / Yarn classic → inspect `package.json` scripts.
   - Nx → `nx affected:lint test build`
   - Go → `go vet ./<pkg>/...` + `go test ./<pkg>/...`
   - Python (ruff + pytest) → `ruff check <paths>` + `pytest <path>`
   - Cargo → `cargo check -p <crate>` + `cargo test -p <crate>` +
     `cargo clippy -p <crate>`
3. **Else** fall back to framework defaults AND log `scopeAdjustments[]`
   with `reason: "no scoped gate command discoverable"`.

Record baseline in your final `## Subagent report` under `### Baseline
gates` (pass counts, lint 0/N, typecheck pass/fail). If baseline is red
for reasons unrelated to your task, STOP and hand back — flag under
`scopeAdjustments` with `reason: "baseline red, not my fault"`.

**Baseline source — NEVER `git stash`.** When your dispatcher's brief
inlines a pre-change baseline file (e.g. for a regression-tester lane),
use the inlined content. When you need to compare against `origin/main`,
use the non-mutating `git show origin/main:<path>` — see invariant 5 in
the compact template.

## Step 2.5 — Loop-escape rule (mandatory)

When the same failure fingerprint repeats across consecutive iterations:

1. **Track the failure fingerprint** — assertion message, DB constraint
   name, typecheck error code + path, or test ID + first stacktrace
   frame.
2. **On the 3rd consecutive iteration with the same fingerprint**, stop
   and choose ONE of:
   - `Skill('testing-strategies')` — test-setup, fixture-isolation,
     assertion-shape issues.
   - `Skill('systematic-debugging')` — unknown runtime state
     (concurrency, environment, state machine).
   - **Return `outcome: blocked`** with the constraint quoted verbatim,
     iteration count, and one-line hypothesis.
3. **Do not silently retry past iteration 3.**

## Step 3 — Comments self-audit (BLOCKING before return)

Invariant 4 in the compact template forbids comments referencing
workflow artefacts. Before composing your `## Subagent report`, run:

```bash
grep -nE "FR-[0-9]+|AC-[0-9]+|F-[0-9]{3}|TASK_[0-9]{2}|retired in v" $FILES_YOU_TOUCHED
```

A non-empty result is a contract violation. Remove the offending
comments and re-run the grep until it returns empty. Record the audit
result under `### Invariants checked` (one line per audited file or one
line stating `comments-audit: clean across N files`).

## Step 4 — Verify, then emit the structured subagent report

Re-run every Step 2 gate command with identical arguments. Build a
regression table (lint / typecheck / unit tests baseline vs
post-change). Any regression beyond the task's stated tolerance
(default: zero new failures) is a failure.

**Return a structured `## Subagent report`** with the following sections
(your dispatcher splices them into the renamed `TASK_NN.completed.md`
or `FIX_F-NNN.completed.md` body):

```markdown
## Subagent report

### Outcome
<one of: completed | failed | adjusted | blocked>

### Files modified
- (regex-strict — see ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md Block 1)

### Files created
- (regex-strict — Block 2)

### Symbols changed
- (regex-strict — Block 3)

### Baseline gates
<pre vs post gate counts>

### Invariants checked
- (verbatim rule from CLAUDE.md, file:line, status)
- comments-audit: <clean | violations-removed across N files>

### Scope adjustments
- <free-form, one bullet per deviation>

### Failure (only when outcome == failed)
Reason: <one of: malformed-subagent-report | gate-red-post-change | scope-exhausted | iteration-limit-hit | other>
Details: <verbatim error or constraint>
```

The dispatcher parses these blocks via regex — drift toward
natural-language narration breaks the parser silently. Read
`${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md`
(short) before emitting the first block.

## Step 5 — Return EXACTLY one line, then stop

After emitting the `## Subagent report`, return a single status line:

```
<skill>: outcome=<completed|failed|adjusted|blocked>; files=<created>/<modified>; symbols=<count>
```

No recap, no file list, no TODO block. The structured report is the
record. Multi-line returns are truncated to the first line by the
dispatcher and surface a `subagent-verbose-return` warning in the
trace — see invariant 7 in the compact template.
