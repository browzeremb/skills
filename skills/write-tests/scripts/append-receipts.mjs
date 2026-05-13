#!/usr/bin/env node
/**
 * append-receipts.mjs — `## write-tests` section in RECEIPTS.md
 *
 * Idempotent per ${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md.
 *
 * Usage: node append-receipts.mjs <featureId> [--dry-run] [--json]
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'write-tests';
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

function readTestsSummary(featDir) {
  const p = join(featDir, 'TESTS.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const get = (re) => (fm[1].match(re) || [])[1];
  return {
    runner: get(/^runner:\s*(\S+)/m),
    mutationTool: get(/^mutationTool:\s*(\S+)/m),
    skipped: /^skipped:\s*true/m.test(fm[1]),
    totalTests: parseInt(get(/^\s+totalTests:\s*(\d+)/m) || '0', 10),
    killedMutants: parseInt(get(/^\s+killedMutants:\s*(\d+)/m) || '0', 10),
    totalMutants: parseInt(get(/^\s+totalMutants:\s*(\d+)/m) || '0', 10),
    killRate: parseFloat(get(/^\s+killRate:\s*([0-9.]+)/m) || '0'),
    coverageGaps: parseInt(get(/^\s+coverageGaps:\s*(\d+)/m) || '0', 10),
  };
}

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) return text.replace(re, newSection + '\n');
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
}

function renderSection(s) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: write-tests`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Test outcomes');
  lines.push('');
  if (!s) {
    lines.push('_(TESTS.md not found — counts unavailable)_');
  } else if (s.skipped) {
    lines.push('skipped: true');
  } else {
    lines.push(`runner: ${s.runner} · mutationTool: ${s.mutationTool}`);
    lines.push(
      `totalTests: ${s.totalTests} · killed: ${s.killedMutants} · total mutants: ${s.totalMutants} · kill rate: ${(s.killRate * 100).toFixed(0)}%`,
    );
  }
  lines.push('');
  lines.push('### Coverage gaps');
  lines.push('');
  if (!s) {
    lines.push('_(unavailable)_');
  } else {
    lines.push(`${s.coverageGaps} gap(s) — see TESTS.md body when > 0`);
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

  const summary = readTestsSummary(featDir);
  const section = renderSection(summary);

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
