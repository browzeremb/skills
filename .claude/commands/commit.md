---
name: commit
description: "Write a Conventional Commits v1.0.0 message mirroring the repo's last 5 commits, stamp the `Co-authored-by: browzeremb` trailer, and run `git commit`. Reports the SHA. Does NOT push. Use whenever the user wants to commit staged changes. Triggers: commit, commit this, save this, checkpoint, finish this task, ship this commit, write a commit message, conventional commit."
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(git *), Bash(jq *), Bash(mv *), Bash(date *), Bash(sed *), Bash(grep *), Bash(xargs *), Bash(rm *), Bash(source *), Bash(node *), Bash(lefthook *), Bash(yq *), Bash(bash *), Bash(command *)
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
| Atomic jq helpers (seed_step, complete_step, clarification_audit) | `references/jq-helpers.sh` |
| Pending-SHA two-commit pattern | §Pending-SHA placeholder below |
| Workflow step shapes | `references/workflow-schema.md` |

```bash
source references/jq-helpers.sh   # optional; only needed when workflow.json is present
```

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

## Phase 8.5 — Pre-push audit simulation (BEFORE git commit)

Run BEFORE `git commit` fires. Detects the project's local pre-push gates and simulates them
in-place so the commit step catches the same audits that would otherwise block the operator's
subsequent `git push`. Skips gracefully when no gate exists.

```bash
PREPUSH_FAILED=()
PREPUSH_AUDITS_RUN=()

# 1. Lefthook (most common in JS/TS monorepos using @evilmartians/lefthook)
if command -v lefthook >/dev/null 2>&1 && [ -f lefthook.yml -o -f lefthook.yaml ]; then
  # Enumerate pre-push command names
  CMDS=$(yq -r '.pre-push.commands | keys[]' lefthook.yml lefthook.yaml 2>/dev/null)
  for CMD in $CMDS; do
    PREPUSH_AUDITS_RUN+=("lefthook:$CMD")
    if ! lefthook run pre-push --commands "$CMD" >/dev/null 2>&1; then
      PREPUSH_FAILED+=("lefthook:$CMD")
    fi
  done
fi

# 2. Husky (npm convention)
if [ -f .husky/pre-push ]; then
  PREPUSH_AUDITS_RUN+=("husky:pre-push")
  if ! bash .husky/pre-push >/dev/null 2>&1; then
    PREPUSH_FAILED+=("husky:pre-push")
  fi
fi

# 3. Raw git hook (rare; usually managed by lefthook/husky but can exist standalone)
if [ -x .git/hooks/pre-push ] && [ ! -f lefthook.yml ] && [ ! -f .husky/pre-push ]; then
  PREPUSH_AUDITS_RUN+=("git:pre-push")
  if ! .git/hooks/pre-push >/dev/null 2>&1; then
    PREPUSH_FAILED+=("git:pre-push")
  fi
fi

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
2. If `review`, render the proposed message via `jq -r --from-file references/renderers/commit.jq --arg stepId "$STEP_ID" "$WORKFLOW" > /tmp/review-$STEP_ID.md`, ask the operator (Approve / Adjust / Skip / Stop), and loop on Adjust — appending each round to the step's `reviewHistory[]`. Only fire `git commit` after Approve.
3. After `git commit` succeeds, build the audit-trail arrays AND append `STEP_<NN>_COMMIT`:

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NN=$(jq '([.steps[].stepId | capture("STEP_(?<n>[0-9]+)_").n | tonumber] | (max // 0) + 1)' "$WORKFLOW")
STEP_ID="STEP_$(printf '%02d' $NN)_COMMIT"

# Build prePushAuditsRun JSON from the Phase 8.5 array (default to []).
PREPUSH_AUDITS_RUN_JSON=$(printf '%s\n' "${PREPUSH_AUDITS_RUN[@]:-}" \
  | jq -R . | jq -s 'map(select(length > 0))')

# Build pushAttempts JSON. Compose ONE entry per skill invocation.
LEFTHOOK_BYPASSED=${LEFTHOOK_BYPASSED:-false}
NO_VERIFY_PASSED=${NO_VERIFY_PASSED:-false}
AMEND_USED=${AMEND_USED:-false}
BYPASS_REASON="${BYPASS_REASON:-}"
RETRY_COUNT=${RETRY_COUNT:-0}
PREVIOUS_FAILURE="${PREVIOUS_FAILURE:-}"
BYPASSED_AUDITS_JSON=$(printf '%s\n' "${BYPASSED_AUDITS[@]:-}" \
  | jq -R . | jq -s 'map(select(length > 0))')

# Phase 8.7 guard — any bypass without operator-supplied reason halts the skill.
if { [ "$LEFTHOOK_BYPASSED" = "true" ] || [ "$NO_VERIFY_PASSED" = "true" ] || [ "$AMEND_USED" = "true" ]; } \
   && [ -z "$BYPASS_REASON" ]; then
  echo "commit: stopped at $STEP_ID — bypass detected without operator-supplied reason"
  echo "hint: re-invoke with explicit BYPASS_REASON=<why> so the audit trail records why audits were skipped"
  exit 1
fi

ATTEMPT_ENTRY=$(jq -n \
  --arg sha "$SHA" --arg now "$NOW" \
  --argjson lefthookBypassed "$LEFTHOOK_BYPASSED" \
  --argjson noVerifyPassed   "$NO_VERIFY_PASSED" \
  --argjson amendUsed        "$AMEND_USED" \
  --argjson bypassedAudits   "$BYPASSED_AUDITS_JSON" \
  --arg bypassReason         "$BYPASS_REASON" \
  --argjson retryCount       "$RETRY_COUNT" \
  --arg previousFailure      "$PREVIOUS_FAILURE" \
  '{ sha: $sha, attemptedAt: $now,
     lefthookBypassed: $lefthookBypassed,
     noVerifyPassed:   $noVerifyPassed,
     amendUsed:        $amendUsed,
     bypassedAudits:   $bypassedAudits,
     bypassReason:     (if $bypassReason == "" then null else $bypassReason end),
     retryCount:       $retryCount,
     previousFailure:  (if $previousFailure == "" then null else $previousFailure end) }')

# Re-entry detection: when a prior STEP_<NN>_COMMIT exists for this feat, append
# to its pushAttempts[] instead of starting fresh. (See workflow-schema §5.4.)
PRIOR=$(jq -r '[.steps[] | select(.name=="COMMIT")][-1] // empty' "$WORKFLOW")
if [ -n "$PRIOR" ]; then
  PRIOR_ATTEMPTS=$(echo "$PRIOR" | jq '.commit.pushAttempts // []')
  PUSH_ATTEMPTS_JSON=$(echo "$PRIOR_ATTEMPTS" | jq --argjson e "$ATTEMPT_ENTRY" '. + [$e]')
else
  PUSH_ATTEMPTS_JSON=$(jq -n --argjson e "$ATTEMPT_ENTRY" '[$e]')
fi

STEP=$(jq -n \
  --arg id "$STEP_ID" --arg now "$NOW" \
  --arg sha "$SHA" \
  --arg type "$TYPE" --arg scope "$SCOPE" \
  --arg subject "$SUBJECT" --arg body "$BODY" \
  --argjson trailers "$TRAILERS_JSON" \
  --argjson prePushAuditsRun "$PREPUSH_AUDITS_RUN_JSON" \
  --argjson pushAttempts "$PUSH_ATTEMPTS_JSON" \
  '{
     stepId: $id, name: "COMMIT", status: "COMPLETED",
     applicability: { applicable: true, reason: "final commit" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0, itDependsOn: [], nextStep: null,
     skillsToInvoke: ["commit"], skillsInvoked: ["commit"],
     owner: null, worktrees: { used: false, worktrees: [] },
     warnings: [], reviewHistory: [],
     commit: { sha: $sha, conventionalType: $type, scope: $scope,
               subject: $subject, body: $body, trailers: $trailers,
               prePushAuditsRun: $prePushAuditsRun,
               pushAttempts: $pushAttempts }
   }')

echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

`workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

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

