---
name: commit
description: "Final phase of the dev workflow (… → update-docs → feature-acceptance → commit). Use whenever the user wants to commit staged changes — 'commit this', 'save this', 'checkpoint', or finish a task. Detects the repo's house style from recent commits (scopes, nested scopes like api/users, trailer patterns) and writes a Conventional Commits v1.0.0 message. Stamps `Co-authored-by: browzeremb` only when the detected house style already uses coauthor trailers (F10 fix). Runs `git commit` and reports the SHA. Appends STEP_<NN>_COMMIT to docs/browzer/<feat>/workflow.json via jq + mv. When config.mode == \"review\", renders commit.jq and loops on operator edits before the actual git commit. Does NOT push, does NOT sync docs. Triggers: 'commit this', 'write a commit message', 'commit what I staged', 'checkpoint', 'save this change', commit type/scope questions."
allowed-tools: Bash(git *), Bash(gh *), Bash(glab *), Bash(jq *), Bash(mv *), Bash(date *), AskUserQuestion
---

<live_context>
**Staged changes (summary):**
!`git diff --cached --stat 2>/dev/null || echo "(nothing staged)"`

**Unstaged changes (summary):**
!`git diff --stat 2>/dev/null || echo "(clean)"`

**Staged diff (first 400 lines):**
!`tmp=$(mktemp); git diff --cached 2>/dev/null > "$tmp"; total=$(wc -l < "$tmp" | tr -d ' '); if [ "$total" = "0" ]; then echo "(nothing staged)"; else head -400 "$tmp"; [ "$total" -gt 400 ] && echo "[diff truncated — showed 400 of $total lines; full diff lives on disk if you need more]"; fi; rm -f "$tmp"`

**Recent commits (house-style reference — mirror this):**
!`git log --oneline -15 2>/dev/null || echo "(no commits yet)"`

**Scopes used in last 50 commits (frequency):**
!`git log -50 --pretty=%s 2>/dev/null | sed -nE 's/^[a-z]+(\(([^)]+)\))?!?:.*/\2/p' | sort | uniq -c | sort -rn | head -20 || true`

**Forge CLI availability:**
!`command -v gh >/dev/null && echo "gh: yes ($(gh --version 2>/dev/null | head -1))" || echo "gh: no"`
!`command -v glab >/dev/null && echo "glab: yes ($(glab --version 2>/dev/null | head -1))" || echo "glab: no"`

**Remote:**
!`git remote get-url origin 2>/dev/null || echo "(no origin)"`
</live_context>

# commit — Conventional Commits, repo-aware

Write a message that (a) matches Conventional Commits v1.0.0, (b) mirrors the active repo's detected house style, and (c) gives Browzer authorship credit via a trailer. Always read `<live_context>` first — it has the staged diff, recent commits, and scopes actually in use. **Do not invent conventions the repo doesn't use.**

## Scope

This skill commits. That's it.

- **In**: inspect the staged diff, detect house style from recent commits, choose `<type>(<scope>)`, compose a message, run `git commit`, report the resulting SHA. When invoked inside a workflow (feat dir detected), also append `STEP_<NN>_COMMIT` to `workflow.json` via `jq | mv`, and honor `config.mode == "review"` by rendering `commit.jq` and looping on operator edits before the actual git commit.
- **Out**: checking whether docs are stale (→ `update-docs`, phase 6), running quality gates (→ `execute-task`, phase 3), re-indexing the workspace (→ `sync-workspace`), pushing to the remote (user decision, not ours), verifying acceptance (→ `feature-acceptance`, phase 7).

If the orchestrator reaches this skill without having run `update-docs` on a change that touches code, the commit goes through anyway — the skill doesn't block on workflow-order enforcement. It's a collaborator, not a gatekeeper. Operators who want the stricter behavior invoke `orchestrate-task-delivery`, which does enforce the order.

## Workflow.json integration

When a feat directory is detectable (either passed in args as `feat dir: <path>` or via the latest `docs/browzer/feat-*/`), the skill:

1. Reads `.config.mode` from `$FEAT_DIR/workflow.json`.
2. If `review`, renders the proposed commit message (subject + body + trailers) and enters the review-gate loop:
   - Render via `jq -r --from-file references/renderers/commit.jq --arg stepId "$STEP_ID" "$WORKFLOW" > /tmp/review-$STEP_ID.md`. In early-stage cases where the step hasn't been appended yet, render the proposed message from a local buffer file instead.
   - `AskUserQuestion`: Approve / Adjust / Skip / Stop.
   - On Adjust, translate operator's natural-language request (e.g. "change scope to cli/tests", "add a line about the security invariant") into an updated subject/body/trailers, re-render, and loop. Append each round to the step's `reviewHistory[]`.
   - Only fire `git commit` after the operator approves.
