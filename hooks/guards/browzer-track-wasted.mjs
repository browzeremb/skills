#!/usr/bin/env node
// PostToolUse(Bash) tracker for un-instrumented commands the agent ran instead
// of the indexed equivalents (recursive grep/rg, `find -name`, `ls -R`). Emits
// NEGATIVE `savedTokens` so the ledger surfaces wasted spend that should have
// been routed through `browzer explore|search|deps`.
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  stripQuoted,
  tokensOf,
  trackEvent,
} from './_util.mjs';

if (!isHookEnabled('track-wasted')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Bash') process.exit(0);

const cmd = input.tool_input?.command ?? '';
if (typeof cmd !== 'string' || cmd.length === 0) process.exit(0);

const skeleton = stripQuoted(cmd);
if (/^\s*browzer\s/.test(skeleton)) process.exit(0);

const PATTERNS = [
  { source: 'wasted-grep', re: /^\s*grep\s+.*-r\b/ },
  { source: 'wasted-grep', re: /^\s*grep\s+.*-R\b/ },
  { source: 'wasted-rg', re: /^\s*rg\b/ },
  { source: 'wasted-find', re: /^\s*find\s+.*\s+-name\b/ },
  { source: 'wasted-find', re: /^\s*find\s+.*\s+-iname\b/ },
  { source: 'wasted-find', re: /^\s*ls\s+.*-R\b/ },
];

let matched = null;
for (const p of PATTERNS) {
  if (p.re.test(skeleton)) {
    matched = p.source;
    break;
  }
}
if (!matched) process.exit(0);

const firstToken = skeleton.trim().split(/\s+/)[0] ?? '';
const stdout = input.tool_response?.stdout ?? '';
const outputBytes = Buffer.byteLength(String(stdout), 'utf8');

const payload = {
  ts: new Date().toISOString(),
  source: matched,
  command: `Bash:${firstToken}`,
  inputBytes: 0,
  outputBytes,
  savedTokens: -tokensOf(outputBytes),
  savingsPct: 0,
  filterLevel: null,
  filterFailed: false,
  execMs: 0,
  sessionId: input.session_id ?? null,
  estimationMethod: 'counterfactual',
};

await trackEvent(payload);

process.exit(0);
