#!/usr/bin/env node
// PostToolUse Edit|Write: when the touched file is inside an indexed
// workspace and looks like indexable content (markdown / pdf / source),
// kick `browzer sync --paths <file>` detached so the next semantic search
// sees the change. Closes the "stale index between manual syncs" gap.
//
// Always non-blocking: detached spawn().unref(); we never wait for the sync.
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  resolveBrowzerBinary,
} from './_util.mjs';

if (!isHookEnabled('incremental-sync')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Edit' && input?.tool_name !== 'Write')
  process.exit(0);

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || filePath.length === 0) process.exit(0);

const ext = path.extname(filePath).toLowerCase();
// Only sync content the index actually uses. Source files participate in the
// graph index; markdown/pdf participate in the docs index.
const INDEXABLE_EXT = new Set([
  '.md',
  '.mdx',
  '.pdf',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.py',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
]);
if (!INDEXABLE_EXT.has(ext)) process.exit(0);

const browzerBin = resolveBrowzerBinary();
if (!browzerBin) process.exit(0);

try {
  const child = spawn(browzerBin, ['sync', '--paths', filePath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
} catch {
  /* swallow — never block on spawn failure */
}

process.exit(0);
