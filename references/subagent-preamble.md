# Subagent preamble — long-form contract (reference, not paste-included)

> **Applicability** — `<thread-or-subagent>: subagent-only` (rationale
> doc). The **runtime** preamble dispatchers compose is the compact
> template at `${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md`
> — that file is what gets pasted into every `Agent(...)` dispatch.
> *This* file is the long-form contract: rationale, edge cases,
> portability notes, and the discovery-receipt protocol. Read it when
> authoring a new dispatcher or debugging a subagent return-shape
> violation; never paste-include it verbatim.

This split exists because verbatim paste-include of the long contract
into every parallel dispatch cost the chain ~25 k redundant tokens per
session and trained subagents to skim the same headings instead of
acting. The compact template carries only the operative invariants; this
doc carries the *why*.

Role-specific layered contracts live at `references/preambles/`:
`code-subagent.md` (impl: `execute-task`, `receiving-code-review`,
`write-tests`), `review-subagent.md` (code-review reviewer lanes),
`truncation-recovery.md` (high-risk dispatches). They extend the compact
template with role-only concerns; they are themselves referenced by
path, not paste-included.

---

## The seven invariants — long-form rationale

The compact template (`dispatch-prompt-template.md`) lists these as a
seven-rule block. Each subsection below explains the *why* behind one
rule, plus the edge cases that arose in production.

### Invariant 1 — Skills are BLOCKING (load before any work)

When the dispatch prompt carries `task.skillsFound[]` (or
`lane.skillsFound[]` for review lanes), the subagent MUST invoke
`Skill(<exact-name>)` for every listed entry BEFORE any Read / Edit /
Write / Bash call. Skills declare required context; executing work
before loading them skips that context and produces incomplete or
incorrect output.

Use the **exact string** stored in `name` — never construct the name
from the `domain` field or from memory.

- `domain` is for human display only; it is NOT part of the invocation.
- External plugin skills use `<plugin>:<name>` (e.g.
  `browzer:scope-feature`); built-in skills use `<name>` alone (e.g.
  `code-review`).
- Do not strip the plugin prefix from external skills or add one to
  built-in skills — the two forms resolve against different registries
  and are not interchangeable.

A marketplace `find-skills` shadow commonly hides the plugin's
`find-skills` variant; this is the most common silent-bypass cause.
Always prefer the fully qualified `Skill(<plugin>:<name>)` form when the
skill ships under a plugin namespace.

If the dispatched agent does not invoke a declared skill, the dispatch
lead may downgrade the task status to `skill-bypass` in the execution
log. **Skipping Step 0 = drift.** Training-data fallback only applies
AFTER all listed skills loaded AND don't address the question.

### Invariant 2 — Blast radius before edits (BLOCKING for code roles)

```bash
for F in $FILES_IN_SCOPE; do
  browzer deps "$F" --reverse --json --save "/tmp/rdeps-$(echo "$F" | tr '/' '_').json"
done
```

`deps --reverse` returns the file's reverse importers — the blast
radius. Tests that exercise the file directly or transitively live here.
Touching a refactor without consulting the blast radius is precisely the
failure that lets pre-push-gate breakage slip past code-review
(regression-tester needs this for its `--filter=...` package selection;
review lanes need it to reason about butterfly-effect risk; update-docs
needs it to find docs that cite the changed surface). Both forward
(`browzer deps`) and reverse (`browzer deps --reverse`) are cheap; run
both for any non-trivial file.

**Exemption — already populated.** When the dispatcher inlines
`task.scope.files[].blastRadius.reverse[]` (populated by `scope-feature`
upstream), the subagent MUST NOT re-run the probe for those files.
Re-running mid-dispatch produces diverging results if the index advanced
between scope-feature and now. Run the probe only for files NOT carrying
that block — brand-new files in scope, or files where scope-feature's
data is empty due to a stale index.

**Done when:** Before declaring done, the code-touching subagent MUST
produce `/tmp/rdeps-<sanitized-path>.json` for every file in
`task.scope.files[]` that lacked an inlined blast radius (skip generated
files such as `*.schema.json`, `*.gen.*`, and `vendor/`). The sanitized
path is `$(echo "$F" | tr '/' '_')`. Receipt files may be empty if the
file has no reverse importers — that is a valid signal, not an error.
Declaring done without these receipts is a protocol violation; the
dispatch lead may downgrade the task status to `blast-radius-bypass`.

