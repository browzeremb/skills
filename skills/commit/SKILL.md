---
name: commit
description: "Write a Conventional Commits v1.0.0 message mirroring the host's last 5 commits, stamp the on-behalf-of: @<org> trailer (per GitHub's organization-commit convention — orgs link via on-behalf-of, NOT Co-authored-by which is for human collaborators) when the host has configured an org, and run git commit. Hard veto when invoked with a feature id: ACCEPTANCE.md.verdict must be accepted AND README.md must exist AND no TASK_*.failed.md present. Reports the SHA. Does NOT push."
argument-hint: "[<featureId>]"
disable-model-invocation: true
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

1. `docs/browzer/<featureId>/staging/acceptance/ACCEPTANCE.md` MUST exist. Missing → halt: "run `/feature-acceptance <featureId>` first".
2. `ACCEPTANCE.md.frontmatter.verdict` MUST equal `accepted`. Otherwise → halt: "verdict is `<verdict>`; operator must triage. See ACCEPTANCE.md".
3. `docs/browzer/<featureId>/README.md` MUST exist (at the feat root — `finalize-feature` writes it there as the only committed artefact). Missing → halt: "run `/finalize-feature <featureId>` first".
4. NO `docs/browzer/<featureId>/staging/tasks/TASK_*.failed.md` exists. Otherwise → halt: "triage failed tasks before commit: <list>".
5. NO `docs/browzer/<featureId>/staging/fixes/F-*.tech_debt.md` with `severity: high` unless `.browzer/accepted-tech-debt.json` carries an override.

## Org attribution — configuration

The `on-behalf-of:` trailer requires the operator to declare which GitHub
organization is attributed for commits. The plugin reads it from git config
(per-repo or globally configured):

```bash
git config browzer.commitOrg       # org handle, e.g. "acme"
git config browzer.commitOrgId     # numeric GitHub user/org ID, e.g. "274369678"
```

The numeric ID is what GitHub uses in noreply email aliases — fetch yours from
`https://api.github.com/users/<org>` (`.id` field) or
`https://api.github.com/orgs/<org>` and persist it once with `git config
--global browzer.commitOrgId <N>`.

When both keys are set, the trailer renders as:

```
on-behalf-of: @<commitOrg> <<commitOrgId>+<commitOrg>@users.noreply.github.com>
```

When either key is missing, OMIT the `on-behalf-of:` trailer entirely.
Personal-attribution commits are valid Conventional Commits without the
trailer; the convention is a GitHub org-linking aid, not a Conventional
Commits requirement. Halt only when the operator EXPLICITLY asked for the
trailer (e.g. `/commit --on-behalf-of=<org>`) and the config is missing.

Probe at skill entry:

```bash
ORG=$(git config --get browzer.commitOrg 2>/dev/null || true)
ORG_ID=$(git config --get browzer.commitOrgId 2>/dev/null || true)
if [ -n "$ORG" ] && [ -n "$ORG_ID" ]; then
  TRAILER="on-behalf-of: @${ORG} <${ORG_ID}+${ORG}@users.noreply.github.com>"
else
  TRAILER=""
fi
```

## Message shape

Template at `${CLAUDE_SKILL_DIR}/template.md`. Summary:

```
<type>[optional scope][!]: <description>

[optional body — explain WHY, wrap ~72 cols]

Feature: <featureId>          # feature mode only
Verdict: <verdict>             # feature mode only
Tasks: <count>                 # feature mode only

<on-behalf-of trailer when configured; see §Org attribution above>
```

- **type** enum: `feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert`.
- **subject**: imperative, ≤72 chars, no trailing period.
- **breaking**: `!` after type/scope AND/OR `BREAKING CHANGE:` footer.
- **`on-behalf-of:`** trailer is emitted when `browzer.commitOrg` and `browzer.commitOrgId` are both configured (see §Org attribution above). When either is missing, omit the trailer.
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

Before composing the commit, run the host's pre-push gate as a non-mutating
dry-run. This is MANDATORY — not best-effort. The simulation result is
captured in `<feat>/staging/COMMIT_PREPUSH.md`.

Detect host pre-push gates by running
`bash ${CLAUDE_PLUGIN_ROOT}/skills/commit/scripts/detect-prepush-gate.sh`
and consuming its JSON output (`gatesDetected[]`). The script encodes the
detection conventions; the prose below summarises them for reader context
but the script is authoritative.

Detect the host pre-push gate by checking common conventions in this order:

1. `.git/hooks/pre-push` — a repository git hook.
2. A configured hook manager (a project-root manifest file declaring lifecycle
   scripts).
3. A `pre-push`/`prepush` script in the project's package manifest.

Run the detected gate in dry-run mode (the gate's documented `--dry-run` flag,
or a sentinel ref that skips the side-effecting steps). NEVER set `--no-verify`
or any flag that suppresses the gate.

Capture per-gate result into the frontmatter of `COMMIT_PREPUSH.md`:

```yaml
---
featureId: feat-YYYYMMDD-<slug>
simulationRun: true
gatesDetected: [lint, typecheck, test]
gatesPassed: [lint, typecheck]
gatesBypassed: []
bypassReason: null
---
```

### Halt on failure

When any gate appears in `gatesDetected[]` but NOT in `gatesPassed[]` AND NO
bypass flag is set, the skill MUST halt the commit with a structured error
naming each failing gate by name. The operator may override by re-invoking with
the documented bypass flag; the flag's name and the reason go into
`gatesBypassed[]` and `bypassReason` respectively.

To stop on a failing gate: emit `commit: stopped — gate failed: <name>` and
abort before `git commit` runs. Never skip a failing gate silently.

### Does NOT push

This skill writes the commit and stops. It NEVER runs `git push`. Push is the
operator's decision and happens outside the skill.

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
- The commit message matches the Conventional Commits shape. The `on-behalf-of:` trailer is present iff `browzer.commitOrg` + `browzer.commitOrgId` were configured.
- `git status --porcelain` reports zero untracked / modified files immediately after the commit. A dirty tree at this point is a contract violation — the state machine treats it as "commit phase incomplete" and loops.

## References

- `${CLAUDE_SKILL_DIR}/template.md` — message shape, veto gates
- `${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` — which files to stage
