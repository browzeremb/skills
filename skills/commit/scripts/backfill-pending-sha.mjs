#!/usr/bin/env node
// backfill-pending-sha.mjs — replace `**Commits**: pending …` placeholders in a
// markdown file with the resolved short-SHA, line-by-line and value-only.
//
// Why this exists:
//   The commit skill used to embed a Node script via heredoc + `node -e "$VAR"`.
//   Inline scripts have no fixture coverage and the same skill explicitly forbids
//   inline `sed` patterns for the same reason. This file is the fixture-backed
//   equivalent: a real .mjs that the audit suite + integration tests exercise.
//
// Usage:
//   node scripts/backfill-pending-sha.mjs --file <md> --sha <short-sha> --mode dry-run|apply
//   node scripts/backfill-pending-sha.mjs <md> <sha> [dry-run|apply]   (positional alias)
//
// Behaviour:
//   - Captures: prefix + 'pending' + (consumed remainder up to '.') + period + trailing prose.
//   - Preserves trailing prose so `— implementing branch \`main\`.` survives the rewrite.
//   - Dry-run prints `<file>: N edit(s) staged` and writes nothing.
//   - Apply  writes the file in place and prints `<file>: N edit(s) applied`.
//   - Exit codes: 0 success (regardless of edit count), 1 usage error, 2 IO error.

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stderr } from 'node:process';

function parseArgs(raw) {
  const out = { file: null, sha: null, mode: 'dry-run' };
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--file') out.file = raw[++i];
    else if (a === '--sha') out.sha = raw[++i];
    else if (a === '--mode') out.mode = raw[++i];
    else pos.push(a);
  }
  if (!out.file && pos[0]) out.file = pos[0];
  if (!out.sha && pos[1]) out.sha = pos[1];
  if (pos[2] && (pos[2] === 'apply' || pos[2] === 'dry-run')) out.mode = pos[2];
  return out;
}

const args = parseArgs(argv.slice(2));
if (!args.file || !args.sha) {
  stderr.write(
    'usage: backfill-pending-sha.mjs --file <md> --sha <short-sha> --mode dry-run|apply\n',
  );
  exit(1);
}
if (args.mode !== 'dry-run' && args.mode !== 'apply') {
  stderr.write(`unknown --mode "${args.mode}" (expected dry-run|apply)\n`);
  exit(1);
}

let src;
try {
  src = readFileSync(args.file, 'utf8');
} catch (err) {
  stderr.write(`read failed: ${args.file}: ${err.message}\n`);
  exit(2);
}

const lines = src.split('\n');
let edits = 0;
const out = lines.map((line) => {
  // prefix = leading whitespace, optional list marker (`-` or `*`), `**Commits**:` + spaces
  // rest   = everything after the literal `pending` token (preserved verbatim).
  //          The placeholder appears in three observed shapes:
  //            "pending"                       → rest = ""
  //            "pending."                      → rest = "."
  //            "pending — implementing branch …" → rest = " — implementing branch …"
  //          We always emit `<sha>.` and re-attach the rest so trailing prose
  //          ("— implementing branch `main`.") survives. A redundant leading
  //          period in `rest` is stripped because we add our own.
  const m = line.match(/^(\s*[-*]?\s*\*\*Commits\*\*:\s*)pending(.*)$/);
  if (!m) return line;
  edits++;
  const [, prefix, raw] = m;
  const rest = raw.startsWith('.') ? raw.slice(1) : raw;
  return `${prefix}\`${args.sha}\`.${rest}`;
});

if (args.mode === 'apply') {
  try {
    writeFileSync(args.file, out.join('\n'));
  } catch (err) {
    stderr.write(`write failed: ${args.file}: ${err.message}\n`);
    exit(2);
  }
  process.stdout.write(`${args.file}: ${edits} edit(s) applied\n`);
} else {
  process.stdout.write(`${args.file}: ${edits} edit(s) staged\n`);
}