### Invariant 3 — Scope is closed

The dispatcher's brief enumerates every in-scope file in `{{files}}`
and every out-of-scope file in `{{out-of-scope}}`. Take both literally:

- Files not in `{{files}}` → untouched, even if the bug's root cause is
  there.
- Files in `{{out-of-scope}}` → untouched even if your change would be
  cleaner with an edit there.

**Integration-glue exception** — ≤ 15 lines (a barrel export, a one-line
import, a config key) may be edited in an adjacent file. Disclose the
deviation under `### Scope adjustments` in your structured report; do
NOT silently expand scope. The dispatcher's prompt may also carry
`task.scope.doNotTouch[]` — files in that list are off-limits even
under the integration-glue exception.

### Invariant 4 — Comments policy (BLOCKING for code roles)

Source-code comments are the most common source of long-tail rot in the
chain. Operator-observed violations include:

- `// Removed per FR-3 of feat-20260513-cleanup-old-workflow`
- `// See FIX_F-003 — Langfuse step-id resolver rewrite`
- `// Per CLAUDE.md autosave matcher invariant…`
- `// retired in v5.0.0 along with the staging directory`

**Why this is bad** — comments referencing workflow artefacts (FR / AC /
F-NNN / TASK_NN / "retired in vX.Y.Z") rot the moment the artefact
disappears, which it will (workflow artefacts are gitignored per the
staging-folder policy — see `feature-folder-layout.md`). They also leak
session-specific state into the source code that downstream consumers
should never need.

**Rule** — Add a code comment only when the WHY of a line is non-obvious
to a future reader who lacks this session's context. Do NOT reference:

- Workflow artefact IDs: `FR-N`, `AC-N`, `F-NNN`, `TASK_NN`
- Retired feature names, version-trajectory phrases ("as of vX.Y.Z",
  "retired in vX.Y.Z")
- The current task ("added for X", "to satisfy Y")
- Sibling fixes ("see FIX_F-003", "after F-011 lands")

If a "why this changed" rationale would help, put it in the COMMIT BODY
— that is the version-control mechanism for change-rationale, not
source comments.

**Self-audit before declaring done** — word-boundary regex (so the
audit catches the residue forms that anchor-only patterns silently
miss: inline parenthetical references like `// foo (FR-3).`, block
comments inside markup `<!-- FR-3 -->`, strings inside test descriptions
`it("does X (FR-3)", ...)`):

```bash
grep -nE '\b(FR-[0-9]+|AC-[0-9]+|F-[0-9]{3}|TASK_[0-9]{2})\b' $FILES_YOU_TOUCHED
grep -nE 'retired in v[0-9]+' $FILES_YOU_TOUCHED
```

The grep MUST return empty. A non-empty result is a contract violation;
remove the comments before completing the report. RETRO §2.6 / R7
documents the symptom that anchored-prefix patterns missed (residues
inside parenthetical comments, markup blocks, and test-name strings)
and the word-boundary form catches.

**Cross-task residue sweep (for `taskIndex > 1`)** — when your task is
not the first one touching its scope (the dispatch brief carries
`task.scope.priorTouchedBy[]` populated by execute-task), run the
same regex over every file in your scope, not just files you modified
this run. Prior tasks may have left residues that escaped their own
self-audit; you are the second line of defence. Empty result is the
contract — when non-empty, strip the residues alongside your own edits
and disclose under `### Scope adjustments`. RETRO §3.3 / R8 documented
the cascading-cleanup symptom this invariant closes.

### Invariant 5 — No `git stash` (correctness, not cost)

`git stash` is a global shell-state mutation. In parallel lane / fixer
dispatch (which is the chain's default for `code-review` and the
non-contested-file path of `receiving-code-review`):

- A second lane running in parallel may see the stashed state instead
  of HEAD.
- A `git stash pop` after the lane's work can fail if another lane
  wrote to the same file in between → silent file loss or merge
  conflict.

