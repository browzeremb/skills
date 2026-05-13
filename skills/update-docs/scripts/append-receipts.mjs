#!/usr/bin/env node
/**
 * append-receipts.mjs — `## update-docs` section in RECEIPTS.md
 *
 * Idempotent per ${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md.
 *
 * Usage: node append-receipts.mjs <featureId> [--dry-run] [--json]
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'update-docs';
const BEGIN = `<!-- receipts:${PHASE}:BEGIN -->`;
const END = `<!-- receipts:${PHASE}:END -->`;

function die(msg, code = 1) {
  process.stderr.write(`append-receipts(${PHASE}): ${msg}\n`);
  process.exit(code);
}

function atomicWrite(path, content) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// Resolve the host repo root by preferring an env hint, then walking up for a
// `.git` or `.browzer/config.json` marker. Falls back to `process.cwd()` so
// existing test fixtures that drive the script from a sandbox cwd keep
// working unchanged.
function resolveRepoRoot() {
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && existsSync(envRoot)) return envRoot;
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, '.browzer', 'config.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function scanReceipts(featureId) {
  const SCAN_ROOTS = [tmpdir(), '/tmp'];
  const seen = new Set();
  const items = [];
  for (const root of SCAN_ROOTS) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!new RegExp(`^update-docs-${featureId}-[a-z0-9-]+\\.json$`).test(e))
        continue;
      if (seen.has(e)) continue;
      seen.add(e);
      const full = join(root, e);
      try {
        items.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

function readPatches(featDir) {
  const p = join(featDir, 'DOC_PATCHES.md');
  if (!existsSync(p)) return null;
  const fm = readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  return {
    skipped: /^skipped:\s*true/m.test(fm[1]),
    candidates: parseInt(
      (fm[1].match(/^\s+candidatesConsidered:\s*(\d+)/m) || [])[1] || '0',
      10,
    ),
    patches: parseInt(
      (fm[1].match(/^\s+patchesApplied:\s*(\d+)/m) || [])[1] || '0',
      10,
    ),
    enoent: parseInt(
      (fm[1].match(/^\s+enoentFixed:\s*(\d+)/m) || [])[1] || '0',
      10,
    ),
  };
}

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) return text.replace(re, newSection + '\n');
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
}

function renderSection(p, receipts) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: update-docs`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Patch outcomes');
  lines.push('');
  if (!p) {
    lines.push('_(DOC_PATCHES.md not found — counts unavailable)_');
  } else if (p.skipped) {
    lines.push('skipped: true (no exported-symbol changes)');
  } else {
    lines.push(
      `candidates: ${p.candidates} · patched: ${p.patches} · enoent fixed: ${p.enoent}`,
    );
  }
  lines.push('');
  if (receipts.length > 0) {
    lines.push('### Discovery receipts');
    lines.push('');
    for (const r of receipts) lines.push(`- \`${r.path}\``);
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const featureId = args[0];
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: append-receipts <featureId> [--dry-run] [--json]', 2);
  }
  const featDir = resolve(resolveRepoRoot(), 'docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);

  const patches = readPatches(featDir);
  const receipts = scanReceipts(featureId);
  const section = renderSection(patches, receipts);

  if (dryRun) {
    process.stdout.write(section + '\n');
    return;
  }
  const receiptsPath = join(featDir, 'RECEIPTS.md');
  const prev = existsSync(receiptsPath)
    ? readFileSync(receiptsPath, 'utf8')
    : '';
  const action = new RegExp(`${BEGIN}`).test(prev) ? 'replaced' : 'appended';
  atomicWrite(receiptsPath, spliceSection(prev, section));
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ phase: PHASE, featureId, action }) + '\n',
    );
  } else {
    console.log(`${action} ${PHASE} section in ${receiptsPath}`);
  }
}

main();
