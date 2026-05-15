# Diff discovery — merge-base resolution

`code-review` operates against the diff between the feature branch and
its merge-base with the main branch. Resolving the merge-base correctly is
load-bearing — running against `HEAD~1..HEAD` gives a single-commit slice
even when the feature spans 5 commits, missing 80% of the changed surface.

---

## Resolution order

```bash
# 1. Resolve main branch name (most repos call it `main`; some still `master`)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null \
  | sed 's|^origin/||' \
  || git for-each-ref --format='%(refname:short)' refs/heads/main refs/heads/master 2>/dev/null | head -1 \
  || echo "main")

# 2. Compute merge-base
DIFF_BASE=$(git merge-base HEAD "$MAIN_BRANCH" 2>/dev/null)

# 3. Sanity check — feature branch must have diverged
if [ -z "$DIFF_BASE" ]; then
  echo "ERROR: cannot resolve merge-base of HEAD with $MAIN_BRANCH"
  exit 1
fi

if [ "$DIFF_BASE" = "$(git rev-parse HEAD)" ]; then
  echo "ERROR: HEAD == merge-base — no commits to review"
  exit 1
fi
```

---

## Multi-commit branch handling

For features spanning N commits, the diff is `DIFF_BASE..HEAD` and
captures the cumulative change. This is the correct surface for review:
intermediate commits may have been refactored / squashed / fixed up
during development.

```bash
# Captured by render-review-context.mjs
git diff --name-only "$DIFF_BASE..HEAD"
git diff --numstat "$DIFF_BASE..HEAD"
git diff --stat "$DIFF_BASE..HEAD" > /tmp/review-diff-stat.txt
```

---

## Worktree / detached-HEAD edge case

When the operator runs `/code-review` from a worktree or a detached HEAD
state, `HEAD` may not correspond to a named branch. The resolution above
still works (merge-base of the commit graph, not the branch name), but
the `MAIN_BRANCH` detection may fall back to the `main` default. The
renderer surfaces both `DIFF_BASE` SHA and the resolved `MAIN_BRANCH`
name in REVIEW_CONTEXT.md frontmatter so the operator can verify.

---

## `failed.md` halt rule

Before any review work begins, the skill globs
`docs/browzer/<feat>/staging/tasks/TASK_*.failed.md`. Any match HALTS code-review with
a nudge:

> code-review: cannot review — N task(s) failed. Triage each and re-run
> `/execute-task <feat> <taskId>` before retrying code-review.
> Failed: TASK_03.failed.md, TASK_07.failed.md

Rationale: reviewing partial work produces false-positive findings about
half-finished code. Operator must fix or explicitly accept failures.

---

## prdSha drift halt rule

Before any review work begins, the skill computes
`git hash-object docs/browzer/<feat>/staging/PRD.md` and compares it against the
`prdSha` field in every consumed `TASK_*.completed.md`. Mismatch HALTS:

> code-review: PRD.md was edited after task execution (sha drift). Re-run
> `/scope-feature <feat>` and `/generate-task <feat>` before retrying
> code-review. Drift evidence: TASK_03 carries prdSha=abc123, current
> PRD.md is def456.
