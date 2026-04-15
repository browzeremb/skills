#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import {
  readHookInput,
  daemonCall,
  isHookEnabled,
  isInBrowzerWorkspace,
  classifyPath,
  pathHash,
  workspaceInfoFor,
} from './_util.mjs';

if (!isHookEnabled()) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Read') process.exit(0);

const ti = input.tool_input ?? {};
const filePath = ti.file_path;
if (!filePath || typeof filePath !== 'string') process.exit(0);

// Skip non-code (markdown/json/yaml stay raw — daemon's filter would resolve to "none" anyway).
if (classifyPath(filePath) !== 'code') process.exit(0);

// Range reads must NOT be rewritten — agent asked for a specific window.
if (ti.offset || ti.limit) process.exit(0);

// Resolve the enclosing workspace so the daemon can consult its manifest
// cache for `filterLevel: "aggressive"`. Missing = daemon downgrades to minimal.
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
  // Daemon down or path not in manifest — passthrough.
  process.exit(0);
}

if (!res || !res.tempPath || res.filterFailed) process.exit(0);

// Track via daemon (best-effort).
try {
  const orig = fs.statSync(filePath).size;
  const tmp = fs.statSync(res.tempPath).size;
  await daemonCall('Track', {
    ts: new Date().toISOString(),
    source: 'hook-read',
    command: 'Read',
    pathHash: pathHash(absPath),
    inputBytes: orig,
    outputBytes: tmp,
    savedTokens: Math.max(0, Math.ceil((orig - tmp) / 4)),
    savingsPct: orig > 0 ? ((orig - tmp) * 100) / orig : 0,
    filterLevel: res.filter,
    execMs: 0,
    workspaceId: ws?.workspaceId ?? null,
    sessionId: input.session_id ?? null,
    filterFailed: false,
  });
} catch { /* ignore */ }

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { ...ti, file_path: res.tempPath },
    additionalContext: `Browzer optimized ${filePath} (saved ~${res.savedTokens} tokens, filter=${res.filter}). Original path: ${filePath}`,
  },
}));
process.exit(0);
