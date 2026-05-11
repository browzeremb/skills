---
name: commit
description: "Write a Conventional Commits v1.0.0 message mirroring the repo's last 5 commits, stamp the `on-behalf-of: @browzeremb` org-attribution trailer (per GitHub's organization-commit doc — orgs link via `on-behalf-of:`, NOT `Co-authored-by:` which is for human collaborators), and run `git commit`. Reports the SHA. Does NOT push. Use whenever the user wants to commit staged changes. Triggers: commit, commit this, save this, checkpoint, finish this task, ship this commit, write a commit message, conventional commit."
argument-hint: "<featureId>"
---

You write Conventional Commits messages and run `git commit`. You do NOT push.

<live_context>
**Staged (stat):**
!`git diff --cached --stat 2>/dev/null || echo "(nothing staged)"`

**Last 5 commits (mirror this style):**
!`git log -5 --oneline 2>/dev/null || echo "(no commits)"`
</live_context>

## Read context (only when a feature id is present)

```!
if [ -n "$ARGUMENTS" ]; then
  browzer get-step COMMIT --id "$ARGUMENTS" 2>/dev/null || echo "(no COMMIT step yet for $ARGUMENTS)"
else
  echo "(standalone commit — no workflow context)"
fi
```

`$ARGUMENTS` is the feature id passed by the orchestrator (e.g. `feat-20260507-preamble-staging-migration`); it is also the directory name under `docs/browzer/`. When no feature id is provided (standalone invocation), skip the workflow integration entirely — the standalone `git commit` path works unchanged.

## Message shape

```
<type>[optional scope][!]: <description>

[optional body — explain WHY, wrap ~72 cols]

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
```

