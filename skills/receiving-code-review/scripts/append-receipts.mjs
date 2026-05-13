#!/usr/bin/env node
/**
 * append-receipts.mjs — `## receiving-code-review` section in RECEIPTS.md
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
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'receiving-code-review';
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

function parseFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

function readAggregate(featDir) {
  const p = join(featDir, 'RECEIVING_CODE_REVIEW.md');
  if (!existsSync(p)) return null;
  const fm = parseFm(readFileSync(p, 'utf8'));
  const total = parseInt((fm.match(/^\s*total:\s*(\d+)/m) || [])[1] || '0', 10);
  const fixed = parseInt((fm.match(/^\s*fixed:\s*(\d+)/m) || [])[1] || '0', 10);
  const techDebt = parseInt(
    (fm.match(/^\s*techDebt:\s*(\d+)/m) || [])[1] || '0',
    10,
  );
  const totalIterations = parseInt(
    (fm.match(/^\s*totalIterations:\s*(\d+)/m) || [])[1] || '0',
    10,
  );
  const scopeDeferred = parseInt(
    (fm.match(/^\s*scopeDeferred:\s*(\d+)/m) || [])[1] || '0',
    10,
  );
  const ladderExhausted = parseInt(
    (fm.match(/^\s*ladderExhausted:\s*(\d+)/m) || [])[1] || '0',
    10,
  );
  return {
    total,
    fixed,
    techDebt,
    totalIterations,
    scopeDeferred,
    ladderExhausted,
  };
}

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) return text.replace(re, newSection + '\n');
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
}

function renderSection(featureId, agg, fixFiles) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: receiving-code-review`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Fix outcomes');
  lines.push('');
  if (agg) {
    lines.push(
      `fixed: ${agg.fixed} · techDebt: ${agg.techDebt} · total: ${agg.total} · iterations: ${agg.totalIterations}`,
    );
  } else {
    lines.push('_(RECEIVING_CODE_REVIEW.md not found — counts unavailable)_');
  }
  lines.push('');
  lines.push('### Tech-debt breakdown');
  lines.push('');
  if (agg) {
    lines.push(
      `scopeDeferred: ${agg.scopeDeferred} · ladderExhausted: ${agg.ladderExhausted}`,
    );
  } else {
    lines.push('_(unavailable)_');
  }
  lines.push('');
  lines.push('### Per-finding files');
  lines.push('');
  if (fixFiles.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const f of fixFiles) lines.push(`- \`${f}\``);
  }
  lines.push('');
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

  const fixFiles = readdirSync(featDir)
    .filter((e) => /^FIX_F-\d+\.(completed|tech_debt)\.md$/.test(e))
    .sort();
  const agg = readAggregate(featDir);
  const section = renderSection(featureId, agg, fixFiles);

  if (dryRun) {
    process.stdout.write(section + '\n');
    return;
  }
  const receiptsPath = join(featDir, 'RECEIPTS.md');
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
