#!/usr/bin/env node
// Lean Read advisory. Local stat-based size check + advisory only — no daemon
// round-trip. The previous implementation called daemon.Read + daemon.Track
// even though the rewrite path was reverted in 2026-04-16; the advisory is
// the only useful signal that survived.
import fs from 'node:fs';
import path from 'node:path';
import { emitHookDelta } from '../_emit-hook-delta.mjs';
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
const LARGE_FILE_THRESHOLD = 40960;
if (size <= LARGE_FILE_THRESHOLD) process.exit(0);

// Token-economy gate (F-028): the compressed-head injection only pays off for
// files large enough that the head is a small fraction of the avoided cost.
// Files in the 40KB–160KB range get an advisory WITHOUT head injection. Files
// above 4× the base threshold get the full advisory + head.
const INJECTION_THRESHOLD = 4 * LARGE_FILE_THRESHOLD; // 163840 bytes
const includeHead = size > INJECTION_THRESHOLD;

// HEAD_BUF_BYTES caps the OS read to 5KB — well within the 50ms hook budget
// even for remote or slow filesystems (F-010). HEAD_LINES then limits the
// line count further so the advisory stays token-economical (F-028).
const HEAD_BUF_BYTES = 5120;
const HEAD_LINES = 60;

let head = '';
let binary = false;
if (includeHead) {
  try {
    const buf = Buffer.alloc(HEAD_BUF_BYTES);
    const fd = fs.openSync(absPath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, HEAD_BUF_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
    const chunk = buf.slice(0, bytesRead);

    // Binary detection (F-011): scan for null bytes. A prevalence > 0.5%
    // strongly indicates a non-UTF-8 binary file; skip head injection and
    // emit a size-only summary instead to avoid U+FFFD garbage in context.
    let nullCount = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (chunk[i] === 0) nullCount++;
    }
    if (bytesRead > 0 && nullCount / bytesRead > 0.005) {
      binary = true;
    } else {
      const raw = chunk.toString('utf8');
      const lines = raw.split('\n');
      head = lines.slice(0, HEAD_LINES).join('\n');
    }
  } catch {
    // Stat succeeded above; a read failure now means the file became
    // unreadable mid-hook — fall back to advisory-only.
  }
}

const summary = !includeHead
  ? { path: filePath, byteCount: size }
  : binary
    ? { path: filePath, byteCount: size, binary: true }
    : { path: filePath, byteCount: size, head };

const headLabel = !includeHead
  ? 'advisory-only — head skipped to preserve token economy'
  : binary
    ? 'binary file — head omitted'
    : `first ${HEAD_LINES} lines (5KB cap)`;

const out = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    additionalContext:
      'This file is large (~' +
      Math.round(size / 1024) +
      'KB, ' +
      size +
      ' bytes). ' +
      headLabel +
      ' — use `browzer explore "<symbol>"` for targeted lookup, ' +
      'or `browzer read --filter=auto` for token-aware reads, before requesting the whole file.\n\n' +
      '```json\n' +
      JSON.stringify(summary) +
      '\n```',
  },
});

// Best-effort saved-token telemetry (F-020). The delta is the full file size
// minus the injected summary bytes divided by 4 (flat token estimator). The
// call is detached — it resolves after process.exit() has been invoked —
// never blocks the ~50ms hook budget.
const injectedBytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');
const savedTokens = Math.max(0, Math.round((size - injectedBytes) / 4));
emitHookDelta({
  hook: 'browzer-rewrite-read',
  savedTokens,
  estimationMethod: 'estimated',
}).catch(() => {});

// Pipe payloads can exceed the kernel buffer (~8KB on macOS) when the
// head injection lands. Write fully before exiting so the parent never
// observes a truncated JSON envelope. `write(_, cb)` resolves after the
// kernel has drained the chunk; safe to exit then.
process.stdout.write(out, () => process.exit(0));
