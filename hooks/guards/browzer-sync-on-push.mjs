#!/usr/bin/env node
// PostToolUse:Bash — when a push-class command runs, kick `browzer workspace sync`
// detached so the index refresh never blocks the agent loop. The previous
// implementation used spawnSync with a 5-minute timeout, which blocked the
// turn for up to 5 minutes after a routine push.
import { spawn } from 'node:child_process';
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  resolveBrowzerBinary,
} from './_util.mjs';

if (!isHookEnabled('sync-on-push')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const isGitPush = /\bgit\s+push\b/.test(cmd);
const isGhPush = /\bgh\s+(?:pr\s+(?:create|push)|repo\s+sync)\b/.test(cmd);
const isGlabPush = /\bglab\s+(?:mr\s+(?:create|push)|repo\s+push)\b/.test(cmd);

if (!(isGitPush || isGhPush || isGlabPush)) process.exit(0);

const browzerBin = resolveBrowzerBinary();
if (!browzerBin) process.exit(0);

try {
  const child = spawn(browzerBin, ['workspace', 'sync'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
} catch {
  /* never block the agent on spawn failure */
}

process.exit(0);
