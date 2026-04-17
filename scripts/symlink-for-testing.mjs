#!/usr/bin/env node
/**
 * symlink-for-testing.mjs
 *
 * Point the installed Browzer skill copies (Claude Code plugin cache + marketplace)
 * at the local SKILL.md source files in this repo for fast iteration during skill
 * development — edits in packages/skills/skills/<name>/SKILL.md are immediately
 * visible to Claude Code without re-publishing or re-installing the plugin.
 *
 * Motivation: retro session-1 §11.3 — "skill edits require reinstall" friction.
 *
 * Idempotency guarantee: if the target is already a symlink it is left untouched.
 * If the target is a regular file it is backed up as <target>.bak.YYYYMMDD-HHMMSS
 * before the symlink is created so the original is always recoverable.
 *
 * Invocation:
 *   node --experimental-strip-types packages/skills/scripts/symlink-for-testing.mjs <skill-name> [--dry-run]
 *
 * Exit codes:
 *   0  — success (or dry-run completed)
 *   2  — no arguments supplied (usage printed to stderr)
 *   3  — skill name not found under packages/skills/skills/
 *   1  — unexpected fs error
 */

import {
  readdirSync,
  readlinkSync,
  statSync,
  lstatSync,
  renameSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ── Path bootstrap ────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// scripts/ → packages/skills/
const PKG_ROOT = join(__dirname, '..');

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

const USAGE = `
symlink-for-testing.mjs — point installed Browzer copies at this repo

Usage:
  node --experimental-strip-types packages/skills/scripts/symlink-for-testing.mjs <target> [--dry-run]

  <target> variants:
    <skill-name>  — a skill under packages/skills/skills/ (e.g. task-orchestrator)
    hooks         — the whole hooks bundle (hooks.json + guards/ directory)
  --dry-run       — compute paths and describe actions without touching the filesystem

Skill mode resolves:
  src    → packages/skills/skills/<skill-name>/SKILL.md
  target → ~/.claude/plugins/cache/browzer-marketplace/browzer/<latest-version>/skills/<skill-name>/SKILL.md
  target → ~/.claude/plugins/marketplaces/browzer-marketplace/skills/<skill-name>/SKILL.md

Hooks mode resolves (two pairs):
  src    → packages/skills/hooks/hooks.json
  target → ~/.claude/plugins/cache/.../hooks/hooks.json (latest version)
  target → ~/.claude/plugins/marketplaces/.../hooks/hooks.json

  src    → packages/skills/hooks/guards        (directory symlink — covers all .mjs)
  target → ~/.claude/plugins/cache/.../hooks/guards
  target → ~/.claude/plugins/marketplaces/.../hooks/guards

For every target (either mode):
  - already a symlink  → skip
  - regular file/dir   → back up as <target>.bak.YYYYMMDD-HHMMSS, then symlink
  - missing            → symlink directly
`.trimStart();

if (args.length === 0) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const skillName = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!skillName) {
  process.stderr.write(USAGE);
  process.exit(2);
}

