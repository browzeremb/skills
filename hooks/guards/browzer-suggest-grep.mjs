#!/usr/bin/env node
import {
  CONFIG_SURFACE_RE,
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
} from './_util.mjs';

if (!isHookEnabled('suggest-grep')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Grep') process.exit(0);

const ti = input.tool_input ?? {};
const target = [ti.path, ti.pattern, ti.glob, ti.type, ti.include]
  .filter(Boolean)
  .join(' ');

if (CONFIG_SURFACE_RE.test(target)) process.exit(0);

// Surface the redirect via additionalContext so the model actually sees it.
// stderr from a hook that exits 0 is silent — that was the 2026-04-16 retro
// finding (§2.3): Grep was being called ~40x while the hook fired silently.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:
        'This repo is indexed by Browzer — Grep bypasses the hybrid vector + Graph RAG. ' +
        'Prefer `browzer explore "<query>" --json --save /tmp/explore.json` for the same intent: ' +
        'returns ranked file entries with exports/imports/importedBy/lines/score in a single call. ' +
        'Use Grep only when explore returns nothing useful for the specific string match.',
    },
  }),
);
process.exit(0);
