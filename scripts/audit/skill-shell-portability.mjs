#!/usr/bin/env node
/**
 * skill-shell-portability.mjs — C5 audit.
 *
 * Walks every `packages/skills/skills/**\/*.md` and
 * `packages/skills/references/**\/*.md` for fenced ```bash blocks and flags
 * idioms that break on ONE of the three popular operator shells:
 *
 *   - macOS default `bash 3.2` (no associative arrays, no [[ =~ \K ]] on
 *     some patterns, no `mapfile`).
 *   - macOS / brew default `zsh` (1-based array indexing — `${arr[0]}` is
 *     EMPTY in zsh; nullglob aborts on no-match unless `setopt nullglob`).
 *   - GNU bash 4+ where `<<EOF` heredocs work but only if the surrounding
 *     context is a real bash invocation (zsh accepts `<<EOF` too, but if
 *     the snippet is meant to run via `bash -c '<<EOF ...'` and was authored
 *     to NOT wrap, it silently fails).
 *
 * The audit is deliberately conservative: only the four idioms below are
 * flagged. They each map to a documented friction in the
 * `feat-20260505-conversion-balance-liquidation` retro §4 ("Cross-shell
 * portability"). New idioms can be added as new portability classes
 * surface.
 *
 * Idiom #1 — `declare -A`
 *   bash 4+ only. Falls back to "declare: -A: invalid option" on macOS bash
 *   3.2. Fix: rewrite as a `case` dispatch or sequential `for` loop.
 *
 * Idiom #2 — `${VAR[<digit>]}` array indexing
 *   bash arrays are 0-based; zsh arrays are 1-based by default. A snippet
 *   that does `${ARR[0]}` in a `for` loop body silently picks "" in zsh.
 *   Fix: iterate the array (`for X in "${ARR[@]}"; do …`), or `case`-dispatch.
 *
 * Idiom #3 — bare `<<EOF` heredoc (FIXTURE-ONLY rule)
 *   In a literal skill snippet, `<<EOF` works in bash; the friction logged in
 *   the retro is about agents IMPROVISING heredoc forms in zsh-default macOS
 *   (`bash -c '... <<EOF ...'` semantics). That's a pattern the audit
 *   can't infer from skill markdown alone. We keep the rule active in
 *   `--self-test` (so the rule code is exercised) but skip it in real mode
 *   to avoid false-positives on legitimate `<<EOF` blocks the agent runs in
 *   its own bash shell.
 *
 * Idiom #4 — `*.config*` glob in a non-`setopt nullglob` zsh
 *   When the glob matches nothing, zsh raises "no match". bash quietly
 *   passes the literal pattern. Fix: `find . -name '*.config*'` or quote.
 *
 * Modes:
 *   default      scan packages/skills/{skills,references} for .md files;
 *                exit 0 = zero violations, exit 1 = one or more.
 *   --self-test  scan the bad fixture (which DOES contain violations) and
 *                exit 0 if violations were found (the audit works) else 1.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_PKG = join(__dirname, '..', '..');
const REPO_ROOT = join(SKILLS_PKG, '..', '..');
const FIXTURE_PATH = join(
  __dirname,
  '__fixtures__',
  'shell-portability.bad.md',
);

const SCAN_SUBDIRS = ['skills', 'references'];

const FENCE_OPEN = /^(\s*)```(bash|sh|shell|zsh|console)\s*$/i;
const FENCE_CLOSE = /^\s*```\s*$/;

// Idiom rules. Each rule has a name, a regex, and a hint. Keep these short
// and avoid heuristics that risk false positives — the value of the audit is
// "every flagged line is a real, copy-pasted-fail in a real shell".
const RULES = [
  {
    name: 'declare-A',
    re: /\bdeclare\s+-A\b/,
    hint: 'replace with `case "$KEY" in pat) val=…;; esac` or a sequential `for` loop (bash 3.2 / macOS default has no associative arrays)',
  },
  {
    name: 'array-numeric-index',
    // ${ARR[0]} or ${ARR[$i]} — bash 0-based, zsh 1-based silently differ.
    // Whitelist the special-case ${arr[@]} / ${arr[*]} via the negative
    // lookahead (since [@/*] are not digits anyway, the digit-class match
    // already excludes them).
    re: /\$\{[A-Za-z_][A-Za-z0-9_]*\[\$?[0-9]+\]/,
    hint: 'iterate `for X in "${ARR[@]}"; do …` or use a `case` dispatch — zsh arrays are 1-based, bash arrays are 0-based, the same indexed access yields different elements',
  },
  {
    name: 'heredoc-EOF-bare',
    // Fixture-only: rule active for self-test coverage but skipped in real
    // mode (see SELF_TEST_ONLY_RULES below). The original retro friction was
    // about agent IMPROVISATION of heredocs in non-bash shells, not literal
    // `<<EOF` in skill snippets that run via the agent's bash tool.
    re: /(^|\s)<<\s*EOF\b/,
    hint: "wrap in `bash <<'EOF' … EOF` (single-quoted heredoc terminator suppresses expansion divergence between bash and zsh-default macOS)",
  },
  {
    name: 'unquoted-config-glob',
    // `something.config*` as a free token (not inside quotes) — bash globs
    // it; zsh aborts if no match without `setopt nullglob`. We flag the
    // pattern outside of quote spans only.
    re: /(?:^|\s)[A-Za-z_][A-Za-z0-9_./-]*\.config\*/,
    hint: 'use `find . -name "*.config*"` or quote the glob (`"*.config*"`) — zsh aborts with "no match" when the glob is empty unless `setopt nullglob`',
  },
];