This was a near-miss in production; the contract is now: **`git stash`
is forbidden in subagent dispatch.** Baselines MUST come from the
dispatch brief (the dispatcher inlines pre-change content). Where
comparing against `origin/main` is necessary, use the non-mutating
form:

```bash
git show origin/main:<path>      # OK — reads without mutating
git stash                        # FORBIDDEN — mutates global state
git stash push -m "..."          # FORBIDDEN — same reason
git stash pop                    # FORBIDDEN — same reason
```

Reading runtime git state (`git diff`, `git log`, `git status`) is fine;
mutating it is forbidden.

### Invariant 6 — `browzer` first, training data LAST

For every library / framework / config syntax you touch:

1. `browzer search "<topic>" --save /tmp/search.json` — host's own doc
   corpus, authoritative for this version. **Preferred over `browzer
   ask`** for determinism: `search` and `explore` return ranked entries
   with paths and line ranges, queryable identically across sessions;
   `ask` runs a synthesis that depends on backend availability and can
   degrade silently when the host is in `--ask-degraded` mode (RETRO
   §9 / R12 documents the symptom).
2. `browzer explore "<symbol or concern>"` — host's own code,
   authoritative for "how we do X here".
3. `browzer ask "<question>"` — only when search + explore returned
   nothing OR when the question requires synthesis across multiple
   surfaces. Treat its response as a *hint*, not a contract; cross-check
   any factual claim with `search` + `explore` before relying on it.
4. Context7 (if installed and browzer returned nothing) — third-party
   library docs pinned to the host's version.
5. Training data — last resort; note "assumed from training data, not
   verified" in `### Scope adjustments`.

**Query-audit reporting**. Every code-touching subagent MUST include
the `### browzer queries run` block in its structured report:

```text
### browzer queries run
- explore: <N>
- search: <N>
- deps: <N>
- ask: <N>
```

The orchestrator flags any non-trivial coder/fixer dispatch where
`explore + search + deps == 0` — that is the "wrote code without
grounding" failure mode (JUDGMENT §3.17 + RETRO §9). Empty is OK only
for trivial text edits (e.g. a one-line README fix).

**READ STORAGE SHAPE invariant (cache-touching code)** — when writing
cache reads/writes (optimistic updates, snapshot+rollback, prefix-match
updates, query-client wrappers), read the cache **writer** (fetcher /
storage adapter / serializer) AND the cache **reader** (existing
consumers) BEFORE writing your edit. Never assume `T` when storage
may be `Wrapper<T>`. Test seeds MUST match the storage-time shape, not
the post-projection shape. RETRO §12 anti-patterns A and B (key-contract
collision and envelope-shape mismatch) were the HIGH bugs that
escaped past code-review precisely because the coder did not read the
storage contract before writing the optimistic-update path.

### Invariant 7 — Return EXACTLY one line

The dispatcher truncates subagent stdout at the first newline before
logging it; any additional content is silently dropped from the chain
record. This is intentional — multi-paragraph subagent recaps are the
single largest source of main-thread context bloat (operator-observed:
100–300-word recaps despite explicit "one line" directives,
multiplying across N parallel dispatches).

**Rule** — Reply with EXACTLY ONE LINE. Any additional prose is a
contract violation. The structured report (per the return-shape footer
in your dispatch brief) is the canonical record; the one-line return is
only a status summary for the orchestrator's trace.

The dispatcher's truncation behaviour is enforced:

| Subagent emits | What the orchestrator sees |
|---|---|
| One line | The line, logged verbatim. |
| First line + extra prose | The first line only; extra prose dropped; a `subagent-verbose-return` warning surfaces in the trace. |
| Multiple paragraphs with no newline-bounded summary | A `subagent-malformed-return` warning surfaces; the dispatch lead may downgrade status to `malformed-return`. |

---

## State persistence — markdown chain, staging gitignored

The host plugin operates on the **markdown-chains** model. Every phase
artefact is a `.md` file under `docs/browzer/<feat>/staging/` (gitignored
by an auto-generated `staging/.gitignore`). Only the human-readable
`README.md` lives at the top of the feat folder and gets committed. See
`${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md` for the
canonical map.

- Subagents read input ONLY from the closed prompt their dispatcher
  composed (the prompt body). The dispatcher inlines verbatim every
  artefact the subagent needs — there is no fallback "Read the upstream
  artefact".
