#!/usr/bin/env node
// migrate-await.mjs — codemod that retrofits Type-1 `browzer workflow` calls
// in skill bodies with the `--await` flag and updates `allowed-tools` in the
// frontmatter so Claude Code's allow-list pattern matching honors the new
// constraint.
//
// Modes:
//   --dry-run            (default) print per-skill diff, no writes
//   --apply              write changes in place
//   --skill <name>       scope to a single skill name (matches the parent dir)
//
// Pre-flight: `browzer workflow set-status --help | grep -q '--await'` —
// fail-fast when the Go-side flag isn't in the user's `$PATH`.
//
// Single source of truth for Type-1 patterns: ./_workflow-mutator-patterns.mjs

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYPE_1_PATTERNS } from './_workflow-mutator-patterns.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

// Verbs whose mere presence in a line is enough to require `--await`. Kept in
// sync with the Type-1 pattern set: anything below appearing in
// `browzer workflow <verb> ...` triggers insertion right after <verb>. Note
// `update-step` and `patch` are conditional — only Type-1 when --field/--jq
// targets a payload field — so we re-test the matched line against the full
// pattern array before inserting.
const TYPE_1_VERBS = [
  'set-status',
  'complete-step',
  'set-current-step',
  'set-config',
  'append-step',
  'update-step',
  'patch',
];

// ── Pre-flight ────────────────────────────────────────────────────────────────

function preflightAwaitFlag() {
  let help;
  try {
    help = execSync('browzer workflow set-status --help', {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (e) {
    throw new Error(
      `pre-flight failed: could not run 'browzer workflow set-status --help' (${e.message ?? e}). Install/rebuild the Go CLI first.`,
    );
  }
  if (!/--await/.test(help)) {
    throw new Error(
      "pre-flight failed: 'browzer workflow set-status --help' has no --await flag. Phase A (Go side) is not yet shipped in this PATH.",
    );
  }
}

// ── Skill discovery ───────────────────────────────────────────────────────────

const EXCLUDED = new Set([
  'examples',
  'node_modules',
  'agents',
  'scripts',
  'hooks',
  'references',
  'workflow',
  'desc-opt-workspace',
  '.claude-plugin',
]);

function collectSkills() {
  const skills = [];
  for (const category of readdirSync(PKG_ROOT)) {
    if (EXCLUDED.has(category)) continue;
    const cat = join(PKG_ROOT, category);
    if (!statSync(cat).isDirectory()) continue;
    for (const skillDir of readdirSync(cat)) {
      if (EXCLUDED.has(skillDir)) continue;
      const skillPath = join(cat, skillDir);
      if (!statSync(skillPath).isDirectory()) continue;
      const skillMd = join(skillPath, 'SKILL.md');
      try {
        statSync(skillMd);
        skills.push({ name: skillDir, path: skillMd });
      } catch {
        // No SKILL.md.
      }
    }
  }
  return skills;
}

// ── Frontmatter split ─────────────────────────────────────────────────────────

function splitFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  return {
    fmHead: '---\n',
    fmBody: content.slice(4, end),
    fmTail: '\n---\n',
    body: content.slice(end + 5),
  };
}

// ── Body rewrite ──────────────────────────────────────────────────────────────

/**
 * Returns true if `line` matches any TYPE_1 pattern. Fully delegates to the
 * shared regex set so the validator and the codemod stay in sync.
 */
function isType1Line(line) {
  return TYPE_1_PATTERNS.some((re) => re.test(line));
}

/**
 * Rewrite a single line: insert `--await` right after the Type-1 verb token,
 * once. Idempotent: returns the line unchanged if `--await` already appears
 * anywhere in the same logical command.
 *
 * Strategy: anchor on `browzer workflow <verb>` and inject `--await` between
 * `<verb>` and whatever follows. We deliberately do NOT touch heredoc bodies
 * or comments — those are handled by virtue of the Type-1 patterns only
 * matching the literal CLI invocation.
 */
function rewriteLine(line) {
  if (!isType1Line(line)) return { line, changed: false };
  // Idempotence: already has --await? skip.
  if (/\s--await(\s|$)/.test(line)) return { line, changed: false };

  // Insert after the verb token. Use a tight capture so we don't accidentally
  // move past a positional argument that shares the verb's prefix.
  const verbAlt = TYPE_1_VERBS.map((v) => v.replace(/-/g, '\\-')).join('|');
  const re = new RegExp(`(browzer\\s+workflow\\s+(?:${verbAlt}))(\\b)`);
  const match = re.exec(line);
  if (!match) return { line, changed: false };
  const insertAt = match.index + match[1].length;
  const next = line.slice(0, insertAt) + ' --await' + line.slice(insertAt);
  return { line: next, changed: true };
}

function rewriteBody(body) {
  const lines = body.split('\n');
  let changes = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = rewriteLine(lines[i]);
    if (r.changed) {
      lines[i] = r.line;
      changes++;
    }
  }
  return { body: lines.join('\n'), changes };
}

// ── Frontmatter rewrite ───────────────────────────────────────────────────────

/**
 * Update the `allowed-tools` line so it contains both
 * `Bash(browzer workflow * --await)` AND `Bash(browzer workflow *)`. Order
 * matters because Claude Code matches the most specific allow-list entry
 * first; placing the `--await` form ahead of the bare form keeps Type-2 calls
 * working.
 *
 * Idempotent: if the `--await` token already appears, returns unchanged.
 */
function rewriteFrontmatter(fm) {
  const lines = fm.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^allowed-tools\s*:/.test(line)) continue;
    if (/Bash\(browzer workflow \* --await\)/.test(line)) {
      // Already migrated.
      return { fm, changed: false };
    }
    if (!/Bash\(browzer workflow \*\)/.test(line)) {
      // Skill mentions Type-1 but doesn't have the bare form either — that's
      // an upstream Rule 6 failure; codemod refuses to invent a permission.
      return { fm, changed: false };
    }
    lines[i] = line.replace(
      /Bash\(browzer workflow \*\)/,
      'Bash(browzer workflow * --await), Bash(browzer workflow *)',
    );
    changed = true;
    break;
  }
  return { fm: lines.join('\n'), changed };
}