3. After `git commit` succeeds, append `STEP_<NN>_COMMIT` to `workflow.json` with the `commit` payload per schema §4:

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
     stepId: $id,
     name: "COMMIT",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "final commit" },
     startedAt: $now, completedAt: $now, elapsedMin: 0,
     retryCount: 0,
     itDependsOn: [],
     nextStep: null,
     skillsToInvoke: ["commit"],
     skillsInvoked: ["commit"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     commit: { sha: $sha, conventionalType: $type, scope: $scope,
               subject: $subject, body: $body, trailers: $trailers }
   }')

jq --argjson step "$STEP" \
   --arg now "$NOW" \
   '.steps += [$step]
    | .currentStepId = $step.stepId
    | .totalSteps = (.steps | length)
    | .completedSteps = ([.steps[] | select(.status=="COMPLETED")] | length)
    | .updatedAt = $now' \
   "$WORKFLOW" > "$WORKFLOW.tmp" && mv "$WORKFLOW.tmp" "$WORKFLOW"
```

When no feat dir is detectable (pure standalone git commit), skip the workflow.json update entirely. The skill's core behavior (detecting style + firing `git commit`) works unchanged.

`workflow.json` is mutated ONLY via `jq | mv`. Never with `Read`/`Write`/`Edit`.

## Shape

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
```

- **type**: lowercase, from the table below.
- **scope**: optional noun in parentheses. Mirror the scopes recently used in this repo — `<live_context>` lists the actual frequency. Nested forms (`api/users`, `cli/tests`) are valid when a change is confined to a subtree.
- **description**: imperative, present tense, lowercase first word unless proper noun, no trailing period, ≤72 chars including prefix.
- **body**: free-form prose, blank line after description, wrap ~72 cols. Explain the **why**, not the what.
- **footers**: blank line after body. Git trailer format (`Token: value` or `Token #value`). End with the Browzer `Co-authored-by` trailer **when the detected house style already uses coauthor trailers**; otherwise skip it (or surface a one-line warning) — see the house-style detection block below.

## Types (and SemVer impact)

| Type       | Use for                                         | SemVer |
| ---------- | ----------------------------------------------- | ------ |
| `feat`     | New user-visible capability                     | MINOR  |
| `fix`      | Bug fix                                         | PATCH  |
| `docs`     | Documentation only                              | none   |
| `style`    | Whitespace / formatting (no logic change)       | none   |
| `refactor` | Internal restructure (no behavior change)       | none   |
| `perf`     | Performance improvement                         | none   |
| `test`     | Adding or fixing tests only                     | none   |
| `build`    | Dependencies, tsconfig, turbo.json, Dockerfiles | none   |
| `ci`       | `.github/workflows/*`, CI scripts               | none   |
| `chore`    | Maintenance not fitting above (bumps, renames)  | none   |
| `revert`   | Reverts a prior commit                          | none   |

Any type with `BREAKING CHANGE` → **MAJOR**.

## Breaking changes

Two ways (combine for max signal):

1. **`!` after type/scope** — visible in `git log --oneline`: `feat(api)!: remove deprecated /v1/ask endpoint`
2. **`BREAKING CHANGE:` footer** — when prose is needed:
   ```
   feat(auth): tighten session cookie policy

   BREAKING CHANGE: SESSION_COOKIE_SAMESITE defaults to "strict" — any
   first-party integration that relied on cross-site cookies must now
   proxy through the gateway.
   ```

Token must be uppercase; `BREAKING-CHANGE` (hyphen) is an accepted synonym.

## Choosing a scope

`<live_context>` already lists the scopes used in the last 50 commits with their frequency — that table is the ground truth for **this** repo. Pick from it. General guidance:

- Prefer a scope that names the **bounded surface** the change touches (a workspace package, an app, a module, a layer). Match the granularity of recent commits — if the repo writes `api`, don't write `api/routes`; if it writes `auth/session`, don't collapse to `auth`.
- Nested scopes (`api/users`, `cli/tests`, `runbook/grafana`) are valid when a change is confined to a subtree.
- `.github/workflows/*` → `ci`. `docs/` → type `docs` (or scope `docs/<sub>` for nested doc trees).
- If a change truly spans many areas, **split into multiple commits**. When infeasible (atomic refactor), omit the scope — don't list five scopes on one line.
- If `<live_context>` is empty (fresh repo), infer from the staged paths and keep it short and lowercase.

## Footers

