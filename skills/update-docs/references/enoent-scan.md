# enoent-scan — shell-command resolvability (4th update-docs signal)

Deterministic ENOENT scan over fenced `bash` / `sh` blocks in candidate docs.
Detects shell commands embedded in markdown that became broken paths after a
code change. Runs synchronously inside `update-docs` Phase 2b — no LLM, no
subagent. Counterpart to the three semantic signals (mentions / direct-ref /
concept-level) which miss path-resolvability regressions when the surrounding
prose did not change.

## Table of Contents

1. [Why this exists](#1-why-this-exists)
2. [Input set (which docs to scan)](#2-input-set)
3. [Banned paths and skip rules](#3-banned-paths)
4. [Per-doc algorithm](#4-per-doc-algorithm)
5. [Resolver contract](#5-resolver-contract)
6. [Edge cases](#6-edge-cases)
7. [Output shape](#7-output-shape)
8. [Hand-off to Phase 3 / Phase 5](#8-hand-off)
9. [What this scan deliberately does NOT do](#9-non-goals)

## 1. Why this exists

RETRO §15 (`docs/CLAUDE_CODE_PLUGIN.md §14 Run the eval suite`) shipped a
fenced `bash` block whose `node <path>` referenced a script that had moved
during a prior refactor. None of the existing three signals flagged it:

- **mentions** — `browzer mentions` had no edge from the moved script back to
  the doc (the doc only mentioned the script by literal path inside a code
  fence, which is not extracted as a symbol edge).
- **direct-ref** — the literal path string in the fence still matched, just
  not on disk.
- **concept-level** — the surrounding prose still described the same concept,
  so semantic similarity was high.

The fix is a deterministic disk-existence check on every command token in
fenced `bash` / `sh` blocks. If the binary or script does not resolve, flag.

## 2. Input set

Two sources, unioned and deduplicated:

1. `git diff --name-only "$BASE"..HEAD -- '*.md' '*.mdx'` — markdown files
   touched in the current branch.
2. Docs already aggregated into `updateDocs.docsMentioning[]` from Phase 1a
   (do **not** re-query `browzer mentions` — reuse the in-memory result).

The union is the scan set. If empty, emit `staleCommands: []` and skip.

## 3. Banned paths

Skip the doc entirely when its path matches any of:

- `node_modules/`
- `vendor/`
- `dist/`
- `.next/`

Also skip:

- Backtick-only inline code (single backticks, no triple-fence).
- Fenced blocks whose info-string is anything other than `bash` or `sh`
  (e.g. `text`, `console`, `shell-session`, `jsonc`, `dockerfile`).

## 4. Per-doc algorithm

For each in-scope doc:

1. Read the file once. Walk lines, tracking fence state — open on a line
   matching `^```(bash|sh)\s*$`, close on `^```\s*$`.
2. Inside an open `bash`/`sh` fence, for each non-blank line that is not a
   comment (`#…`):
   1. **Heredoc handling** — if the line ends with `<<-?\s*['"]?(\w+)['"]?`,
      record the sentinel and skip every following line until the sentinel
      reappears flush-left (or with leading tabs for `<<-`). Resume scanning
      after the closing sentinel.
   2. Strip a leading run of `KEY=value` env-var assignments (`FOO=1 BAR=2 …`).
   3. Strip a leading `cd <dir> &&` (single occurrence; preserve relative
      directory awareness only as a hint, not as cwd state — the resolver
      always works from repo root).
   4. Split the residue on top-level `&&`, `||`, `;`, `|` (do not split inside
      single or double quotes). Each segment is a candidate command.
3. For each candidate command, the **first whitespace-delimited token** is
   the binary/script. Pass it through the resolver (§5).
4. Unresolved tokens → push a finding (§7). Resolved tokens → silent.

## 5. Resolver contract

Three branches, picked by the shape of the token:

| Token shape | Example | Check |
|---|---|---|
| Relative path (starts `./`, `../`, or contains `/` and is not absolute) | `scripts/run.mjs`, `./bin/foo` | `test -f "<repo-root>/<path>"` |
| Absolute path (starts `/`) | `/usr/local/bin/foo` | `test -f "<path>"` |
| Bare name (no `/`) | `node`, `pnpm`, `browzer` | cross-platform PATH lookup |

Cross-platform PATH lookup (avoids GNU `which` / BSD `command -v` skew on
macOS, Linux, and Windows):

```bash
node -e "process.exit(require('node:child_process').spawnSync(process.platform==='win32'?'where':'which',[process.argv[1]]).status||0)" "<token>"
```

Exit 0 = resolved. Non-zero = ENOENT-class miss → finding.

## 6. Edge cases

| Case | Handling |
|---|---|
| Multi-line continuation (`\\` at EOL) | Join with the next line before tokenisation. |
| Env-var prefixes (`BROWZER_LLM=1 browzer status`) | Strip the assignments; resolve `browzer`. |
| `cd <dir> && <cmd>` | Strip the `cd …&&` prefix; still resolve from repo root (do NOT chdir — the goal is to detect missing files in the repo, not to honour the doc's intended cwd). |
| Heredocs (`cat <<EOF … EOF`) | Skip the body wholesale; resume after the sentinel. `<<-EOF` allows leading tabs on the sentinel. |
| `$VAR`-interpolated paths (`node "$ROOT/run.mjs"`) | Mark `unresolvable: "var-substitution"` and DO NOT flag — the value is unknown statically. |
| Backtick / `$()` command substitution as the first token (`$(which node) --version`) | Mark `unresolvable: "command-substitution"`; skip. |
| Quoted paths (`"./scripts/run mjs"`, `'./bin/foo'`) | Strip surrounding quotes before resolving. |
| Pipelines (`cat foo | jq .`) | Each segment between `|` is a command — resolve each first token. |
| Subshells (`(cd x && y)`) | Strip outer parens; recurse on the inner string. |
| Background (`&`) and redirection (`> /tmp/foo`, `< file`) | Strip trailing redirection / `&` before resolving. The redirection target itself is NOT checked (it may be a file the script is about to create). |
| Comments after a command (`cmd # …`) | Trim from `#` to EOL when `#` is preceded by whitespace and not inside quotes. |
| Windows-only commands in cross-platform docs | The PATH probe uses `where` on win32 and `which` elsewhere; a doc that says `pwsh` on a non-win developer machine will flag — that is intended (the doc is platform-specific and should be marked so). |
| Aliased shell builtins (`echo`, `cd`, `set`, `export`, `source`, `:`, `[`, `[[`, `function`) | Allowlisted — never flagged. |
| `pnpm` / `npm` / `yarn` script invocations (`pnpm run lint`, `npm run test:foo`) | Resolve only the package manager binary; the script name is not a path. |

## 7. Output shape

Findings accumulate into `updateDocs.staleCommands[]`:

```jsonc
{
  "doc": "docs/CLAUDE_CODE_PLUGIN.md",
  "line": 142,
  "fence": "bash",
  "command": "node scripts/packages/skills/run-skill-evals.mjs",
  "token": "scripts/packages/skills/run-skill-evals.mjs",
  "kind": "relative-path",   // "relative-path" | "absolute-path" | "bare-name"
  "reason": "ENOENT"          // "ENOENT" | "PATH-miss"
}
```

`kind` mirrors the resolver branch; `reason` distinguishes filesystem misses
(`ENOENT`) from PATH misses (`PATH-miss`). Lines are 1-indexed and point at
the offending line inside the fence (not the fence opener).

## 8. Hand-off

- Phase 3 reads `staleCommands[]` and assigns each a classification.
  Default: `needs-patch` (the path moved or got renamed — patch the doc to
  the new path). Override to `stale-but-oos` if the command belongs to a
  doc-area outside the current change's scope.
- Phase 5 includes `staleCommands[]` in the JSON payload and `shellResolvability`
  in `twoPassRun`. The closure cursor appends `; staleCommands=<N>` when
  `N > 0`.
- Phase 0.4 enforcement should treat `shellResolvability: false` as a
  contract violation alongside the existing three signals.

## 9. Non-goals

- The scan does NOT execute commands — it only resolves the first token
  against the filesystem / PATH.
- The scan does NOT check command flag validity, env-var requirements, or
  exit codes. A `node script.mjs` whose file exists but crashes at runtime
  is not flagged.
- The scan does NOT cover `dockerfile`, `yaml`, `Makefile`, or other code
  fences. Those are out of scope for update-docs and would need a sibling
  scanner.
- The scan does NOT delete or rewrite fences. It only emits findings — Phase
  3 / Phase 4 own the patch decision.
