#!/usr/bin/env node
/**
 * append-receipts.mjs — `## feature-acceptance` section in RECEIPTS.md
 *
 * Idempotent per ${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md.
 *
 * Usage: node append-receipts.mjs <featureId> [--dry-run] [--json]
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'feature-acceptance';
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

function readAcceptance(stagingDir) {
  const p = join(stagingDir, 'ACCEPTANCE.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const get = (re, def = '') => (fm[1].match(re) || [])[1] || def;
  return {
    mode: get(/^mode:\s*(\S+)/m),
    verdict: get(/^verdict:\s*(\S+)/m),
    acsTotal: parseInt(get(/^\s+acsTotal:\s*(\d+)/m, '0'), 10),
    acsPassed: parseInt(get(/^\s+acsPassed:\s*(\d+)/m, '0'), 10),
    acsFailed: parseInt(get(/^\s+acsFailed:\s*(\d+)/m, '0'), 10),
    acsDeferred: parseInt(get(/^\s+acsDeferred:\s*(\d+)/m, '0'), 10),
    nfrsPassed: parseInt(get(/^\s+nfrsPassed:\s*(\d+)/m, '0'), 10),
    nfrsFailed: parseInt(get(/^\s+nfrsFailed:\s*(\d+)/m, '0'), 10),
    metricsPassed: parseInt(get(/^\s+metricsPassed:\s*(\d+)/m, '0'), 10),
    metricsFailed: parseInt(get(/^\s+metricsFailed:\s*(\d+)/m, '0'), 10),
  };
}

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) return text.replace(re, newSection + '\n');
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
}

function renderSection(a) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: feature-acceptance`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Verdict');
  lines.push('');
  if (a) {
    lines.push(`verdict: \`${a.verdict}\` · mode: \`${a.mode}\``);
  } else {
    lines.push('_(ACCEPTANCE.md not found)_');
  }
  lines.push('');
  if (a) {
    lines.push('### AC verdicts');
    lines.push('');
    lines.push(
      `passed: ${a.acsPassed} · failed: ${a.acsFailed} · deferred: ${a.acsDeferred} · total: ${a.acsTotal}`,
    );
    lines.push('');
    lines.push('### NFR + metric verdicts');
    lines.push('');
    lines.push(
      `NFRs passed/failed: ${a.nfrsPassed}/${a.nfrsFailed} · metrics passed/failed: ${a.metricsPassed}/${a.metricsFailed}`,
    );
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
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  const summary = readAcceptance(stagingDir);
  const section = renderSection(summary);

  if (dryRun) {
    process.stdout.write(section + '\n');
    return;
  }
  const receiptsPath = join(stagingDir, 'RECEIPTS.md');
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