// ── Semver sort (no external dep) ─────────────────────────────────────────────
/**
 * Compare two semver strings like "1.0.14" > "1.0.9".
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
function semverCompare(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10));
  const pb = b.split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Timestamp helper ──────────────────────────────────────────────────────────
function nowStamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ── Common install-path constants (used by both skill and hooks modes) ────────
const HOME = homedir();
const CACHE_BASE = join(HOME, '.claude/plugins/cache/browzer-marketplace/browzer');
const MARKETPLACE_BASE = join(
  HOME,
  '.claude/plugins/marketplaces/browzer-marketplace/skills',
);

// ── Hooks mode short-circuit ──────────────────────────────────────────────────
const HOOKS_MODE = skillName === 'hooks';

if (HOOKS_MODE) {
  runHooksMode({ dryRun });
  process.exit(0);
}

// ── Resolve SRC ───────────────────────────────────────────────────────────────
const SKILLS_DIR = join(PKG_ROOT, 'skills');
const SRC = join(SKILLS_DIR, skillName, 'SKILL.md');

if (!existsSync(SRC)) {
  let available = [];
  try {
    available = readdirSync(SKILLS_DIR).filter((entry) => {
      try {
        return statSync(join(SKILLS_DIR, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    // SKILLS_DIR missing entirely — available stays empty
  }
  process.stderr.write(
    `Error: skill "${skillName}" not found.\n` +
      `Expected: ${SRC}\n\n` +
      `Available skills:\n` +
      (available.length > 0
        ? available.map((s) => `  ${s}`).join('\n')
        : '  (none found)') +
      '\n',
  );
  process.exit(3);
}

// ── Resolve TGT_CACHE (with version discovery) ────────────────────────────────
let discoveredVersion = null;
let TGT_CACHE = null;

try {
  const entries = readdirSync(CACHE_BASE).filter((e) => /^\d+\.\d+\.\d+/.test(e));
  if (entries.length > 0) {
    entries.sort((a, b) => semverCompare(b, a)); // descending
    discoveredVersion = entries[0];
    TGT_CACHE = join(CACHE_BASE, discoveredVersion, 'skills', skillName, 'SKILL.md');
  } else {
    process.stderr.write(
      `Warning: no versioned cache dir found under ${CACHE_BASE}, skipping Target 1\n`,
    );
  }
} catch {
  process.stderr.write(
    `Warning: no versioned cache dir found under ${CACHE_BASE}, skipping Target 1\n`,
  );
}

const TGT_MARKETPLACE = join(MARKETPLACE_BASE, skillName, 'SKILL.md');

// ── Dry-run print & exit ──────────────────────────────────────────────────────
if (dryRun) {
  console.log('[dry-run] Computed paths:');
  console.log(`  SRC              = ${SRC}`);
  console.log(`  discovered version = ${discoveredVersion ?? '(none)'}`);
  console.log(`  TGT_CACHE        = ${TGT_CACHE ?? '(skipped — no cache dir)'}`);
  console.log(`  TGT_MARKETPLACE  = ${TGT_MARKETPLACE}`);
  console.log('');

  for (const [label, tgt] of [
    ['Target 1 (cache)', TGT_CACHE],
    ['Target 2 (marketplace)', TGT_MARKETPLACE],
  ]) {
    if (!tgt) {
      console.log(`  ${label}: SKIP (no cache base dir)`);
      continue;
    }
    const parentDir = dirname(tgt);
    if (!existsSync(parentDir)) {
      console.log(`  ${label}: SKIP (parent dir missing: ${parentDir})`);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(tgt);
    } catch {
      // does not exist
      console.log(`  ${label}: WOULD symlink (target missing) → ${tgt} -> ${SRC}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      console.log(`  ${label}: WOULD skip (already a symlink)`);
    } else {
      const stamp = nowStamp();
      console.log(
        `  ${label}: WOULD back up to ${tgt}.bak.${stamp}, then symlink → ${tgt} -> ${SRC}`,
      );
    }
  }

  process.exit(0);
}

// ── Real execution ────────────────────────────────────────────────────────────
const backups = []; // { from, to } — for rollback recipe

/**
 * Process one target: skip if symlink, backup-then-symlink if regular file,
 * symlink directly if missing.
 */
function processTarget(label, tgt) {
  if (!tgt) {
    // Caller already printed the warning
    return;
  }

  const parentDir = dirname(tgt);
  if (!existsSync(parentDir)) {
    process.stderr.write(`Warning: target parent does not exist: ${parentDir}, skipping\n`);
    return;
  }

  let stat;
  try {
    stat = lstatSync(tgt);
  } catch {
    // target does not exist — symlink directly
    symlinkSync(SRC, tgt);
    console.log(`[symlinked] ${tgt} -> ${SRC}`);
    return;
  }

  if (stat.isSymbolicLink()) {
    // Already a symlink — idempotent skip
    let pointsTo = '(unknown)';
    try {
      pointsTo = readlinkSync(tgt);
    } catch {
      // ignore — display-only
    }
    console.log(`[skipped] ${tgt} (already symlink -> ${pointsTo})`);
    return;
  }

  // Regular file — back up then symlink
  const stamp = nowStamp();
  const backupPath = `${tgt}.bak.${stamp}`;
  renameSync(tgt, backupPath);
  backups.push({ from: backupPath, to: tgt });
  symlinkSync(SRC, tgt);
  console.log(`[symlinked] ${tgt} -> ${SRC}  (original backed up: ${backupPath})`);
}

try {
  processTarget('Target 1 (cache)', TGT_CACHE);
  processTarget('Target 2 (marketplace)', TGT_MARKETPLACE);
} catch (err) {
  process.stderr.write(`Error: unexpected fs failure: ${err.message}\n`);
  process.exit(1);
}

// ── Rollback recipe ───────────────────────────────────────────────────────────
if (backups.length > 0) {
  console.log('');
  console.log('# Rollback recipe — paste to restore original files:');
  for (const { from, to } of backups) {
    console.log(`mv "${from}" "${to}"`);
  }
}

process.exit(0);

// ─── Hooks-mode helper ────────────────────────────────────────────────────────
/**
 * Symlink the two hook artefacts (hooks.json + guards/ dir) into both
 * install paths. Shares the backup+symlink discipline with skill mode.
 *
 * Called when the CLI target is the literal string "hooks".
 */
