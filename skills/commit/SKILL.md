---
name: commit
description: "Final phase of the dev workflow (… → update-docs → feature-acceptance → commit). Use whenever the user wants to commit staged changes — 'commit this', 'save this', 'checkpoint', or finish a task. Writes a Conventional Commits v1.0.0 message that mirrors the last 5 commits' style. ALWAYS stamps the `Co-authored-by: browzeremb` trailer. Runs `git commit` and reports the SHA. Appends STEP_<NN>_COMMIT to docs/browzer/<feat>/workflow.json via jq + mv when a feat dir is detected. Does NOT push, does NOT sync docs."
allowed-tools: Bash(browzer workflow *), Bash(git *), Bash(jq *), Bash(mv *), Bash(date *), Bash(sed *), Bash(grep *), Bash(xargs *), Bash(rm *)
---

<live_context>
**Staged (stat):**
!`git diff --cached --stat 2>/dev/null || echo "(nothing staged)"`

**Last 5 commits (mirror this style):**
!`git log -5 --oneline 2>/dev/null || echo "(no commits)"`
</live_context>

# commit — Conventional Commits, repo-aware

Write a `<type>(<scope>): <subject>` line that mirrors the last 5 commits in `<live_context>`. Don't over-analyze — the recent log is enough signal. If you need the full staged diff, run `git diff --cached` yourself.

## Shape

```
<type>[optional scope][!]: <description>

[optional body — explain WHY, wrap ~72 cols]

[optional footers]
Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
```

- **type**: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`. Lowercase.
- **scope**: lowercase noun matching the granularity of recent commits (e.g. if the log writes `api`, don't write `api/routes`). Nested forms (`api/users`) are valid for subtree-scoped changes.
- **subject**: imperative, no trailing period, ≤72 chars including prefix.
- **breaking**: `!` after type/scope AND/OR `BREAKING CHANGE:` footer.
- **Co-authored-by trailer is unconditional.** Always last line.
- **Avoid in-repo section references in the subject.** Numbers like `§17`, `step 14`, `phase 3`, `chapter 2` rot when docs reorganise — six months later "after §17" points at the wrong section, leaving the commit opaque. Prefer descriptive references that survive renumbering: a feature-id (`after feat-20260428-...`), a feature name (`after the dashboard cleanup`), or a parent commit short-SHA. Section numbers in the *body* are fine when they cite an external stable spec (RFC 7231 §6.5), but treat in-repo doc sections as moving targets.

## SemVer

`feat` → MINOR · `fix` → PATCH · `BREAKING CHANGE` → MAJOR · rest → none.

## Run it

Always pass the message via here-doc so multi-line bodies survive shell quoting:

```bash
git commit -m "$(cat <<'EOF'
fix(api/auth): close TOCTOU in session refresh

The check ran before the row lock; under concurrent refreshes a stale
session could be re-issued. Move the check inside the same tx as the
update.

Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
EOF
)"
```

**Never** `--amend` a pushed commit on a shared branch unless asked. **Never** `--no-verify` unless asked — hook failures are signal.

## Workflow.json integration (only when a feat dir is detected)

When `docs/browzer/feat-*/workflow.json` exists (passed via args as `feat dir: <path>` or the latest matching dir):

1. Read `.config.mode` from `$WORKFLOW`.
2. If `review`, render the proposed message via `jq -r --from-file references/renderers/commit.jq --arg stepId "$STEP_ID" "$WORKFLOW" > /tmp/review-$STEP_ID.md`, ask the operator (Approve / Adjust / Skip / Stop), and loop on Adjust — appending each round to the step's `reviewHistory[]`. Only fire `git commit` after Approve.
3. After `git commit` succeeds, append `STEP_<NN>_COMMIT`:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_COMMIT"

STEP=$(jq -n \
  --arg id "$STEP_ID" --arg now "$NOW" \
  --arg sha "$SHA" \
  --arg type "$TYPE" --arg scope "$SCOPE" \
  --arg subject "$SUBJECT" --arg body "$BODY" \
  --argjson trailers "$TRAILERS_JSON" \
  '{
     stepId: $id, name: "COMMIT", status: "COMPLETED",
     applicability: { applicable: true, reason: "final commit" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0, itDependsOn: [], nextStep: null,
     skillsToInvoke: ["commit"], skillsInvoked: ["commit"],
     owner: null, worktrees: { used: false, worktrees: [] },
     warnings: [], reviewHistory: [],
     commit: { sha: $sha, conventionalType: $type, scope: $scope,
               subject: $subject, body: $body, trailers: $trailers }
   }')

echo "$STEP" | browzer workflow append-step --workflow "$WORKFLOW"
```

`workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

When no feat dir is detectable, skip this entirely — the standalone `git commit` works unchanged.

## Pending-SHA placeholder (closure entries that reference their own commit)

When a staged file (typically a CHANGELOG entry written by `update-docs`) needs to reference its own commit's SHA, that SHA can't exist before `git commit` runs — chicken-and-egg. The historical fix was `git commit --amend --no-edit --no-verify` to backfill the placeholder; that path produces inconsistent SHAs across the audit trail (the CHANGELOG ends up referencing a SHA that exists only in `git reflog` after a rebase) and bypasses commit hooks.

**Default: two-commit pattern.** The feature commit lands first with the `**Commits**: pending — implementing branch <branch-name>` placeholder intact. Then a follow-up `docs(changelog): backfill <short-sha>` commit replaces every `pending` placeholder with the actual short SHA. Both commits are real, both run hooks, both survive rebases as themselves.

```bash
# Phase 1 — the feature commit (already done by the heredoc above; SHA captured here):
SHA=$(git rev-parse HEAD); SHORT=${SHA:0:8}

# Phase 2 — backfill follow-up only when placeholders exist in the just-landed commit:
PLACEHOLDER_FILES=$(git show --name-only --pretty=format: HEAD | xargs grep -l "Commits.*pending" 2>/dev/null)
if [ -n "$PLACEHOLDER_FILES" ]; then
  for f in $PLACEHOLDER_FILES; do
    sed -i.bak -E "s|\\*\\*Commits\\*\\*: pending[^\\n]*|**Commits**: \`$SHORT\`|" "$f" && rm -f "$f.bak"
  done
  git add $PLACEHOLDER_FILES
  git commit -m "$(cat <<EOF
docs(changelog): backfill $SHORT

Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
EOF
)"
  BACKFILL_SHA=$(git rev-parse HEAD)
fi
```

Operators can opt out with `--no-pending-amend` in args (preserves the placeholder, no follow-up commit).

**Legacy amend mode** is available behind `--legacy-amend-pending` for cases where a single commit is required (e.g. branch protection enforcing single-commit PRs):

```bash
git commit --amend --no-edit
SHA=$(git rev-parse HEAD)
```

Even in legacy mode, do NOT pass `--no-verify` — hook failures are signal. If hooks block the amend, fix the underlying issue.

## Output contract

One line. Nothing else.

Workflow-aware:
```
commit: updated workflow.json <STEP_ID>; status COMPLETED; SHA <sha>
```

Standalone:
```
commit: <sha> <type>(<scope>): <subject>
```

On hook failure with user-approved bypass, append `; ⚠ bypassed pre-commit (user-approved)`.

No file lists. No diff preview. No "Next steps" block.
