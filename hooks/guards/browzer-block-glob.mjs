#!/usr/bin/env node
import {
  CONFIG_SURFACE_RE,
  daemonCall,
  ensureDaemon,
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  tokensOf,
} from './_util.mjs';

if (!isHookEnabled()) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Glob') process.exit(0);

const ti = input.tool_input ?? {};
const target = [ti.path, ti.pattern, ti.glob, ti.type, ti.include]
  .filter(Boolean)
  .join(' ');

// Whitelist: config / docs / out-of-index surfaces stay allowed.
if (CONFIG_SURFACE_RE.test(target)) process.exit(0);

// Best-effort tracking: count this as a missed-opportunity event.
try {
  await daemonCall('Track', {
    ts: new Date().toISOString(),
    source: 'hook-glob-blocked',
    command: 'Glob',
    inputBytes: 0,
    outputBytes: 0,
    savedTokens: tokensOf(40_000),
    savingsPct: 0,
    filterLevel: 'blocked',
    execMs: 0,
    sessionId: input.session_id ?? null,
    filterFailed: false,
  });
} catch {
  ensureDaemon();
}

const message =
  'Glob blocked. This repo is indexed by Browzer — use ' +
  '`browzer explore "<query>" --json --save /tmp/explore.json` for ranked, deduped results across files. ' +
  'Override: set BROWZER_HOOK=off for this session.';

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
// Keep legacy stderr + exit 2 for harnesses that don't honor the JSON
// `permissionDecision` shape — same dual-channel pattern used elsewhere.
process.stderr.write(`${message}\n`);
process.exit(2);
