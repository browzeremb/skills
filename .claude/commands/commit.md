---
name: commit
description: "Write a Conventional Commits v1.0.0 message mirroring the repo's last 5 commits, stamp the `on-behalf-of: @browzeremb` org-attribution trailer (per GitHub's organization-commit doc — orgs link via `on-behalf-of:`, NOT `Co-authored-by:` which is for human collaborators), and run `git commit`. Reports the SHA. Does NOT push. Use whenever the user wants to commit staged changes. Triggers: commit, commit this, save this, checkpoint, finish this task, ship this commit, write a commit message, conventional commit."
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(git *), Bash(jq *), Bash(mv *), Bash(date *), Bash(sed *), Bash(grep *), Bash(xargs *), Bash(rm *), Bash(source *), Bash(node *), Bash(lefthook *), Bash(yq *), Bash(bash *), Bash(command *)
mutates:
  - path: steps[].commit
    requires: [conventionalType, scope, subject, body, trailers, prePushAuditsRun, prePushAudits, pushAttempts]
---

<live_context>
**Staged (stat):**
!`git diff --cached --stat 2>/dev/null || echo "(nothing staged)"`

**Last 5 commits (mirror this style):**
!`git log -5 --oneline 2>/dev/null || echo "(no commits)"`
</live_context>

# commit — Conventional Commits, repo-aware

## References router

| Topic | Reference |
|---|---|
| **Workflow CLI cheat-sheet (load FIRST when `workflow.json` is present)** | `../orchestrate-task-delivery/references/pipeline-phases.md` — literal copy-paste for every `browzer workflow *` verb |
| Atomic jq helpers (seed_step, complete_step, clarification_audit) | `scripts/jq-helpers.sh` |
| Pending-SHA two-commit pattern | §Pending-SHA placeholder below |
| Workflow step shapes | `references/workflow-schema.md` |

```bash
source scripts/jq-helpers.sh
```

(The helpers are optional — only needed when `workflow.json` is present.)

Write a `<type>(<scope>): <subject>` line that mirrors the last 5 commits in `<live_context>`. Don't over-analyze — the recent log is enough signal. If you need the full staged diff, run `git diff --cached` yourself.

## Shape

```
<type>[optional scope][!]: <description>

[optional body — explain WHY, wrap ~72 cols]

[optional footers]
on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
```

- **type**: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`. Lowercase.
- **scope**: lowercase noun matching the granularity of recent commits (e.g. if the log writes `api`, don't write `api/routes`). Nested forms (`api/users`) are valid for subtree-scoped changes.
- **subject**: imperative, no trailing period, ≤72 chars including prefix.
- **breaking**: `!` after type/scope AND/OR `BREAKING CHANGE:` footer.
- **`on-behalf-of:` trailer is unconditional.** Credits the Browzer organization on the commit graph per [GitHub's organization-commit doc](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-on-behalf-of-an-organization). Always last line. The `@browzeremb` handle MUST be prefixed with `@` and the email MUST be the org's noreply address `<274369678+browzeremb@users.noreply.github.com>` so GitHub resolves the avatar/link. Do NOT use `Co-authored-by:` for `browzeremb` — that trailer is for human collaborators; orgs surface via `on-behalf-of:` and only that path produces the "on behalf of @browzeremb" badge in the PR/commit UI.
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

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
EOF
)"
```

**Never** `--amend` a pushed commit on a shared branch unless asked. **Never** `--no-verify` unless asked — hook failures are signal.

## Phase 8.5 — Pre-push audit simulation (BEFORE git commit)

Run BEFORE `git commit` fires. Detects the project's local pre-push gates and simulates them
in-place so the commit step catches the same audits that would otherwise block the operator's
subsequent `git push`. Skips gracefully when no gate exists.

The detection + simulation is delegated to `scripts/detect-prepush-gates.sh` so the logic is
fixture-backed (no inline bash growing across edits) and emits a single JSON document the
skill consumes:

