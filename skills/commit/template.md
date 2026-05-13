# Commit template

The `commit` skill is **terminal** — it produces a git commit, not a
markdown artefact. Its only `.md` interaction is appending the
`## commit` section to `docs/browzer/<feat>/staging/RECEIPTS.md` (when feature
context is present).

This template describes the canonical Conventional Commits message
shape the skill emits.

---

## Conventional Commits v1.0.0 shape

```
<type>[optional scope][!]: <description>

[optional body — explain WHY, wrap ~72 cols]

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
```

### Type enum

`feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert`

### Constraints

- Lowercase types.
- Scope: lowercase noun matching the host's commit log granularity. Nested forms (`api/users`) valid for subtree-scoped changes.
- Subject: imperative ("add", not "added" or "adds"), no trailing period, ≤72 chars including the prefix.
- Breaking: `!` after type/scope AND/OR `BREAKING CHANGE:` footer.
- `on-behalf-of:` trailer is unconditional — credits the org per GitHub's organization-commit convention. Always last line. Format: `on-behalf-of: @<handle> <email>`.
- Do NOT use `Co-authored-by:` for the organization — that trailer is for human collaborators; orgs link via `on-behalf-of:`.

### SemVer mapping

`feat` → MINOR · `fix` → PATCH · `BREAKING CHANGE` → MAJOR · rest → none.

---

## Feature-mode commit body (when invoked with a featureId)

When the skill is invoked with a `<featureId>` argument, the commit body
includes a structured reference to the README:

```
<type>(<scope>): <subject from README title or operator-supplied>

<summary paragraph copied from docs/browzer/<feat>/staging/README.md ## Summary>

Feature: <featureId>
Verdict: <verdict from ACCEPTANCE.md>
Tasks: <count from RECEIPTS.md generate-task receipt>

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
```

This is the canonical "feature commit" shape. The summary paragraph is
verbatim from `README.md` `## Summary` (already authored by
finalize-feature). The `Feature: / Verdict: / Tasks:` trailer lines
appear ABOVE the `on-behalf-of:` trailer.

---

## Staging-skip rule (paths NOT committed)

When staging files for a feature commit, ALWAYS skip:

- `docs/browzer/**/staging/**` — legacy workflow-era; not present in markdown-chains feats but the rule remains as defence in depth.
- Any path matching `.browzer/**` (workspace-internal state).

The paths IN `docs/browzer/<feat>/` that ARE committed:

- `PRD.md`, `USER_STORIES.md`, `EXPLORATION.md`, `EXPLORATION_BLAST.mmd`, `TASK_*.completed.md` / `.failed.md`, `TASK_GRAPH.md`
- `CODE_REVIEW.md`, `CODE_REVIEW.<lane>.md`, `REVIEW_CONTEXT.md`, `REGRESSION_RESULTS.md`
- `FIX_F-*.completed.md` / `.tech_debt.md`, `RECEIVING_CODE_REVIEW.md`
- `TESTS.md`, `DOC_PATCHES.md`, `ACCEPTANCE.md`
- `README.md`, `RECEIPTS.md`, `DELEGATION_TRACE.md`, `CONFIG.md`

The skill stages these by enumerating present files (not by `git add -A`)
to avoid accidentally including unrelated working-tree changes.

---

## RECEIPTS.md commit section shape

After the commit succeeds, append `## commit` section per
`${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md`:

```markdown
<!-- receipts:commit:BEGIN -->
## commit

- **Phase**: commit
- **Producer**: commit
- **Generated**: <RFC3339>
- **Run id**: <pid-timestamp>

### Commit

sha: `<full-sha>` · branch: `<branch-name>` · trailer: `on-behalf-of: @browzeremb`

### Files committed

- `<path-1>`
- `<path-2>`
- ...

### Veto checks

| Gate | Pass | Evidence |
| --- | --- | --- |
| ACCEPTANCE.md.verdict == accepted | true | `docs/browzer/<feat>/staging/ACCEPTANCE.md` |
| README.md present | true | `docs/browzer/<feat>/staging/README.md` |
| No .failed.md tasks | true | (none on disk) |
| Pre-push gates pass | true | `<gate-name>: exit 0` |

<!-- receipts:commit:END -->
```

---

## Veto gates (HARD halt)

The skill HALTS before running `git commit` when ANY of:

1. `<featureId>` was passed AND `docs/browzer/<feat>/staging/ACCEPTANCE.md` is missing → "run `/feature-acceptance <feat>` first".
2. `<featureId>` was passed AND `ACCEPTANCE.md.frontmatter.verdict != accepted` → "operator must triage rejected/partial verdict; see ACCEPTANCE.md".
3. `<featureId>` was passed AND `docs/browzer/<feat>/staging/README.md` is missing → "run `/finalize-feature <feat>` first".
4. `<featureId>` was passed AND any `TASK_*.failed.md` exists → "triage failed tasks before commit".
5. The host's pre-push gates fail without operator-supplied `bypassReason` (env var, CLI flag, or `.browzer/skills.config.json#bypassReason`).