function runHooksMode({ dryRun }) {
  const HOOKS_SRC_DIR = join(PKG_ROOT, 'hooks');
  const SRC_HOOKS_JSON = join(HOOKS_SRC_DIR, 'hooks.json');
  const SRC_GUARDS_DIR = join(HOOKS_SRC_DIR, 'guards');

  if (!existsSync(SRC_HOOKS_JSON) || !existsSync(SRC_GUARDS_DIR)) {
    process.stderr.write(
      `Error: hooks sources missing under ${HOOKS_SRC_DIR}.\n` +
        `  expected: ${SRC_HOOKS_JSON}\n` +
        `  expected: ${SRC_GUARDS_DIR}\n`,
    );
    process.exit(3);
  }

  // Discover latest version dir under cache (re-using the semver compare
  // already defined in the main scope).
  let version = null;
  try {
    const entries = readdirSync(CACHE_BASE).filter((e) => /^\d+\.\d+\.\d+/.test(e));
    if (entries.length > 0) {
      entries.sort((a, b) => semverCompare(b, a));
      version = entries[0];
    }
  } catch {
    // CACHE_BASE missing — will be surfaced per-target below.
  }

  const targets = [];

  // Cache (versioned) targets — skipped when no version dir exists.
  if (version) {
    const cacheHooks = join(CACHE_BASE, version, 'hooks');
    targets.push(['cache/hooks.json', SRC_HOOKS_JSON, join(cacheHooks, 'hooks.json')]);
    targets.push(['cache/guards', SRC_GUARDS_DIR, join(cacheHooks, 'guards')]);
  } else {
    process.stderr.write(
      `Warning: no versioned cache dir under ${CACHE_BASE}, skipping cache targets\n`,
    );
  }

  // Marketplace targets — always attempted; skipped below if parent missing.
  const marketplaceHooks = join(
    HOME,
    '.claude/plugins/marketplaces/browzer-marketplace/hooks',
  );
  targets.push(['marketplace/hooks.json', SRC_HOOKS_JSON, join(marketplaceHooks, 'hooks.json')]);
  targets.push(['marketplace/guards', SRC_GUARDS_DIR, join(marketplaceHooks, 'guards')]);

  if (dryRun) {
    console.log('[dry-run] Hooks-mode resolved targets:');
    console.log(`  SRC_HOOKS_JSON = ${SRC_HOOKS_JSON}`);
    console.log(`  SRC_GUARDS_DIR = ${SRC_GUARDS_DIR}`);
    console.log(`  discovered version = ${version ?? '(none)'}`);
    console.log('');
    for (const [label, src, tgt] of targets) {
      describeTargetDry(label, src, tgt);
    }
    return;
  }

  // Real execution.
  const backups = [];
  for (const [label, src, tgt] of targets) {
    try {
      applyTarget(label, src, tgt, backups);
    } catch (err) {
      process.stderr.write(`Error processing ${label}: ${err.message}\n`);
    }
  }

  if (backups.length > 0) {
    console.log('');
    console.log('# Rollback recipe — paste to restore original hook artefacts:');
    for (const { from, to } of backups) {
      console.log(`rm -f "${to}" && mv "${from}" "${to}"`);
    }
  }
}

function describeTargetDry(label, src, tgt) {
  const parentDir = dirname(tgt);
  if (!existsSync(parentDir)) {
    console.log(`  ${label}: SKIP (parent dir missing: ${parentDir})`);
    return;
  }
  let stat;
  try {
    stat = lstatSync(tgt);
  } catch {
    console.log(`  ${label}: WOULD symlink (target missing) → ${tgt} -> ${src}`);
    return;
  }
  if (stat.isSymbolicLink()) {
    console.log(`  ${label}: WOULD skip (already a symlink)`);
    return;
  }
  console.log(
    `  ${label}: WOULD back up to ${tgt}.bak.<stamp>, then symlink → ${tgt} -> ${src}`,
  );
}

function applyTarget(label, src, tgt, backups) {
  const parentDir = dirname(tgt);
  if (!existsSync(parentDir)) {
    process.stderr.write(
      `Warning: target parent does not exist: ${parentDir}, skipping ${label}\n`,
    );
    return;
  }

  let stat;
  try {
    stat = lstatSync(tgt);
  } catch {
    symlinkSync(src, tgt);
    console.log(`[symlinked] ${tgt} -> ${src}`);
    return;
  }

  if (stat.isSymbolicLink()) {
    let pointsTo = '(unknown)';
    try {
      pointsTo = readlinkSync(tgt);
    } catch {
      // display-only
    }
    console.log(`[skipped] ${tgt} (already symlink -> ${pointsTo})`);
    return;
  }

  const stamp = nowStamp();
  const backupPath = `${tgt}.bak.${stamp}`;
  renameSync(tgt, backupPath);
  backups.push({ from: backupPath, to: tgt });
  symlinkSync(src, tgt);
  console.log(`[symlinked] ${tgt} -> ${src}  (original backed up: ${backupPath})`);
}