```bash
GATES_JSON=$(bash "${CLAUDE_SKILL_DIR}/scripts/detect-prepush-gates.sh")
# Shape: { audits: [{name, source, exitCode, durationMs}], failed: [name…], runners: [source…] }

PREPUSH_AUDITS_RUN=($(jq -r '.audits[].name' <<<"$GATES_JSON"))
PREPUSH_FAILED=($(jq -r '.failed[]'         <<<"$GATES_JSON"))
PREPUSH_AUDITS_DETAILED=($(jq -c '.audits[]' <<<"$GATES_JSON"))

if [ "${#PREPUSH_FAILED[@]}" -gt 0 ]; then
  echo "commit: stopped at STEP_<NN>_COMMIT — pre-push audits failed: ${PREPUSH_FAILED[*]}"
  echo "hint: fix locally then re-invoke commit; do NOT pass --no-verify or LEFTHOOK=0 unless operator explicitly approves the bypass"
  exit 1
fi
```

When no gate is detected (`PREPUSH_AUDITS_RUN` empty), proceed silently to the commit. When
audits ran and all passed, record the list under `commit.prePushAuditsRun[]` for the audit
trail. When the operator explicitly approves a bypass (rare; typically `LEFTHOOK=0` env or
`--no-verify` arg), record the full bypass via Phase 8.7 below — never silently swallow.

## Workflow.json integration (only when a feat dir is detected)

When `docs/browzer/feat-*/workflow.json` exists (passed via args as `feat dir: <path>` or the latest matching dir):

