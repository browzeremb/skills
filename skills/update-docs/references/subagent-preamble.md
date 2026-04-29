# Subagent preamble — index

Three role-specific preambles live in `references/preambles/`. Dispatchers paste the appropriate one verbatim. The subagent runs in a separate session and cannot resolve plugin-relative paths — paste content, do not pass a path.

| Role | Preamble | Consumed by |
| ---- | -------- | ----------- |
| Implementation agent | `preambles/code-subagent.md` | `execute-task`, `receiving-code-review`, `write-tests` |
| Review agent | `preambles/review-subagent.md` | `code-review` reviewers (senior-engineer, software-architect, qa, regression-tester, domain specialists) |
| Truncation recovery | `preambles/truncation-recovery.md` | Embedded conditionally for high-risk dispatches (large file sets, multi-package refactors) |

---

## Universal: Browzer first, training data last

Two protocols — both mandatory when applicable.

### A. Blast-radius probe (run BEFORE modifying any pre-existing file in scope)

```bash
for F in $FILES_IN_SCOPE; do
  browzer deps "$F" --reverse --json --save "/tmp/rdeps-$(echo "$F" | tr '/' '_').json"
done
```

`deps --reverse` returns the file's reverse importers — the blast radius. Tests that exercise the file directly or transitively live here. Touching a refactor without consulting the blast radius is precisely the failure that lets pre-push-gate breakage slip past code-review (regression-tester needs this for its `--filter='...[origin/main]'` package selection; review lanes need it to reason about butterfly-effect risk; update-docs needs it to find docs that cite the changed surface). Both forward (`browzer deps`) and reverse (`browzer deps --reverse`) are cheap; run both for any non-trivial file.

### B. Library / framework / config-syntax lookup

For every library / framework / config syntax you touch in this repo:

1. `browzer search "<topic>" --save /tmp/search.json` — project's own doc corpus, authoritative for this version.
2. `browzer explore "<symbol or concern>"` — repo's own code, authoritative for "how we do X here".
3. Context7 (if installed and browzer returned nothing) — third-party library docs pinned to the project's version.
4. Training data — last resort; note "assumed from training data, not verified" in `scopeAdjustments`.

---

## Mandatory: stamp `startedAt` BEFORE the work begins

The first jq mutation on a step MUST set `startedAt`. Stamping it only at completion makes `elapsedMin` always 0 and corrupts retro-analysis. Full timing contract in `workflow-schema.md` §5.1.1.