| Footer                                                 | When                                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `Refs: #123` / `Fixes: #123`                           | Link to a GitHub issue                                   |
| `Closes: #123`                                         | Issue auto-closes on merge to default branch             |
| `Reviewed-by: Name <email>`                            | Copy from PR reviewer when squash-merging manually       |
| `BREAKING CHANGE: <prose>`                             | Describe the break (see §Breaking changes)               |
| `Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>` | **When the repo's house style already uses coauthor trailers** — GitHub resolves the ID-based noreply email to the Browzer account and links the commit on the contributor graph ([docs](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)). If the detected house style has zero `Co-authored-by` lines in recent history, prefer to omit (or warn the operator before adding the first one). |

`Co-authored-by` uses the GitHub noreply format `ID+username@users.noreply.github.com` (`274369678` is the Browzer org's GitHub account ID). GitHub resolves this to the account regardless of whether the user has email privacy enabled. No org membership, commit signing, or domain verification required — it just works for any committer.

Add per-person `Co-authored-by` trailers **above** the Browzer one when pairing with another human. Multiple trailers are allowed; each gets its own line with no blank lines between them.

### House-style detection — Co-authored-by trailer

Before composing the message, sample the repo's recent history and decide whether the Browzer trailer matches the house style or would be a first-of-its-kind drift:

```bash
COAUTHOR_HITS=$(git log -50 --pretty=%B 2>/dev/null | grep -c '^Co-authored-by:')
if [ "${COAUTHOR_HITS:-0}" -eq 0 ]; then
  # House style: zero coauthor trailers in last 50 commits.
  # Default: omit the Browzer trailer.
  # If the operator explicitly wants Browzer credit anyway, surface:
  echo "note: this would be the first Co-authored-by trailer in this repo's recent history"
fi
```

Decision matrix:

| `COAUTHOR_HITS` (last 50 commits) | Default action | Override |
| --------------------------------- | -------------- | -------- |
| `0` | Omit the Browzer `Co-authored-by` trailer; surface a one-line note if the operator opted into Browzer credit | Operator can opt in via explicit "add the Browzer coauthor" instruction; record the override in `commit.coauthorOverride: true` |
| `≥ 1` | Append the Browzer `Co-authored-by` trailer (existing behaviour) | None |

This protects repos that don't use coauthor trailers from a one-off style drift while keeping the contributor-graph link in repos that already do. The detection runs on every commit invocation — never cached.


## Forge CLI (`gh` / `glab`)

Use the forge CLI when the task touches forge data (issue titles, PR state, CI status). `<live_context>` already probed availability.

| Task                              | Preferred (gh / glab)                                                   | Fallback                       |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| Look up an issue title            | `gh issue view <n> --json title,url` / `glab issue view <n>`            | `git log --all --grep="#<n>"`  |
| Verify open PR/MR before amending | `gh pr view --json number,state,title` / `glab mr view`                 | manual                         |
| Check CI before committing        | `gh pr checks` or `gh run list -L 1` / `glab ci status`                 | `git log origin/<base>..HEAD`  |
| Create PR/MR                      | `gh pr create --fill` / `glab mr create --fill`                         | push + open browser manually   |

If neither CLI is installed and the task needs forge data, commit anyway with plain git and note in the confirmation which metadata couldn't be verified. **Don't block a commit on a missing CLI.**

## The commit command

Always pass message via here-doc so multi-line bodies survive shell quoting:

```bash
git commit -m "$(cat <<'EOF'
feat(web): add /docs page covering API, CLI, and SDK reference

Consolidates reference material previously scattered across the repo
into a single discoverable surface. Keeps existing deep links working
so external embeds don't break.

Refs: #42
Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
EOF
)"
```

**Never** `--amend` a pushed commit on a shared branch unless asked. **Never** `--no-verify` unless asked — hook failures are signal, not noise.

## Pending-SHA placeholder pattern (closure entries that reference their own commit)

When the staged diff includes a CHANGELOG / closure / decision-log entry that should reference the **commit being made right now** (chicken-and-egg: the SHA does not exist until after `git commit` succeeds), the convention is:

1. Author the closure entry with a placeholder line like `**Commits**: pending — see commit SHA after merge.` or `**Commits**: pending — implementing branch <branch>.`
2. Run `git commit` — capture the resulting SHA.
3. **Auto-amend** to backfill the SHA before reporting success:

   ```bash
   SHA=$(git rev-parse HEAD)
   SHORT=${SHA:0:8}

   # Find files in the just-committed diff that contain the placeholder.
   PLACEHOLDER_FILES=$(git show --name-only --pretty=format: HEAD | xargs grep -l "Commits.*pending" 2>/dev/null)

   if [ -n "$PLACEHOLDER_FILES" ]; then
     for f in $PLACEHOLDER_FILES; do
       sed -i.bak -E "s|\\*\\*Commits\\*\\*: pending[^\\n]*|**Commits**: \`$SHORT\`|" "$f" && rm -f "$f.bak"
     done
     git add $PLACEHOLDER_FILES
     git commit --amend --no-edit --no-verify
     SHA=$(git rev-parse HEAD)  # SHA changes after amend
   fi
   ```

4. Record the original-and-final SHA in `commit.amendSha` if amended; the reported confirmation line uses the **post-amend** SHA.

The skill detects the placeholder with the regex `\*\*Commits\*\*:\s*pending` (case-insensitive). Operators who don't want auto-amend can include `--no-pending-amend` in invocation args; the skill then leaves the placeholder and prints a one-line warning so the operator can backfill manually.

## Output contract

Emit a single confirmation line:

Workflow-aware (feat dir detected):

```
commit: updated workflow.json <STEP_ID>; status COMPLETED; SHA <sha>
```

Standalone (no feat dir):

```
commit: <sha> <type>(<scope>): <subject>
```

Examples:

```
commit: updated workflow.json STEP_09_COMMIT; status COMPLETED; SHA 3f2e1a0
commit: 3f2e1a0 fix(api/auth): close TOCTOU in session refresh
```

If a hook failed and you had to bypass (user-approved), append a warning:

```
commit: 3f2e1a0 fix(api/auth): close TOCTOU in session refresh; ⚠ bypassed pre-commit (user-approved)
```

On failure — pre-commit hook rejected and bypass was not approved:

```
commit: stopped — pre-commit hook rejected (formatter rejected <path>)
hint: fix the formatting (the auto-format hook should have caught it — check PostToolUse is installed), then retry
```

No inline list of files. No diff preview. No "Here's what I committed" block. No "Next steps" footer.

## Non-obvious rules

- **Do not scrub the Browzer `Co-authored-by` trailer.** Authorship policy — if the user wants it off, they'll say so.
- Types are case-insensitive in parsing; this repo writes lowercase. Match.
- Footer separator: `": "` (colon-space) or `" #"` (space-hash for issue refs). `BREAKING CHANGE` and `BREAKING-CHANGE` both valid; other footers use `-` (`Reviewed-by`, `Co-authored-by`).
- When a change fits two types, **split the commit** (`git add -p`) — don't force a lossy type.
- Subject ≤72 chars is strong preference, not hard rule. 80 OK if extra is real signal.
- Wrong type after push? Propose interactive rebase, but don't run `git rebase -i` — Claude Code can't drive interactive editors. Write replacement message and let the user run rebase.

## Choosing the type

```
New user-facing capability?                   → feat
Fixing incorrect behavior?                    → fix
Reverting a previous commit?                  → revert
Docs / comments / README only?                → docs
Improving speed, memory, latency?             → perf
Restructure, no behavior change?              → refactor
Adding or fixing tests only?                  → test
.github/workflows/*, CI pipeline?             → ci
Dependencies, Dockerfile, tsconfig, turbo?    → build
Pure whitespace / formatting?                 → style
Anything else (bumps, renames, housekeeping)? → chore
```

## Examples

**Simple fix, nested scope:**

```
fix(api/users): return [] instead of null for empty user lists

Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
```

**Feature with body:**

```
feat(cli): add upgrade command and environment-aware banner

Ship a self-updating path so users can upgrade without a full reinstall.
Banner now surfaces the active environment (local/staging/prod) so the
target context is unambiguous before destructive commands run.

Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
```

**Breaking change:**

```
feat(api)!: require bearer token on /v1/search

BREAKING CHANGE: all /v1/search traffic now requires a valid bearer
token verified against the auth service. Unauthenticated clients must
authenticate first or set the API_KEY env var.

Co-authored-by: browzeremb <274369678+browzeremb@users.noreply.github.com>
```

## SemVer cheatsheet

`fix` → PATCH · `feat` → MINOR · `BREAKING CHANGE` → MAJOR · everything else → no bump.

## Related

- `conventional-commits` (upstream, generic) — base spec without Browzer conventions.
- `update-docs` — phase 4 of the workflow; owns doc freshness. `commit` trusts it ran.
- `sync-workspace` — phase 6; runs after `commit` lands to re-index the workspace.
- `auth-status` — pre-flight probe for any Browzer CLI session.
- The skill's output contract is a single confirmation line. Don't print recaps, file dumps, or 'Next steps' blocks; the artefact is the receipt.
