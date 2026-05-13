#!/usr/bin/env node
/**
 * append-receipts.mjs — `## commit` section in RECEIPTS.md
 *
 * Idempotent per ${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md.
 *
 * Usage: node append-receipts.mjs <featureId> --sha <sha> --branch <branch> --files <comma-list> [--gates <json>]
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'commit';
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

function parseArgs(argv) {
  const out = { featureId: argv[0], files: [], gates: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') out.sha = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--files') out.files = argv[++i].split(',').filter(Boolean);
    else if (a === '--gates') {
      try {
        out.gates = JSON.parse(argv[++i]);
      } catch {
        out.gates = [];
      }
    } else if (a === '--bypass-reason') out.bypassReason = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
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
  lines.push(`- **Producer**: commit`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Commit');
  lines.push('');
  lines.push(
    `sha: \`${a.sha || '(unknown)'}\` · branch: \`${a.branch || '(unknown)'}\` · trailer: \`on-behalf-of: @browzeremb\``,
  );
  if (a.bypassReason) {
    lines.push('');
    lines.push(`⚠ bypass: ${a.bypassReason}`);
  }
  lines.push('');
  lines.push('### Files committed');
  lines.push('');
  if (a.files.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const f of a.files) lines.push(`- \`${f}\``);
  }
  lines.push('');
  if (a.gates.length > 0) {
    lines.push('### Veto checks');
    lines.push('');
    lines.push('| Gate | Pass | Evidence |');
    lines.push('| --- | --- | --- |');
    for (const g of a.gates) {
      lines.push(`| ${g.gate} | ${g.pass} | ${g.evidence} |`);
    }
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(args.featureId)) {
    die(
      'usage: append-receipts <featureId> --sha <sha> --branch <branch> --files <comma-list> [--gates <json>] [--bypass-reason <text>] [--dry-run]',
      2,
    );
  }
  const featDir = resolve(resolveRepoRoot(), 'docs', 'browzer', args.featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  const section = renderSection(args);
  if (args.dryRun) {
    process.stdout.write(section + '\n');
    return;
  }
  const receiptsPath = join(stagingDir, 'RECEIPTS.md');
  const prev = existsSync(receiptsPath)
    ? readFileSync(receiptsPath, 'utf8')
    : '';
  const action = new RegExp(`${BEGIN}`).test(prev) ? 'replaced' : 'appended';
  atomicWrite(receiptsPath, spliceSection(prev, section));
  console.log(`${action} ${PHASE} section in ${receiptsPath}`);
}

main();
