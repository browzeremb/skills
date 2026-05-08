#!/usr/bin/env node
// Default: ALLOW + advisory (mirror of suggest-grep). Glob has legitimate uses
// the index can't serve (find newly created files, scaffolding paths). Hard
// block becomes opt-in via .browzer/config.json `hooks.glob.mode === "block"`.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_SURFACE_RE,
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  workspaceRootFor,
} from './_util.mjs';

if (!isHookEnabled('block-glob')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Glob') process.exit(0);

const ti = input.tool_input ?? {};
const target = [ti.path, ti.pattern, ti.glob, ti.type, ti.include]
  .filter(Boolean)
  .join(' ');

if (CONFIG_SURFACE_RE.test(target)) process.exit(0);

function readGlobMode() {
  const root = workspaceRootFor(process.cwd());
  if (!root) return 'soft';
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, '.browzer', 'config.json'), 'utf8'),
    );
    const m = cfg?.hooks?.glob?.mode;
    return m === 'block' ? 'block' : 'soft';
  } catch {
    return 'soft';
  }
}

const mode = readGlobMode();

const message =
  'Glob bypasses the workspace index. ' +
  'Prefer `browzer explore "<query>" --json --save /tmp/explore.json` for ranked, deduped, symbol-aware results. ' +
  'Use Glob only when looking for files the index cannot know about (newly created, scaffolded, or out-of-tree).';

if (mode === 'block') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
        additionalContext: message,
      },
    }),
  );
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: message,
    },
  }),
);
process.exit(0);