- **type**: `feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert`. Lowercase.
- **scope**: lowercase noun matching the recent log granularity. Nested forms (`api/users`) are valid for subtree-scoped changes.
- **subject**: imperative, no trailing period, ≤72 chars including prefix.
- **breaking**: `!` after type/scope AND/OR `BREAKING CHANGE:` footer.
- **`on-behalf-of:` trailer is unconditional** — credits the Browzer organization per [GitHub's organization-commit doc](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-on-behalf-of-an-organization). Always last line. The `@browzeremb` handle MUST be prefixed with `@` and the email MUST be the org noreply `<274369678+browzeremb@users.noreply.github.com>`. Do NOT use `Co-authored-by:` for `browzeremb` — that trailer is for humans; orgs surface via `on-behalf-of:`.
- Avoid in-repo section references (`§17`, `step 14`) in the subject — they rot. Prefer feature-id, feature name, or parent commit SHA.

## SemVer mapping

`feat` → MINOR · `fix` → PATCH · `BREAKING CHANGE` → MAJOR · rest → none.

## Staging-skip rule (what to include in git add)

When staging files for the conventional commit, skip any path matching:

- `docs/browzer/**/staging/**` — workflow staging artifacts; managed by the autosave hook, never committed directly.
- `docs/browzer/**/workflow.json*` — workflow state files and their backups; gitignored.

The ONLY path from `docs/browzer/` that IS committed is `docs/browzer/**/README.md` — written by `finalize-feature` and explicitly un-gitignored by `.gitignore` (`!docs/browzer/**/README.md`). Stage it alongside code/test/doc files outside `docs/browzer/`.

```bash
# Safe staging pattern for a feature commit
git add -- $(git diff --cached --name-only; git ls-files --others --exclude-standard) \
  | grep -v 'docs/browzer/.*/staging/' \
  | grep -v 'docs/browzer/.*workflow\.json'
# Then explicitly include the README if present
FEAT_README="docs/browzer/$ARGUMENTS/README.md"
if [ -f "$FEAT_README" ]; then git add -- "$FEAT_README"; fi
```

## Pre-push gate simulation (BEFORE git commit)

Detect the project's local pre-push gates and simulate them before committing, so the commit step catches what would otherwise block the next `git push`.

```bash
if [ -z "${CLAUDE_SKILL_DIR}" ]; then
  echo "commit: stopped — CLAUDE_SKILL_DIR not set"
  exit 1
fi
GATES_SCRIPT="${CLAUDE_SKILL_DIR}/scripts/detect-prepush-gates.sh"
if [ ! -x "$GATES_SCRIPT" ]; then
  echo "commit: stopped — pre-push gate script not found or not executable: $GATES_SCRIPT"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "commit: stopped — jq is required but not installed"
  exit 1
fi
GATES_JSON=$(bash "$GATES_SCRIPT") || {
  echo "commit: stopped — pre-push gate detection failed"
  exit 1
}
echo "$GATES_JSON" | jq -e '.' >/dev/null 2>&1 || {
  echo "commit: stopped — pre-push gate output was not valid JSON"
  exit 1
}
PREPUSH_FAILED=$(jq -r '.failed[]' <<<"$GATES_JSON")
```

If `PREPUSH_FAILED` is non-empty, stop with: `commit: stopped — pre-push audits failed: <names>` and hint to fix locally. Do NOT silently bypass; bypass requires operator-approved `bypassReason`.

### Pre-push audits — mandatory population

Both `prePushAuditsRun[]` and `prePushAudits[]` MUST be non-empty in every `COMMIT.json` written when a feature directory is present. Parse `$GATES_JSON` immediately after the gate check and derive the two arrays:

```bash
# Map audits[] → prePushAuditsRun (names only)
PREPUSH_AUDITS_RUN=$(jq -c '[.audits[].name]' <<<"$GATES_JSON")

# Map audits[] → prePushAudits (full records).
# The CUE schema source enum is: husky | lefthook | operator.
# The script may also emit source="git" — normalise it to "operator".
PREPUSH_AUDITS=$(jq -c '[.audits[] | {
  name,
  source: (if .source == "git" then "operator" else .source end),
  exitCode,
  durationMs
}]' <<<"$GATES_JSON")
```

**No-gates-discovered rule**: when `detect-prepush-gates.sh` returns `"audits":[]` (no hooks found in the repo), BOTH arrays must still be non-empty. Insert a single placeholder entry so the arrays are never `[]`:

```bash
if [ "$(jq '.audits | length' <<<"$GATES_JSON")" -eq 0 ]; then
  PREPUSH_AUDITS_RUN='["no-gates-discovered"]'
  PREPUSH_AUDITS=$(jq -cn --arg reason "No lefthook/husky/git pre-push hook detected in this repo." \
    '[{name:"no-gates-discovered",source:"operator",exitCode:0,durationMs:0,output:$reason}]')
fi
```

Include `$PREPUSH_AUDITS_RUN` and `$PREPUSH_AUDITS` in the `COMMIT.json` payload as `prePushAuditsRun` and `prePushAudits` respectively. These fields are never omitted — even on a fully green pass with all audits passing, the arrays carry the executed audit records.

**Done when**: `COMMIT.json` written to `staging/` has `prePushAuditsRun` with ≥1 string entry AND `prePushAudits` with ≥1 object entry whose required fields (`name`, `source`, `exitCode`) are present. If either array is `[]` or absent, the step is incomplete — re-run the population block before writing.

### Bypass mechanism

When the operator must bypass pre-push gates, they provide a non-empty UTF-8 reason string (max 200 chars) via one of:

- Environment variable: `BYPASS_REASON="<text>"`
- Command-line flag: `--bypass-reason "<text>"`
- A `bypassReason` field in `.browzer/skills.config.json`

The system rejects any bypass without an explicit, non-empty reason. The provided `bypassReason` MUST be recorded on the `pushAttempts[]` audit entry written below and surfaced in the final one-line output.

## Run the commit

Always pass the message via here-doc so multi-line bodies survive shell quoting:

```bash
git commit -m "$(cat <<'EOF'
fix(api/auth): close TOCTOU in session refresh

The check ran before the row lock; under concurrent refreshes a stale
session could be re-issued. Move the check inside the same tx as the
update.

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
EOF
)"
SHA=$(git rev-parse HEAD)
```

Never `--amend` a pushed commit on a shared branch unless asked. Never `--no-verify` unless asked — hook failures are signal.

## Pending-SHA backfill (two-commit pattern)

When a staged file (typically a CHANGELOG entry) needs to reference its own commit's SHA, use the two-commit pattern. The feature commit lands first with `**Commits**: pending` placeholders; a follow-up `docs(changelog): backfill <short-sha>` rewrites the placeholders. Both commits run hooks, both survive rebases.

Use the fixture-backed `scripts/backfill-pending-sha.mjs` — never raw sed (the historical regex mangles trailing prose):

```bash
readarray -t PLACEHOLDER_FILES < <(git show --name-only --pretty=format: HEAD | xargs grep -l "Commits.*pending" 2>/dev/null)
if [ ${#PLACEHOLDER_FILES[@]} -gt 0 ]; then
  BACKFILL="${CLAUDE_SKILL_DIR}/scripts/backfill-pending-sha.mjs"
  for f in "${PLACEHOLDER_FILES[@]}"; do node "$BACKFILL" --file "$f" --sha "${SHA:0:8}" --mode dry-run; done
  for f in "${PLACEHOLDER_FILES[@]}"; do node "$BACKFILL" --file "$f" --sha "${SHA:0:8}" --mode apply; done
  git add -- "${PLACEHOLDER_FILES[@]}"
  git commit -m "docs(changelog): backfill ${SHA:0:8}"$'\n\n'"on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>"
fi
```

Operators can opt out with `--no-pending-amend`. A legacy single-commit `--amend` mode is available behind `--legacy-amend-pending` for branch-protection rules that require single-commit PRs; even then do NOT pass `--no-verify`.

## pushAttempts audit trail (re-entry tracking)

When the operator re-invokes `commit` after STOP / PAUSED — typically because the pre-push audit caught something the operator then bypassed (`LEFTHOOK=0`, `--no-verify`, `--amend`) — capture the attempt history. Any bypass MUST carry an operator-supplied `bypassReason`; without one, stop with: `commit: stopped — bypass detected without operator-supplied reason`.

## Produce

Write `docs/browzer/<feat>/staging/COMMIT.json` (only when feat dir is present).

> Shape reference: see `template.md` (auto-generated from the workflow CUE schema). Do not paste schema-claiming JSON into this body.

The autosave hook validates and persists.

## Persistence

The autosave hook persists `staging/COMMIT.json` automatically on write. Recommended flags when manually invoking `save-step`:

- `--quiet --async` — COMMIT is the terminal phase; fire-and-forget after the SHA is known.

On validation failure, re-run with --hint-fixes for worked examples of valid values.

## Output contract (one line)

Workflow-aware:

```
commit: sha=<full-sha>; <type>(<scope>): <subject>
```

Standalone (no feat dir):

```
commit: sha=<full-sha>; <type>(<scope>): <subject>
```

Failure:

```
commit: stopped — <one-line cause>
hint: <single actionable next step>
```

When operator-approved bypass occurred, append `; ⚠ bypassed <audit-name> (operator-approved)`.
