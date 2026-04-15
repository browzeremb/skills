#!/usr/bin/env node
import { readHookInput, daemonCall, isHookEnabled, isInBrowzerWorkspace, tokensOf, CONFIG_SURFACE_RE } from './_util.mjs';

if (!isHookEnabled()) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Grep') process.exit(0);

const ti = input.tool_input ?? {};
const target = [ti.path, ti.pattern, ti.glob, ti.type, ti.include].filter(Boolean).join(' ');

if (CONFIG_SURFACE_RE.test(target)) process.exit(0);

try {
  await daemonCall('Track', {
    ts: new Date().toISOString(),
    source: 'hook-grep-suggested',
    command: 'Grep',
    inputBytes: 0,
    outputBytes: 0,
    savedTokens: tokensOf(8_000),
    savingsPct: 0,
    filterLevel: 'suggested',
    execMs: 0,
    sessionId: input.session_id ?? null,
    filterFailed: false,
  });
} catch { /* ignore */ }

process.stderr.write(
  `Reminder: this repo is indexed by Browzer. Grep bypasses the hybrid vector + Graph RAG. ` +
    `Prefer \`browzer explore "<query>" --save /tmp/explore.json\` — returns ranked files with exports/imports/score in a single call. ` +
    `Fall back to Grep only when explore returns nothing useful.\n`,
);
process.exit(0);
