#!/usr/bin/env node
import {
  CONFIG_SURFACE_RE,
  daemonCall,
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
    savedTokens: tokensOf(40_000), // conservative estimate of avg blast
    savingsPct: 0,
    filterLevel: 'blocked',
    execMs: 0,
    sessionId: input.session_id ?? null,
    filterFailed: false,
  });
} catch {
  /* ignore */
}

process.stderr.write(
  `Glob blocked. This repo is indexed by Browzer — use ` +
    `\`browzer explore "<query>" --save /tmp/explore.json\` for ranked, deduped results across files. ` +
    `Override: set BROWZER_HOOK=off for this session.\n`,
);
process.exit(2);
