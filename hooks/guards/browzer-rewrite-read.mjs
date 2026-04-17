#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyPath,
  daemonCall,
  isHookEnabled,
  isInBrowzerWorkspace,
  NEVER_REWRITE_RE,
  pathHash,
  readHookInput,
  workspaceInfoFor,
} from './_util.mjs';

if (!isHookEnabled()) process.exit(0);
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
const ws = workspaceInfoFor(path.dirname(absPath));

let res;
try {
  res = await daemonCall('Read', {
    path: absPath,
    filterLevel: 'auto',
    sessionId: input.session_id ?? null,
    workspaceId: ws?.workspaceId ?? null,
  });
} catch {
  process.exit(0);
}

if (!res || res.filterFailed) process.exit(0);

const savedTokens = Number(res.savedTokens ?? 0);
const filter = String(res.filter ?? '');

// Bypass when there is no meaningful savings:
//   - filter=minimal means the daemon found no slice to remove
//   - savedTokens<50 means the daemon could trim a tiny region but the
//     overhead is not worth the round-trip (folds 2026-04-16 retro item #9)
if (filter === 'minimal' || savedTokens < 50) process.exit(0);

// IMPORTANT: do NOT mutate `tool_input.file_path`. The harness tracks reads
// by the literal file_path string; swapping to res.tempPath caused 6+
// Edit failures in the 2026-04-16 session ("File has not been read yet").
// Surface the daemon's savings as advisory `additionalContext` only.
try {
  const orig = fs.statSync(filePath).size;
  await daemonCall('Track', {
    ts: new Date().toISOString(),
    source: 'hook-read',
    command: 'Read',
    pathHash: pathHash(absPath),
    inputBytes: orig,
    outputBytes: orig,
    savedTokens: 0,
    savingsPct: 0,
    filterLevel: filter,
    execMs: 0,
    workspaceId: ws?.workspaceId ?? null,
    sessionId: input.session_id ?? null,
    filterFailed: false,
  });
} catch {
  /* ignore */
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:
        `Browzer indexed: \`${filePath}\` is ~${savedTokens} tokens larger than the ` +
        `relevant slice (filter=${filter}). For targeted access prefer ` +
        `\`browzer explore "<symbol>" --json --save /tmp/explore.json\` ` +
        `or call Read with offset+limit on the relevant section.`,
    },
  }),
);
process.exit(0);