**Replace with structured-replace, NEVER raw sed.** The historical `sed -i.bak -E
"s|\*\*Commits\*\*: pending[^\\n]*|...|"` pattern mangles trailing prose because `[^\n]*` is
not a valid sed character class on every platform AND because the placeholder line typically
includes backticks + branch name as a suffix that the regex over-consumes. Use a Node script
that parses the markdown line-by-line, finds the in-flight `**Commits**: pending` value
under the just-edited CHANGELOG entry, and rewrites only the value:

```bash
# Phase 1 — the feature commit (already done by the heredoc above; SHA captured here):
SHA=$(git rev-parse HEAD); SHORT=${SHA:0:8}

# Phase 2 — backfill follow-up only when placeholders exist in the just-landed commit:
PLACEHOLDER_FILES=$(git show --name-only --pretty=format: HEAD | xargs grep -l "Commits.*pending" 2>/dev/null)
if [ -n "$PLACEHOLDER_FILES" ]; then
  # Single-source backfill script (mode = "dry-run" prints counts; mode = "apply" writes).
  BACKFILL_SCRIPT=$(cat <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [, , file, sha, mode] = process.argv;
const lines = readFileSync(file, 'utf8').split('\n');
let edits = 0;
const next = lines.map(line => {
  // Capture: prefix + 'pending' + (consumed remainder up to '.') + period + trailing prose.
  // Preserves trailing prose so '— implementing branch `main`.' remains intact.
  const m = line.match(/^(\s*-?\s*\*\*Commits\*\*:\s*)pending([^.\n]*)(\.?)(\s*.*)$/);
  if (!m) return line;
  edits++;
  const [, prefix, , period, trailing] = m;
  return prefix + '`' + sha + '`' + (period || '.') + trailing;
});
if (mode === 'apply') {
  writeFileSync(file, next.join('\n'));
  console.log(file + ': ' + edits + ' edit(s) applied');
} else {
  console.log(file + ': ' + edits + ' edit(s) staged');
}
JS
)

  # Dry-run pass first: surface counts before any destructive write.
  for f in $PLACEHOLDER_FILES; do
    node --input-type=module -e "$BACKFILL_SCRIPT" -- "$f" "$SHORT" "dry-run"
  done

  # Apply pass.
  for f in $PLACEHOLDER_FILES; do
    node --input-type=module -e "$BACKFILL_SCRIPT" -- "$f" "$SHORT" "apply"
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

The captured groups (`prefix`, `trailing`) preserve everything around the value, so a line
like `- **Commits**: pending — implementing branch \`main\`.` rewrites cleanly to
`- **Commits**: \`abcd1234\`. — implementing branch \`main\`.` (or you can drop the trailing
prose intentionally by ignoring `trailing`). The dry-run pass surfaces the count of edits
per file BEFORE the destructive write, so a malformed regex never silently corrupts files.

`fixture-backed sed alternative` — when Node is not available on PATH (rare for repos that
ship a Node toolchain anyway), keep a small shell fixture in `scripts/` that the audit suite
exercises on every CI run, and call into it instead. Inline `sed` patterns in this skill are
forbidden because they have no fixture coverage.

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