- Subagents write output to the path their dispatcher names. For
  `coder` / `fixer` subagents this is a source-code edit; for `tester`
  / `doc-writer` it's also source edits; for read-only `explorer` /
  `reviewer` the path is a per-lane `.md` under
  `docs/browzer/<feat>/staging/`.
- Subagents do NOT call legacy `browzer save-step` / `get-step` /
  `workflow init` / `describe-step-type` verbs. Those are dead in the
  markdown-chains era.
- Status transitions happen via atomic filename rename (`mv TASK_NN.md
  TASK_NN.completed.md`) plus body append (`## Execution log`). The
  subagent does NOT perform the rename — the orchestrating skill does.

---

## Temp-file hygiene — prefer `mktemp`, never fixed `/tmp/<name>` for Writes

Fixed paths like `/tmp/dispatch-prompt.json` race across sessions: a
stale file from a prior session either trips the harness's `File has not
been read yet` Write guard, or worse, gets consumed by the Bash chain
before notice.

Use `mktemp -t <prefix>.XXXXXX[.<ext>]` for any artefact that:

- a Write tool call creates, then a downstream Bash call consumes;
- an Agent dispatch references via path (the prompt body, a rendered
  template, an isolated payload to be `--argjsonfile`-bound);
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

---

## Cross-shell portability — bash, NOT bash-only

Every snippet in this preamble (and every skill that inlines it) runs
under both `bash` and `zsh` (the macOS default interactive shell,
inherited by Bash tool calls). Authors writing NEW snippets MUST avoid
four constructs that silently misbehave on zsh and/or older bashes:

1. **No associative arrays.** `declare -A FOO` is bash-only and even on
   bash requires v4+. Use `case "$KEY" in foo) val=...; ;; esac` instead,
   or two parallel arrays + a positional lookup.
2. **No indexed-array element reads in the form `${ARR[$IDX]}`.** zsh
   array indices start at 1, not 0; the same expression yields different
   values on the two shells. Iterate with `for x in $ARR; do ...; done`
   (which works in both with `IFS` defaulted) or wrap the snippet in an
   explicit `bash -c '...'`.
3. **No bare `<<EOF` heredocs in shell snippets.** Under macOS-default
   zsh the unquoted heredoc tag triggers parameter expansion in ways
   bash doesn't. Use `<<'EOF'` (quoted tag) when you want literal
   content, or wrap the whole block in `bash <<'EOF' ... EOF` / `bash
   -c '...'`.
4. **No bare `*.config*` / `*.test.<ext>` globs.** zsh's `nullglob`
   default makes a non-matching glob ABORT the script with `no matches
   found`. Either gate with `2>/dev/null || true` (`ls jest.config.*
   2>/dev/null || true`) or set the option explicitly for the snippet
   (`setopt nullglob 2>/dev/null || shopt -s nullglob 2>/dev/null`).

> **Note for snippet readers.** All shell blocks in this preamble run
> under `bash`. When copy-pasting into a macOS zsh session, prefix with
> `bash <<'EOF' ... EOF` (or run the snippet inside an explicit `bash`
> invocation) to bypass the zsh-default semantic differences above.

---

## Empty stdout is success — autonomous-mode clause

When running autonomously (default for the markdown-chains orchestrator),
**empty stdout + exit code 0 from any `browzer ... --quiet` command is
success**. Do not re-run the command, request confirmation, or insert a
verification step. Proceed to the next action immediately.

---

## Discovery receipt — attach `--save` to every find/locate/discover invocation

For every "find / locate / discover" task delegated to a specialist,
attach a `--save /tmp/<phase>-<noun>.json` receipt path to the
corresponding `browzer explore | search | deps | mentions` invocation.
Receivers may verify the receipt path exists.

---

## Output-contract reminder (impl subagents)

If your dispatcher tells you to emit `### Files modified`, `### Files
created`, or `### Symbols changed` blocks in your return summary, those
blocks are **regex-strict** by contract — drift toward natural-language
reports breaks the downstream parser. The canonical shapes live in
`${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md`.
Read that file (it's short) before authoring the first block, and emit
the literal `(none)` bullet for the empty case rather than dropping the
section.
