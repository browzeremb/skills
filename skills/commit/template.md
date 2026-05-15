# Commit template

The `commit` skill is **terminal** — it produces a git commit, not a
markdown artefact. This template describes the canonical Conventional
Commits message shape the skill emits.

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

<summary paragraph copied from docs/browzer/<feat>/README.md ## Summary>

Feature: <featureId>
Verdict: <verdict from ACCEPTANCE.md>
Tasks: <count of TASK_*.completed.md present in staging at commit time>

on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>
```

This is the canonical "feature commit" shape. The summary paragraph is
verbatim from `README.md` `## Summary` (already authored by
finalize-feature). The `Feature: / Verdict: / Tasks:` trailer lines
appear ABOVE the `on-behalf-of:` trailer.

---

## Staging-skip rule (paths NOT committed)

When staging files for a feature commit, ALWAYS skip:

- `docs/browzer/**/staging/**` — every phase artefact under `staging/` is gitignored by design (auto-generated `staging/.gitignore` at orchestrator entry). Includes `PRD.md`, `EXPLORATION.md`, `TASK_*.md`, `CODE_REVIEW*.md`, `RECEIVING_CODE_REVIEW.md`, `TESTS.md`, `DOC_PATCHES.md`, `ACCEPTANCE.md`, `BRIEF.md`, `CONFIG.md`, `DELEGATION_TRACE.md`, `FIX_F-*.md`, etc.
- Any path matching `.browzer/**` (workspace-internal state).

The ONLY path inside `docs/browzer/<feat>/` that is committed:

- `docs/browzer/<feat>/README.md` — self-contained feature summary authored by `finalize-feature`. Contains the verdict, the original request, every finding + resolution, every fix log, every tech-debt entry, and every AC verdict flattened in line so the README stands alone without hyperlinks into the gitignored `staging/` tree.

Everything else committed by a feature commit lives OUTSIDE `docs/browzer/<feat>/` (source code changes, host docs that `finalize-feature` patched). The skill stages by enumerating present files (not by `git add -A`) to avoid accidentally including unrelated working-tree changes.

---

## Pre-push gate simulation artifact

Before composing the commit, the skill captures the result of the host
pre-push gate simulation into `<feat>/staging/COMMIT_PREPUSH.md`. The
frontmatter shape for this artifact:

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

**Key descriptions:**

- `simulationRun` — `true` when the gate was invoked in dry-run mode; `false`
  when gate detection found nothing runnable.
- `gatesDetected` — names of all gates the skill found in the host (via
  `.git/hooks/pre-push`, a hook-manager manifest, or the package manifest
  `pre-push`/`prepush` script).
- `gatesPassed` — subset of `gatesDetected` that exited cleanly.
- `gatesBypassed` — gates the operator explicitly overrode via bypass flag.
- `bypassReason` — operator-supplied reason string, or `null` when no bypass
  was applied.

---

## Veto gates (HARD halt)

The skill HALTS before running `git commit` when ANY of:

1. `<featureId>` was passed AND `docs/browzer/<feat>/staging/acceptance/ACCEPTANCE.md` is missing → "run `/feature-acceptance <feat>` first".
2. `<featureId>` was passed AND `ACCEPTANCE.md.frontmatter.verdict != accepted` → "operator must triage rejected/partial verdict; see ACCEPTANCE.md".
3. `<featureId>` was passed AND `docs/browzer/<feat>/README.md` is missing → "run `/finalize-feature <feat>` first".
4. `<featureId>` was passed AND any `TASK_*.failed.md` exists → "triage failed tasks before commit".
5. The host's pre-push gates fail without operator-supplied `bypassReason` (env var, CLI flag, or `.browzer/skills.config.json#bypassReason`).
