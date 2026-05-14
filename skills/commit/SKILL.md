---
name: commit
description: "Write a Conventional Commits v1.0.0 message mirroring the host's last 5 commits, stamp the on-behalf-of: @<org> trailer (per GitHub's organization-commit convention — orgs link via on-behalf-of, NOT Co-authored-by which is for human collaborators), and run git commit. Hard veto when invoked with a feature id: ACCEPTANCE.md.verdict must be accepted AND README.md must exist AND no TASK_*.failed.md present. Reports the SHA. Does NOT push. Triggers: commit, commit this, save this, checkpoint, finish this task, ship this commit, write a commit message, conventional commit."
argument-hint: "[<featureId>]"
---

You write Conventional Commits messages and run `git commit`. You do NOT
push. When invoked with a featureId, you enforce hard veto gates before
the commit runs.

## Inputs

- `$ARGUMENTS` (OPTIONAL): `<featureId>`. When provided, enables feature
  mode (veto gates + structured commit body). When absent, the
  standalone path works unchanged for ad-hoc commits.

## Live context

```
**Staged (stat):**
!`git diff --cached --stat 2>/dev/null || echo "(nothing staged)"`

**Last 5 commits (mirror this style):**
!`git log -5 --oneline 2>/dev/null || echo "(no commits)"`
```

## Veto gates (feature mode — HARD halt)

When `$ARGUMENTS` is a feature id matching `^feat-\d{8}-[a-z0-9-]+$`,
enforce these gates BEFORE composing the message:

1. `docs/browzer/<featureId>/staging/ACCEPTANCE.md` MUST exist. Missing → halt: "run `/feature-acceptance <featureId>` first".
2. `ACCEPTANCE.md.frontmatter.verdict` MUST equal `accepted`. Otherwise → halt: "verdict is `<verdict>`; operator must triage. See ACCEPTANCE.md".
3. `docs/browzer/<featureId>/README.md` MUST exist (at the feat root — `finalize-feature` writes it there as the only committed artefact). Missing → halt: "run `/finalize-feature <featureId>` first".
4. NO `docs/browzer/<featureId>/staging/TASK_*.failed.md` exists. Otherwise → halt: "triage failed tasks before commit: <list>".
5. NO `docs/browzer/<featureId>/staging/FIX_F-*.tech_debt.md` with `severity: high` unless `.browzer/accepted-tech-debt.json` carries an override.

## Message shape

Template at `${CLAUDE_SKILL_DIR}/template.md`. Summary:

```
<type>[optional scope][!]: <description>

[optional body — explain WHY, wrap ~72 cols]

Feature: <featureId>          # feature mode only
Verdict: <verdict>             # feature mode only
Tasks: <count>                 # feature mode only

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
```

- **type** enum: `feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert`.
- **subject**: imperative, ≤72 chars, no trailing period.
- **breaking**: `!` after type/scope AND/OR `BREAKING CHANGE:` footer.
- **`on-behalf-of:`** trailer is unconditional. Format exactly: `on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>`.
- Avoid in-repo section references (`§17`, `step 14`) in the subject — they rot.

**SemVer mapping**: `feat` → MINOR · `fix` → PATCH · `BREAKING CHANGE` → MAJOR · rest → none.

## Feature-mode summary extraction

When in feature mode, the commit body's summary paragraph comes verbatim
from `docs/browzer/<featureId>/README.md` `## Summary` section (the README
lives at the feat root, not under `staging/`). Read the README, extract that
paragraph (one block), use it as the body. The `Feature: / Verdict: / Tasks:`
trailer lines are computed:

- `Feature:` = `$ARGUMENTS`
- `Verdict:` = `ACCEPTANCE.md.frontmatter.verdict`
- `Tasks:` = count of `TASK_*.completed.md` in the feat folder

## Pre-push gate simulation

Detect host pre-push gates and simulate them before committing:

```bash
if [ ! -x "${CLAUDE_SKILL_DIR}/scripts/detect-prepush-gates.sh" ]; then
  echo "commit: stopped — pre-push gate script not found"
  exit 1
fi
GATES_JSON=$(bash "${CLAUDE_SKILL_DIR}/scripts/detect-prepush-gates.sh") || {
  echo "commit: stopped — pre-push gate detection failed"
  exit 1
}
PREPUSH_FAILED=$(jq -r '.failed[]?' <<<"$GATES_JSON" 2>/dev/null)
```

If `PREPUSH_FAILED` is non-empty: halt with `commit: stopped — pre-push
audits failed: <names>` UNLESS an operator-supplied `bypassReason`
exists (env var `BYPASS_REASON`, CLI flag `--bypass-reason`, or
`.browzer/skills.config.json#bypassReason`). Bypass without a reason is
forbidden.

## Staging-skip rule

When staging files for the commit, ALWAYS skip:

- `docs/browzer/**/staging/**` (legacy workflow.json era; not present in markdown-chains feats but the rule remains as defence in depth)
- `.browzer/**` (workspace-internal state)

The ONLY file inside `docs/browzer/<featureId>/` that gets committed is
the feat-root `README.md` (produced by `finalize-feature`). Everything
under `staging/` is gitignored via the `staging/.gitignore` written at
orchestrator INIT — the staging directory is per-operator scratch, not
versioned state.

Enumerate the committed surface explicitly (not `git add -A`) to avoid
pulling in unrelated working-tree changes: the feat-root `README.md`
plus any source-tree edits that landed during the workflow.

## Run the commit

Always pass the message via here-doc so multi-line bodies survive shell quoting:

```bash
git commit -m "$(cat <<'EOF'
<message body>
EOF
)"
SHA=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

Never `--amend` a pushed commit on a shared branch unless asked.
Never `--no-verify` unless the operator supplied `bypassReason`.

## Pending-SHA backfill (two-commit pattern)

When a staged file (typically a CHANGELOG entry) references its own
commit's SHA via `**Commits**: pending` placeholders, use the
two-commit pattern via `${CLAUDE_SKILL_DIR}/scripts/backfill-pending-sha.mjs`.
Procedure unchanged from prior version — never raw sed.

## Output contract (one line)

Feature mode:

```
commit: sha=<full-sha>; feature=<featureId>; <type>(<scope>): <subject>
```

Standalone:

```
commit: sha=<full-sha>; <type>(<scope>): <subject>
```

Failure:

```
commit: stopped — <one-line cause>
hint: <single actionable next step>
```

When operator-approved bypass occurred, append `; ⚠ bypassed <audit-name> (operator-approved)`.

## Done when

- `git commit` exited 0 and `git rev-parse HEAD` returns a non-empty SHA.
- The commit message matches the Conventional Commits shape with the `on-behalf-of:` trailer.
- `git status --porcelain` reports zero untracked / modified files immediately after the commit. A dirty tree at this point is a contract violation — the state machine treats it as "commit phase incomplete" and loops.

## References

- `${CLAUDE_SKILL_DIR}/template.md` — message shape, veto gates
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — which files to stage
