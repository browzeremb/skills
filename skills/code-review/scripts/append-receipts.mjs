#!/usr/bin/env node
/**
 * append-receipts.mjs — `## code-review` section in RECEIPTS.md
 *
 * Idempotent: re-run produces exactly one section. Pattern documented in
 * ${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md.
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
import { join, resolve, basename, dirname } from 'node:path';

const PHASE = 'code-review';
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
      if (!new RegExp(`^${PHASE}-${featureId}-[a-z0-9-]+\\.json$`).test(e))
        continue;
      if (seen.has(e)) continue;
      seen.add(e);
      const full = join(root, e);
      try {
        const txt = readFileSync(full, 'utf8');
        const j = JSON.parse(txt);
        items.push({ path: full, mtime: statSync(full).mtimeMs, content: j });
      } catch {}
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

function loadAggregate(stagingDir) {
  const aggPath = join(stagingDir, 'CODE_REVIEW.md');
  if (!existsSync(aggPath)) return null;
  const text = readFileSync(aggPath, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  // Cheap key extraction (we only need a few scalar fields here)
  const counts = {
    high: parseInt((fm[1].match(/^\s+high:\s*(\d+)/m) || [])[1] || '0', 10),
    medium: parseInt((fm[1].match(/^\s+medium:\s*(\d+)/m) || [])[1] || '0', 10),
    low: parseInt((fm[1].match(/^\s+low:\s*(\d+)/m) || [])[1] || '0', 10),
  };
  const total = parseInt(
    (fm[1].match(/^totalFindings:\s*(\d+)/m) || [])[1] || '0',
    10,
  );
  const matched = /matched:\s*true/.test(fm[1]);
  return { total, counts, matched };
}

function discoverLanes(stagingDir) {
  return readdirSync(stagingDir)
    .filter((e) => /^CODE_REVIEW\.[a-z0-9-]+\.md$/.test(e))
    .filter((e) => e !== 'CODE_REVIEW.md')
    .map((e) => e.replace(/^CODE_REVIEW\.|\.md$/g, ''));
}

function renderSection(featureId, agg, lanes, receipts) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: code-review`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Lane dispatches');
  lines.push('');
  lines.push('| Lane | Lane file |');
  lines.push('| --- | --- |');
  for (const l of lanes) lines.push(`| \`${l}\` | \`CODE_REVIEW.${l}.md\` |`);
  lines.push('');
  lines.push('### Severity counts');
  lines.push('');
  if (agg) {
    lines.push(
      `high: ${agg.counts.high} · medium: ${agg.counts.medium} · low: ${agg.counts.low} · total: ${agg.total}`,
    );
  } else {
    lines.push('_(CODE_REVIEW.md not found — counts unavailable)_');
  }
  lines.push('');
  lines.push('### Sensitive-path gate');
  lines.push('');
  if (agg) {
    lines.push(`matched: \`${agg.matched}\``);
  } else {
    lines.push('_(unavailable)_');
  }
  lines.push('');
  if (receipts.length > 0) {
    lines.push('### Discovery receipts scanned');
    lines.push('');
    for (const r of receipts) lines.push(`- \`${r.path}\``);
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) {
    return text.replace(re, newSection + '\n');
  }
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
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
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );
  const receiptsPath = join(stagingDir, 'RECEIPTS.md');

  const agg = loadAggregate(stagingDir);
  const lanes = discoverLanes(stagingDir);
  const receipts = scanReceipts(featureId);
  const section = renderSection(featureId, agg, lanes, receipts);

  if (dryRun) {
    process.stdout.write(section + '\n');
    return;
  }
  const prev = existsSync(receiptsPath)
    ? readFileSync(receiptsPath, 'utf8')
    : '';
  const action = new RegExp(`${BEGIN}`).test(prev) ? 'replaced' : 'appended';
  const next = spliceSection(prev, section);
  atomicWrite(receiptsPath, next);
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ phase: PHASE, featureId, action, bytes: next.length }) +
        '\n',
    );
  } else {
    console.log(`${action} ${PHASE} section in ${receiptsPath}`);
  }
}

main();
