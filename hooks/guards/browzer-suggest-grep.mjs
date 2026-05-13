#!/usr/bin/env node
import {
  CONFIG_SURFACE_RE,
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  sessionBannerEmittedOnce,
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

// Once-per-session dedup. The advisory text never changes between fires;
// re-emitting on every Grep accumulates ~400 chars of identical prose per
// call (~8 KB across a 20-Grep feature run). One emission is enough — the
// agent learns the redirect from the first banner and benefits from a
// silent passthrough on subsequent Greps. The 2026-04-16 retro that
// motivated this advisory in the first place is still satisfied: the model
// sees the redirect at least once per session.
if (sessionBannerEmittedOnce('.browzer-suggest-grep-banner')) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:
        'This repo is indexed by Browzer — Grep bypasses the hybrid vector + Graph RAG. ' +
        'Prefer `browzer explore "<query>" --json --save /tmp/explore.json` for the same intent: ' +
        'returns ranked file entries with exports/imports/importedBy/lines/score in a single call. ' +
        'Use Grep only when explore returns nothing useful for the specific string match. ' +
        '(This advisory emits once per session.)',
    },
  }),
);
process.exit(0);
