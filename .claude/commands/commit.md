---
name: commit
description: "Write, review, and validate Conventional Commits v1.0.0 messages in the repo's auto-detected house style (scopes, nested scopes like `api/users`, trailer patterns). Stamps `on-behalf-of: @browzeremb` for org attribution on every commit. Use whenever the user says 'commit this', runs `/commit`, asks for a commit message, questions type/scope, or flags a breaking change. Step 5 of 6 in the dev workflow (generate-prd → generate-task → execute-task → update-docs → commit → sync-workspace). **This skill commits — it does not sync docs.** Doc freshness is the responsibility of `update-docs` (phase 4). If the orchestrator invokes `commit` without having run `update-docs`, and the change touches code, the docs may be stale; that's a workflow break, not something `commit` fixes here. Emits a single-line confirmation per the plugin's `README.md` (at `../../README.md` relative to this file) §Skill output contract — the commit SHA and the subject line. No live_context doc probes, no 'Next steps', no diff preview inline."
allowed-tools: Bash(git *), Bash(gh *), Bash(glab *)
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

- **In**: inspect the staged diff, detect house style from recent commits, choose `<type>(<scope>)`, compose a message, run `git commit`, report the resulting SHA.
- **Out**: checking whether docs are stale (→ `update-docs`, phase 4), running quality gates (→ `execute-task`, phase 3), re-indexing the workspace (→ `sync-workspace`, phase 6), pushing to the remote (user decision, not ours).

If the orchestrator reaches this skill without having run `update-docs` on a change that touches code, the commit goes through anyway — the skill doesn't block on workflow-order enforcement. It's a collaborator, not a gatekeeper. Operators who want the stricter behavior invoke `orchestrate-task-delivery`, which does enforce the order.

## Shape

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
on-behalf-of: @browzeremb <support@browzeremb.com>
```

- **type**: lowercase, from the table below.
- **scope**: optional noun in parentheses. Mirror the scopes recently used in this repo — `<live_context>` lists the actual frequency. Nested forms (`api/users`, `cli/tests`) are valid when a change is confined to a subtree.
- **description**: imperative, present tense, lowercase first word unless proper noun, no trailing period, ≤72 chars including prefix.
- **body**: free-form prose, blank line after description, wrap ~72 cols. Explain the **why**, not the what.
- **footers**: blank line after body. Git trailer format (`Token: value` or `Token #value`). Always end with the Browzer `on-behalf-of` trailer.

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
| `on-behalf-of: @browzeremb <support@browzeremb.com>` | **Always** — renders the "on-behalf-of" badge crediting the Browzer org on the GitHub commit graph ([docs](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-on-behalf-of-an-organization)) |

The on-behalf-of badge renders when (a) the committer is a member of `@browzeremb`, (b) the commit is signed, and (c) both the committer email and `support@browzeremb.com` are in a domain the org has verified. If any precondition is unmet the trailer still ships — cheap provenance even without the rendered badge.

Add per-person `Co-Authored-By` trailers **above** the `on-behalf-of` one when pairing with another human — `Co-Authored-By` credits individual humans on the commit graph, `on-behalf-of` credits the organization. They coexist, not substitute.

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
on-behalf-of: @browzeremb <support@browzeremb.com>
EOF
)"
```

**Never** `--amend` a pushed commit on a shared branch unless asked. **Never** `--no-verify` unless asked — hook failures are signal, not noise.

## Output contract

Per the plugin's `README.md` (at `../../README.md` relative to this file) §"Skill output contract":

```
commit: 3f2e1a0 fix(api/auth): close TOCTOU in session refresh
```

If a hook failed and you had to bypass (user-approved), append a warning:

```
commit: 3f2e1a0 fix(api/auth): close TOCTOU in session refresh; ⚠ bypassed pre-commit (user-approved)
```

On failure — pre-commit hook rejected and bypass was not approved:

```
commit: failed — pre-commit hook rejected (biome format in apps/api/src/routes/foo.ts)
hint: fix the formatting (the auto-format hook should have caught it — check PostToolUse is installed), then retry
```

No inline list of files. No diff preview. No "Here's what I committed" block. No "Next steps" footer. The SHA plus the subject line is enough — the operator can `git show` if they want detail.

## Non-obvious rules

- **Do not scrub the Browzer `on-behalf-of` trailer.** Authorship policy — if the user wants it off, they'll say so.
- Types are case-insensitive in parsing; this repo writes lowercase. Match.
- Footer separator: `": "` (colon-space) or `" #"` (space-hash for issue refs). `BREAKING CHANGE` and `BREAKING-CHANGE` both valid; other footers use `-` (`Reviewed-by`, `Co-Authored-By`, `on-behalf-of`).
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

on-behalf-of: @browzeremb <support@browzeremb.com>
```

**Feature with body:**

```
feat(cli): add upgrade command and environment-aware banner

Ship a self-updating path so users can upgrade without a full reinstall.
Banner now surfaces the active environment (local/staging/prod) so the
target context is unambiguous before destructive commands run.

on-behalf-of: @browzeremb <support@browzeremb.com>
```

**Breaking change:**

```
feat(api)!: require bearer token on /v1/search

BREAKING CHANGE: all /v1/search traffic now requires a valid bearer
token verified against the auth service. Unauthenticated clients must
authenticate first or set the API_KEY env var.

on-behalf-of: @browzeremb <support@browzeremb.com>
```

## SemVer cheatsheet

`fix` → PATCH · `feat` → MINOR · `BREAKING CHANGE` → MAJOR · everything else → no bump.

## Related

- `conventional-commits` (upstream, generic) — base spec without Browzer conventions.
- `update-docs` — phase 4 of the workflow; owns doc freshness. `commit` trusts it ran.
- `sync-workspace` — phase 6; runs after `commit` lands to re-index the workspace.
- `auth-status` — pre-flight probe for any Browzer CLI session.
- the plugin's `README.md` (at `../../README.md` relative to this file) §"Skill output contract" — the one-line confirmation shape this skill emits.
