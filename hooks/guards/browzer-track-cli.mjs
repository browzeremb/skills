#!/usr/bin/env node
// PostToolUse(Bash) tracker for `browzer explore|search|deps|ask` invocations.
// Measures the actual byte payload the agent received (preferring `--save`
// targets when present, otherwise stdout) so CLI-driven savings show up in
// the token economy ledger alongside the tool-hook lanes.
import fs from 'node:fs';
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  stripQuoted,
  tokensOf,
  trackEvent,
} from './_util.mjs';

if (!isHookEnabled('track-cli')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Bash') process.exit(0);

const cmd = input.tool_input?.command ?? '';
if (typeof cmd !== 'string' || cmd.length === 0) process.exit(0);

const skeleton = stripQuoted(cmd);
const segments = skeleton.split(/&&|\|\|?|;|\n/);
const m = segments
  .map((s) => s.trim().match(/^browzer\s+(explore|search|deps|ask)\b/))
  .find(Boolean);

if (!m) process.exit(0);

const subverb = m[1];

let outputBytes = 0;
const saveMatch = skeleton.match(/--save[\s=]+(\S+)/);
if (saveMatch) {
  try {
    outputBytes = fs.statSync(saveMatch[1]).size;
  } catch {
    /* fallthrough to stdout */
  }
}
if (outputBytes === 0) {
  const stdout = input.tool_response?.stdout ?? '';
  outputBytes = Buffer.byteLength(String(stdout), 'utf8');
}

const payload = {
  ts: new Date().toISOString(),
  source: `hook-cli-${subverb}`,
  command: `Bash:browzer ${subverb}`,
  inputBytes: 0,
  outputBytes,
  savedTokens: tokensOf(outputBytes),
  savingsPct: 0,
  filterLevel: null,
  filterFailed: false,
  execMs: 0,
  sessionId: input.session_id ?? null,
  estimationMethod: 'measured',
};

await trackEvent(payload);

process.exit(0);
