#!/usr/bin/env node
// PostToolUse(Grep) tracker. Measures the actual output bytes the agent
// received from a Grep call and emits a `hook-grep-suggested` Track event so
// the token economy ledger reflects real spend instead of canned estimates.
import {
  CONFIG_SURFACE_RE,
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  tokensOf,
  trackEvent,
} from './_util.mjs';

if (!isHookEnabled('postuse-grep')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Grep') process.exit(0);

const ti = input.tool_input ?? {};
const target = [ti.path, ti.pattern, ti.glob, ti.type, ti.include]
  .filter(Boolean)
  .join(' ');

if (CONFIG_SURFACE_RE.test(target)) process.exit(0);

const tr = input.tool_response ?? {};
const content = tr.content ?? tr.stdout ?? '';
const outputBytes = Buffer.byteLength(String(content), 'utf8');

const payload = {
  ts: new Date().toISOString(),
  source: 'hook-grep-suggested',
  command: 'Grep',
  inputBytes: 0,
  outputBytes,
  savedTokens: tokensOf(outputBytes),
  savingsPct: 0,
  filterLevel: 'suggested',
  filterFailed: false,
  execMs: 0,
  sessionId: input.session_id ?? null,
  estimationMethod: 'measured',
};

await trackEvent(payload);

process.exit(0);
