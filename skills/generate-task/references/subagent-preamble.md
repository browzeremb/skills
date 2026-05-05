# Subagent preamble — index

> **Applicability** — `<thread-or-subagent>: subagent-only`. Runs inside
> dispatched `Agent(...)` / `Task(...)` sessions only; the orchestrator
> thread skips. Skills that inline this preamble (e.g. `execute-task`
> trivial-task path) MUST mark `<thread-or-subagent>: thread-only` and
> skip the dispatch guards.

Three role-specific preambles in `references/preambles/`: `code-subagent.md` (impl: execute-task / receiving-code-review / write-tests), `review-subagent.md` (code-review reviewers), `truncation-recovery.md` (high-risk dispatches). Paste verbatim — plugin-relative paths don't resolve in subagent sessions.

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

## Mandatory: stamp `startedAt` BEFORE the work begins

The first jq mutation on a step MUST set `startedAt`. Stamping it only at completion makes `elapsedMin` always 0 and corrupts retro-analysis. Full timing contract in `workflow-schema.md` §5.1.1.

## Temp-file hygiene — prefer `mktemp`, never fixed `/tmp/<name>` for Writes

Fixed paths like `/tmp/dispatch-prompt.json` race across sessions: a stale
file from a prior session either trips the harness's `File has not been read
yet` Write guard, or worse, gets consumed by the Bash chain before notice.

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

Fixed `/tmp/<name>.json` paths remain fine for **read-only in-thread
artefacts** the next Bash call consumes (e.g. `browzer explore … --save
/tmp/x.json` then inline `jq`). The race only opens across sessions or
when one session writes the same path twice.

## Cross-shell portability — bash, NOT bash-only

Every snippet in this preamble (and every skill that inlines it) is
written to run under both `bash` and `zsh` (the macOS default
interactive shell, but inherited by Bash tool calls). Authors writing
NEW snippets MUST avoid four constructs that silently misbehave in
zsh and/or older bashes:

1. **No associative arrays.** `declare -A FOO` is bash-only and even
   on bash requires v4+. Use `case "$KEY" in foo) val=...; ;; esac`
   instead, or two parallel arrays + a positional lookup.
2. **No indexed-array element reads in the form `${ARR[$IDX]}`.** zsh
   array indices start at 1, not 0; the same expression yields
   different values on the two shells. Iterate with `for x in $ARR;
   do ...; done` (which works in both with `IFS` defaulted) or wrap
   the snippet in an explicit `bash -c '...'`.
3. **No bare `<<EOF` heredocs in shell snippets.** Under macOS-default
   zsh the unquoted heredoc tag triggers parameter expansion in ways
   bash doesn't. Use `<<'EOF'` (quoted tag) when you want literal
   content, or wrap the whole block in `bash <<'EOF' ... EOF` /
   `bash -c '...'`.
4. **No bare `*.config*` / `*.test.ts` globs.** zsh's `nullglob`
   default makes a non-matching glob ABORT the script with `no
   matches found`. Either gate with `2>/dev/null || true` (`ls
   jest.config.* 2>/dev/null || true`) or set the option explicitly
   for the snippet (`setopt nullglob 2>/dev/null || shopt -s nullglob
   2>/dev/null`).

> **Note for snippet readers.** All shell blocks in this preamble run
> under `bash`. When copy-pasting into a macOS zsh session, prefix
> with `bash <<'EOF' ... EOF` (or run the snippet inside an explicit
> `bash` invocation) to bypass the zsh-default semantic differences
> above.

## Skill invocation — use `skillsFound[].skill` verbatim

When loading a skill via `Skill(...)`, pass the **exact string stored in `task.explorer.skillsFound[].skill`** — never construct the name from the `domain` field or from memory.

- `domain` is for human display only; it is NOT part of the invocation.
- External plugin skills use `<plugin>:<name>` (e.g. `browzer:scope`); built-in skills use `<name>` alone (e.g. `code-review`).
- Do not strip the plugin prefix from external skills or add one to built-in skills — the two forms resolve against different registries and are not interchangeable.