// ── Per-skill driver ──────────────────────────────────────────────────────────

function migrateSkill({ name, path: filePath }) {
  const original = readFileSync(filePath, 'utf8');
  const split = splitFrontmatter(original);
  if (!split) {
    return { name, path: filePath, status: 'skipped:no-frontmatter' };
  }

  // Body changes first — they decide whether frontmatter needs updating.
  const { body: newBody, changes: bodyChanges } = rewriteBody(split.body);

  // Only touch frontmatter when the body had at least one Type-1 invocation
  // BEFORE rewriting (skips Type-2-only skills entirely).
  const hadType1 = TYPE_1_PATTERNS.some((re) => re.test(split.body));
  let newFmBody = split.fmBody;
  let fmChanged = false;
  if (hadType1) {
    const r = rewriteFrontmatter(split.fmBody);
    newFmBody = r.fm;
    fmChanged = r.changed;
  }

  if (bodyChanges === 0 && !fmChanged) {
    return {
      name,
      path: filePath,
      status: 'unchanged',
      bodyChanges: 0,
      fmChanged: false,
    };
  }

  const next = split.fmHead + newFmBody + split.fmTail + newBody;
  return {
    name,
    path: filePath,
    status: 'changed',
    bodyChanges,
    fmChanged,
    original,
    next,
  };
}

// ── Inline diff (line-level) ──────────────────────────────────────────────────

function diff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out = [];
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    const x = al[i] ?? '';
    const y = bl[i] ?? '';
    if (x === y) continue;
    if (x !== undefined && x !== '') out.push(`-${x}`);
    if (y !== undefined && y !== '') out.push(`+${y}`);
  }
  return out.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: 'dry-run', skill: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.mode = 'apply';
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--skill') args.skill = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function help() {
  process.stdout.write(
    `Usage: migrate-await.mjs [--dry-run | --apply] [--skill <name>]\n\n` +
      `Modes:\n` +
      `  --dry-run    Print per-skill diff, no writes (default)\n` +
      `  --apply      Apply changes in place\n` +
      `  --skill <n>  Scope to a single skill (parent-dir basename)\n`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();

  preflightAwaitFlag();

  const all = collectSkills();
  const targets = args.skill ? all.filter((s) => s.name === args.skill) : all;
  if (args.skill && targets.length === 0) {
    process.stderr.write(`migrate-await: skill '${args.skill}' not found\n`);
    process.exit(2);
  }

  let changedCount = 0;
  let unchangedCount = 0;
  let totalLineEdits = 0;

  for (const skill of targets) {
    const r = migrateSkill(skill);
    if (r.status === 'changed') {
      changedCount++;
      totalLineEdits += r.bodyChanges + (r.fmChanged ? 1 : 0);
      const rel = relative(PKG_ROOT, r.path);
      process.stdout.write(
        `\n--- ${rel} (body: ${r.bodyChanges}, frontmatter: ${r.fmChanged ? 1 : 0})\n`,
      );
      process.stdout.write(diff(r.original, r.next) + '\n');
      if (args.mode === 'apply') {
        writeFileSync(r.path, r.next);
      }
    } else {
      unchangedCount++;
    }
  }

  process.stdout.write(
    `\nMigrated ${changedCount} skill(s), ${totalLineEdits} edit(s); ${unchangedCount} unchanged.\n`,
  );
  if (args.mode === 'dry-run') {
    process.stdout.write(`(dry-run — re-run with --apply to write changes)\n`);
  }
}

main();