1. Read `.config.mode` from `$WORKFLOW`.
2. If `review`, render the proposed message via `REVIEW_MD="$(mktemp -t commit-review.XXXXXX.md)" && jq -r --from-file scripts/renderers/commit.jq --arg stepId "$STEP_ID" "$WORKFLOW" > "$REVIEW_MD"`, ask the operator (Approve / Adjust / Skip / Stop), and loop on Adjust — appending each round to the step's `reviewHistory[]`. Only fire `git commit` after Approve. `rm -f "$REVIEW_MD"` once the loop exits.
3. After `git commit` succeeds, build the audit-trail arrays AND append `STEP_<NN>_COMMIT`:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NN=$(browzer workflow query next-step-id --workflow "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_COMMIT"

# `commit.trailers` is `[...string]` per CUE — an array of formatted
# trailer strings, NOT an array of {key, value} objects. Build it as a
# JSON string array. The on-behalf-of trailer is mandatory and ALWAYS
# the last entry.
TRAILERS_JSON=$(jq -n '[
  "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>",
  "On-Behalf-Of: @browzeremb <274369678+browzeremb@users.noreply.github.com>"
]')

# Build prePushAuditsRun JSON (lightweight string list) from the Phase 8.5
# array (default to []).
PREPUSH_AUDITS_RUN_JSON=$(printf '%s\n' "${PREPUSH_AUDITS_RUN[@]:-}" \
  | jq -R . | jq -s 'map(select(length > 0))')

# Build prePushAudits JSON (structured PrePushAudit[] — name + source +
# exitCode + durationMs per entry). When Phase 8.5 captured per-audit timings
# in $PREPUSH_AUDITS_DETAILED (a bash array of jq-compatible objects), use it
# directly. Otherwise synthesise zero-duration "operator"-source rows from
# $PREPUSH_AUDITS_RUN so the structured field is never empty alongside a
# populated run-list. The schema requires PrePushAudit.name + source +
# exitCode + durationMs; output is omitted when not captured.
if [ "${#PREPUSH_AUDITS_DETAILED[@]:-0}" -gt 0 ]; then
  PREPUSH_AUDITS_JSON=$(printf '%s\n' "${PREPUSH_AUDITS_DETAILED[@]}" \
    | jq -s '.')
else
  PREPUSH_AUDITS_JSON=$(printf '%s\n' "${PREPUSH_AUDITS_RUN[@]:-}" \
    | jq -R . | jq -s '
        map(select(length > 0)
            | { name: ., source: "operator", exitCode: 0, durationMs: 0 })')
fi

# Build pushAttempts JSON via the shared `record_push_attempt` helper. The
# helper handles the bypass-without-reason guard, composes the entry, detects
# re-entry, and returns the resulting array on stdout. Required env vars
# (LEFTHOOK_BYPASSED, NO_VERIFY_PASSED, AMEND_USED, BYPASS_REASON, RETRY_COUNT,
# PREVIOUS_FAILURE, BYPASSED_AUDITS) are read from the caller's shell.
if ! PUSH_ATTEMPTS_JSON=$(record_push_attempt "$STEP_ID" "$SHA"); then
  echo "commit: stopped at $STEP_ID — bypass detected without operator-supplied reason"
  echo "hint: re-invoke with explicit BYPASS_REASON=<why> so the audit trail records why audits were skipped"
  exit 1
fi

STEP=$(jq -n \
  --arg id "$STEP_ID" --arg now "$NOW" \
  --arg sha "$SHA" \
  --arg type "$TYPE" --arg scope "$SCOPE" \
  --arg subject "$SUBJECT" --arg body "$BODY" \
  --argjson trailers "$TRAILERS_JSON" \
  --argjson prePushAuditsRun "$PREPUSH_AUDITS_RUN_JSON" \
  --argjson prePushAudits "$PREPUSH_AUDITS_JSON" \
  --argjson pushAttempts "$PUSH_ATTEMPTS_JSON" \
  '{
     stepId: $id, name: "COMMIT", status: "COMPLETED",
     applicability: { applicable: true, reason: "final commit" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0, itDependsOn: [], nextStep: "",
     skillsToInvoke: ["commit"], skillsInvoked: ["commit"],
     owner: null, worktrees: { used: false, worktrees: [] },
     warnings: [], reviewHistory: [], dispatches: [],
     commit: { sha: $sha, conventionalType: $type, scope: $scope,
               subject: $subject, body: $body, trailers: $trailers,
               prePushAuditsRun: $prePushAuditsRun,
               prePushAudits: $prePushAudits,
               pushAttempts: $pushAttempts }
   }')

echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

`workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

### Banned diagnostic patterns

Same list as `../feature-acceptance/references/verdict-and-actions.md` §"Banned diagnostic patterns" — `--help` and `describe-step-type` are CLI-debug helpers, banned on production orchestrator runs.

When no feat dir is detectable, skip this entirely — the standalone `git commit` works unchanged.

## Pending-SHA placeholder (closure entries that reference their own commit)

When a staged file (typically a CHANGELOG entry written by `update-docs`) needs to reference its own commit's SHA, that SHA can't exist before `git commit` runs — chicken-and-egg. The historical fix was `git commit --amend --no-edit --no-verify` to backfill the placeholder; that path produces inconsistent SHAs across the audit trail (the CHANGELOG ends up referencing a SHA that exists only in `git reflog` after a rebase) and bypasses commit hooks.

**Default: two-commit pattern.** The feature commit lands first with the `**Commits**: pending — implementing branch <branch-name>` placeholder intact. Then a follow-up `docs(changelog): backfill <short-sha>` commit replaces every `pending` placeholder with the actual short SHA. Both commits are real, both run hooks, both survive rebases as themselves.

> **Mid-flow audit** — between the feature commit and the backfill commit, anyone reading
> `docs/CHANGELOG.md` will see the literal string `pending` (or `<integration-commit>` in older
> templates) where the SHA will land. Operators / reviewers / CI scripts that watch the
> CHANGELOG mid-flow can detect "in-flight" entries with:
>
> ```bash
> grep -nE 'Commits.*pending|<integration-commit>' docs/CHANGELOG.md
> ```
>
> A non-empty result means the backfill commit hasn't landed yet — wait for it before judging
> the entry stale. A non-empty result that survives past `commit` Phase 4 (`hint:` non-zero
> exit) is a regression: the backfill failed and someone needs to run the Phase 2 sed loop
> manually.

**Replace with the fixture-backed `scripts/backfill-pending-sha.mjs`, NEVER raw sed.** The
historical `sed -i.bak -E "s|\*\*Commits\*\*: pending[^\\n]*|...|"` pattern mangles trailing
prose because `[^\n]*` is not a valid sed character class on every platform AND because the
placeholder line typically includes backticks + branch name as a suffix that the regex
over-consumes. The script parses markdown line-by-line, captures `prefix + pending + …`,
and rewrites only the value — preserving trailing prose verbatim:

```bash
# Phase 1 — the feature commit (already done by the heredoc above; SHA captured here):
SHA=$(git rev-parse HEAD); SHORT=${SHA:0:8}

# Phase 2 — backfill follow-up only when placeholders exist in the just-landed commit:
PLACEHOLDER_FILES=$(git show --name-only --pretty=format: HEAD | xargs grep -l "Commits.*pending" 2>/dev/null)
if [ -n "$PLACEHOLDER_FILES" ]; then
  BACKFILL="${CLAUDE_SKILL_DIR}/scripts/backfill-pending-sha.mjs"

  # Dry-run pass first: surface counts before any destructive write.
  for f in $PLACEHOLDER_FILES; do
    node "$BACKFILL" --file "$f" --sha "$SHORT" --mode dry-run
  done

  # Apply pass.
  for f in $PLACEHOLDER_FILES; do
    node "$BACKFILL" --file "$f" --sha "$SHORT" --mode apply
  done

  git add $PLACEHOLDER_FILES
  git commit -m "$(cat <<EOF
docs(changelog): backfill $SHORT

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
EOF
)"
  BACKFILL_SHA=$(git rev-parse HEAD)
fi
```

A line like `- **Commits**: pending — implementing branch \`main\`.` rewrites cleanly to
`- **Commits**: \`abcd1234\`. — implementing branch \`main\`.`. The dry-run pass surfaces
the count of edits per file BEFORE the destructive write, so a malformed pattern never
silently corrupts files. Inline `sed` and inline `node -e` patterns are forbidden — both
lack fixture coverage; the `.mjs` is exercised by the audit suite on every CI run.

Operators can opt out with `--no-pending-amend` in args (preserves the placeholder, no follow-up commit).

**Legacy amend mode** is available behind `--legacy-amend-pending` for cases where a single commit is required (e.g. branch protection enforcing single-commit PRs):

```bash
git commit --amend --no-edit
SHA=$(git rev-parse HEAD)
```

Even in legacy mode, do NOT pass `--no-verify` — hook failures are signal. If hooks block the amend, fix the underlying issue.

## Phase 8.7 — pushAttempts[] audit trail (re-entry tracking)

When the operator re-invokes `commit` after a STOP / PAUSED_PENDING_OPERATOR — typically
because Phase 8.5 caught a pre-push audit and the operator either fixed-and-retried OR
explicitly bypassed it (`LEFTHOOK=0 git push`, `--no-verify`, `git commit --amend`) — the
new commit step MUST capture the attempt history so the audit trail does not diverge from
"what actually shipped".

Append to `commit.pushAttempts[]` on every re-entry:

```jsonc
"pushAttempts": [
  {
    "sha": "<short-sha>",                          // SHA that resulted from this attempt
    "attemptedAt": "<ISO>",
    "lefthookBypassed": false,                     // true when LEFTHOOK=0 was set
    "noVerifyPassed":   false,                     // true when --no-verify was passed
    "amendUsed":        false,                     // true when --amend was used
    "bypassedAudits":   ["<audit-name>", ...],     // names of audits the bypass skipped
    "bypassReason":     "<one-line operator reason>",  // mandatory when any bypass flag is true
    "retryCount":       0,                         // 0 on first attempt; +=1 per re-entry
    "previousFailure":  "<one-line trace from the failed prior attempt>" | null
  }
]
```

When any of `lefthookBypassed | noVerifyPassed | amendUsed` is true AND `bypassReason` is
empty, the skill MUST stop with hint:

```
commit: stopped at STEP_<NN>_COMMIT — bypass detected without operator-supplied reason
hint: re-invoke with explicit "bypassReason: <why>" so the audit trail records why audits were skipped
```

This guard prevents silent bypass — every shortcut leaves a paper trail. The Phase 8.5 audit
pass and the Phase 8.7 attempt log together close the gap where "skill claims commit
shipped" diverges from "operator hand-fought 5 push attempts past the local hooks".

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
