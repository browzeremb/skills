#!/usr/bin/env node
// Lean Read advisory. Local stat-based size check + advisory only — no daemon
// round-trip. The previous implementation called daemon.Read + daemon.Track
// even though the rewrite path was reverted in 2026-04-16; the advisory is
// the only useful signal that survived.
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyPath,
  isHookEnabled,
  isInBrowzerWorkspace,
  NEVER_REWRITE_RE,
  readHookInput,
} from './_util.mjs';

if (!isHookEnabled('rewrite-read')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Read') process.exit(0);

const ti = input.tool_input ?? {};
const filePath = ti.file_path;
if (!filePath || typeof filePath !== 'string') process.exit(0);
if (classifyPath(filePath) !== 'code') process.exit(0);
if (ti.offset || ti.limit) process.exit(0);
if (NEVER_REWRITE_RE.test(filePath)) process.exit(0);

const absPath = path.resolve(filePath);
let size = 0;
try {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) process.exit(0);
  size = stat.size;
} catch {
  process.exit(0);
}

// Threshold: ~40KB ≈ 500 lines ≈ 10K tokens. Below this, advisory adds noise.
if (size < 40 * 1024) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:
        'This file is large (~' +
        Math.round(size / 1024) +
        'KB). Prefer `browzer explore "<symbol>"` for targeted code lookup, ' +
        'or `browzer read --filter=auto` for token-aware reads, before reading the whole file.',
    },
  }),
);
process.exit(0);
