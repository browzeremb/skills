#!/usr/bin/env node
/**
 * append-receipts.mjs — `## brainstorming` section in RECEIPTS.md
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PHASE = 'brainstorming';
const BEGIN = `<!-- receipts:${PHASE}:BEGIN -->`;
const END = `<!-- receipts:${PHASE}:END -->`;

function die(msg, code = 1) {
  process.stderr.write(`append-receipts(${PHASE}): ${msg}\n`);
  process.exit(code);
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

function atomicWrite(path, content) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function spliceSection(text, newSection) {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
  if (re.test(text)) return text.replace(re, newSection + '\n');
  return (text.trimEnd() + '\n\n' + newSection + '\n').replace(/^\n+/, '');
}

function readBriefSummary(featDir) {
  const p = join(featDir, 'BRIEF.md');
  if (!existsSync(p)) return null;
  const fm =
    (readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  // Count researchTools[]
  const research = (fm.match(/^\s+- tool:/gm) || []).length;
  const proposals = (fm.match(/^\s+- term:/gm) || []).length;
  const gaps = (fm.match(/^\s+- dimension:/gm) || []).length;
  return { research, proposals, gaps };
}

function renderSection(s) {
  const lines = [];
  lines.push(BEGIN);
  lines.push(`## ${PHASE}`);
  lines.push('');
  lines.push(`- **Phase**: ${PHASE}`);
  lines.push(`- **Producer**: brainstorming`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Run id**: ${process.pid}-${Date.now()}`);
  lines.push('');
  lines.push('### Research queries');
  lines.push('');
  if (!s) {
    lines.push('_(BRIEF.md not found)_');
  } else {
    lines.push(`${s.research} research call(s) recorded`);
  }
  lines.push('');
  lines.push('### Clarifications resolved');
  lines.push('');
  if (s) {
    lines.push(`${s.gaps} dimension(s) interviewed and resolved`);
  } else {
    lines.push('_(unavailable)_');
  }
  lines.push('');
  if (s && s.proposals > 0) {
    lines.push('### Search-trigger proposals');
    lines.push('');
    lines.push(
      `${s.proposals} candidate term(s) proposed for \`.browzer/search-triggers.json\` — operator approval pending`,
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
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: append-receipts <featureId> [--dry-run]', 2);
  }
  const featDir = resolve(resolveRepoRoot(), 'docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);

  const summary = readBriefSummary(featDir);
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
  console.log(`${action} ${PHASE} section in ${receiptsPath}`);
}

main();
