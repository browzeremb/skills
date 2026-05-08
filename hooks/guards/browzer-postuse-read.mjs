#!/usr/bin/env node
// PostToolUse(Read) tracker. Heuristic-only mode: the shadow daemon `Read`
// call was removed (F-010) to avoid doubling the Read latency for every
// code Read ≥40KB. The 0.4 multiplier is calibrated against ResolveAuto's
// `stripComments` savings (the minimal-tier downgrade). Purely
// observational — never mutates `tool_input.file_path` or
// `tool_response.content`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyPath,
  isHookEnabled,
  isInBrowzerWorkspace,
  NEVER_REWRITE_RE,
  readHookInput,
  tokensOf,
  trackEvent,
  workspaceRootFor,
} from './_util.mjs';

if (!isHookEnabled('postuse-read')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Read') process.exit(0);

const ti = input.tool_input ?? {};
const filePath = ti.file_path;
if (!filePath || typeof filePath !== 'string') process.exit(0);
if (classifyPath(filePath) !== 'code') process.exit(0);
if (NEVER_REWRITE_RE.test(filePath)) process.exit(0);

const absPath = path.resolve(filePath);
let originalSize = 0;
try {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) process.exit(0);
  originalSize = stat.size;
} catch {
  process.exit(0);
}

if (originalSize < 40 * 1024) process.exit(0);

const pathHash = crypto
  .createHash('sha256')
  .update(absPath)
  .digest('hex')
  .slice(0, 12);

const sessionId = input.session_id ?? null;
const workspaceId = workspaceRootFor(process.cwd()) ?? null;

// Heuristic-only: 0.4 mirrors the minimal-tier stripComments savings from
// the daemon's ResolveAuto path. No daemon round-trip, no shadow filter.
const savedTokens = Math.round(tokensOf(originalSize) * 0.4);
const filterLevel = 'auto';
const filterFailed = false;
const estimationMethod = 'estimated';

const totalTokens = tokensOf(originalSize) || 1;
const savingsPct = (savedTokens / totalTokens) * 100;

const payload = {
  ts: new Date().toISOString(),
  source: 'hook-read',
  command: 'Read',
  inputBytes: 0,
  outputBytes: 0,
  savedTokens,
  savingsPct,
  filterLevel,
  filterFailed,
  execMs: 0,
  sessionId,
  pathHash,
  estimationMethod,
};

await trackEvent(payload);

process.exit(0);