function walkMd(dir, acc = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * Strip single + double quoted spans from a line so a regex looking for
 * "unquoted X" doesn't fire on `'declare -A'` inside prose. Doesn't handle
 * shell escaping perfectly — over-strips for the audit's purpose, which is
 * fine: a quoted occurrence is by definition not the executable form.
 */
function stripQuoted(line) {
  return line
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

// Rules that participate in --self-test but are NOT enforced in real mode.
// Keeps coverage of the rule code without producing false-positives on
// legitimate skill snippets.
const SELF_TEST_ONLY_RULES = new Set(['heredoc-EOF-bare']);

function scanFile(filePath, { includeSelfTestOnly = false } = {}) {
  const violations = [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  let inFence = false;
  let fenceLang = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(FENCE_OPEN);
    if (open) {
      inFence = !inFence;
      fenceLang = inFence ? open[2].toLowerCase() : '';
      continue;
    }
    if (FENCE_CLOSE.test(line) && inFence) {
      inFence = false;
      fenceLang = '';
      continue;
    }
    if (!inFence) continue;
    // Audit only bash-like fences. JSON / YAML fences are skipped above by
    // FENCE_OPEN constraint; defense-in-depth here.
    if (!/^(bash|sh|shell|zsh|console)$/i.test(fenceLang)) continue;
    // Skip comment-only lines.
    if (/^\s*#/.test(line)) continue;
    const stripped = stripQuoted(line);
    for (const rule of RULES) {
      if (!includeSelfTestOnly && SELF_TEST_ONLY_RULES.has(rule.name)) continue;
      if (rule.re.test(stripped)) {
        violations.push({
          file: relative(REPO_ROOT, filePath),
          line: i + 1,
          rule: rule.name,
          snippet: line.trim().slice(0, 120),
          hint: rule.hint,
        });
      }
    }
  }
  return violations;
}

function reportViolations(violations) {
  process.stderr.write(
    `✗ Found ${violations.length} shell-portability issue(s) in skill bash blocks.\n`,
  );
  for (const v of violations) {
    process.stderr.write(
      `  ${v.file}:${v.line} [${v.rule}]\n    snippet: ${v.snippet}\n    fix: ${v.hint}\n`,
    );
  }
}

const args = process.argv.slice(2);

if (args.includes('--self-test')) {
  if (!existsSync(FIXTURE_PATH)) {
    process.stderr.write(`self-test: missing fixture at ${FIXTURE_PATH}\n`);
    process.exit(2);
  }
  const violations = scanFile(FIXTURE_PATH, { includeSelfTestOnly: true });
  if (violations.length === 0) {
    process.stderr.write(
      `self-test: FIXTURE PASSED but it MUST contain a violation — bug in ${FIXTURE_PATH}\n`,
    );
    process.exit(1);
  }
  // Pin the rule coverage: every RULES entry must be exercised by the
  // fixture so a future bug in a rule is caught (rather than silently
  // skipping). EXPECTED_RULES = all rule names.
  const seenRules = new Set(violations.map((v) => v.rule));
  const expected = new Set(RULES.map((r) => r.name));
  const missing = [...expected].filter((r) => !seenRules.has(r));
  if (missing.length > 0) {
    process.stderr.write(
      `self-test: fixture exercises ${seenRules.size}/${expected.size} rules — missing: ${missing.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `✓ self-test: fixture correctly triggered ${violations.length} violation(s) across all ${expected.size} rules.\n`,
  );
  process.exit(0);
}

const files = SCAN_SUBDIRS.flatMap((sub) => walkMd(join(SKILLS_PKG, sub)));
const violations = files.flatMap(scanFile);

if (violations.length === 0) {
  process.stdout.write(
    '✓ Zero shell-portability issues in skill bash blocks.\n',
  );
  process.exit(0);
}

reportViolations(violations);
process.exit(1);
