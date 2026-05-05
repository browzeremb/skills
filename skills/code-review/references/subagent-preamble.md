# Subagent preamble — index

> **Applicability marker** — `<thread-or-subagent>: subagent-only`.
> This preamble (and every Step 0 it gates) executes inside a
> dispatched `Agent(...)` / `Task(...)` session. The orchestrator
> thread itself (the caller that issued the dispatch) does NOT run
> these steps. Skills that include this preamble verbatim in their
> own SKILL.md (e.g. `execute-task` for trivial-task inline path)
> MUST mark the section `<thread-or-subagent>: thread-only` and skip
> the dispatch-flavoured guards that follow.

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

## Temp-file hygiene — prefer `mktemp`, never fixed `/tmp/<name>` for Writes

Fixed paths like `/tmp/dispatch-prompt.json` race across sessions: if a
prior session left the file in place, the harness's `Write` tool refuses
the next write with `File has not been read yet. Read it first before
writing to it.` and — worse — the Bash chain may consume the stale
content of the previous session's run before the agent notices.

Use `mktemp -t <prefix>.XXXXXX[.<ext>]` for any artefact that:

- a Write tool call creates, then a downstream Bash call consumes;
- an Agent dispatch references via path (the prompt body, the rendered
  `--render` template, an isolated payload to be `--argjsonfile`-bound);
- the same skill might emit twice within a single session (retry,
  per-task loop body).

```bash
PROMPT_FILE="$(mktemp -t dispatch-prompt.XXXXXX)"
printf '%s' "$AGENT_PROMPT" > "$PROMPT_FILE"
# … use "$PROMPT_FILE" as needed …
rm -f "$PROMPT_FILE"
```

Fixed `/tmp/<name>.json` paths are still acceptable for **read-only
in-thread artefacts** that the immediate next Bash call consumes and
discards (the canonical example is `browzer explore … --save
/tmp/<name>.json` followed by an inline `jq` read in the same turn). The
race window only opens when the artefact persists across sessions or
when the same path is written twice in one session.
