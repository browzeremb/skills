#!/usr/bin/env node
/**
 * append-receipts.mjs — `## finalize-feature` section in RECEIPTS.md
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'finalize-feature';
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

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) return text.replace(re, newSection + '\n');
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
}

function renderSection(inputs, headings) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: finalize-feature`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Inputs read');
  lines.push('');
  for (const i of inputs) lines.push(`- \`${i}\``);
  lines.push('');
  lines.push('### Sections rendered');
  lines.push('');
  for (const h of headings) lines.push(`- ${h}`);
  lines.push('');
  lines.push(END);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const featureId = args[0];
  const dryRun = args.includes('--dry-run');
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: append-receipts <featureId> [--dry-run]', 2);
  }
  const featDir = resolve(resolveRepoRoot(), 'docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  const expected = [
    'PRD.md',
    'EXPLORATION.md',
    'ACCEPTANCE.md',
    'CODE_REVIEW.md',
    'RECEIVING_CODE_REVIEW.md',
    'TESTS.md',
    'DOC_PATCHES.md',
  ];
  const inputs = expected.filter((f) => existsSync(join(stagingDir, f)));
  inputs.push(
    ...readdirSync(stagingDir)
      .filter((e) => /^TASK_\d+\.completed\.md$/.test(e))
      .sort(),
  );

  // README.md is the only artefact at the feat root (committed); every other
  // workflow file lives in staging/.
  const readmePath = join(featDir, 'README.md');
  const headings = [];
  if (existsSync(readmePath)) {
    const text = readFileSync(readmePath, 'utf8');
    for (const m of text.matchAll(/^## (.+)$/gm)) headings.push(m[1]);
  }

  const section = renderSection(inputs, headings);
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
  console.log(`${action} ${PHASE} section in ${receiptsPath}`);
}

main();
