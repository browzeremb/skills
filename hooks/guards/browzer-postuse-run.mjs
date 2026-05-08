#!/usr/bin/env node
// PostToolUse(Bash) hook: when browzer explore/search/deps/ask returns JSON
// with >10 entries, inject an additionalContext summary (top-5 path+score)
// so the model gets a compact orientation without parsing the full file.

import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
} from './_util.mjs';

if (!isHookEnabled('postuse-run')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Bash') process.exit(0);

const cmd = input.tool_input?.command ?? '';

// Match: browzer explore/search/deps/ask ... --json
const BROWZER_JSON_RE =
  /^\s*(?:BROWZER_\w+=\S+\s+)*browzer\s+(explore|search|deps|ask)\b.*--json\b/;
if (!BROWZER_JSON_RE.test(cmd)) process.exit(0);

// Get stdout from tool response
const stdout =
  input.tool_response?.stdout ?? input.tool_response?.content ?? '';
if (!stdout || typeof stdout !== 'string') process.exit(0);

// Try to parse as browzer JSON response
let entries = [];
try {
  const parsed = JSON.parse(stdout);
  entries = parsed?.entries ?? parsed?.data ?? [];
  if (!Array.isArray(entries)) process.exit(0);
} catch {
  // Not JSON or not parseable — skip
  process.exit(0);
}

// Only inject summary when > 10 entries
const THRESHOLD = 10;
if (entries.length <= THRESHOLD) process.exit(0);

// Build top-5 summary
const top5 = entries
  .slice(0, 5)
  .map((e, i) => {
    const path = e?.path ?? e?.url ?? e?.file ?? '?';
    const score =
      typeof e?.score === 'number' ? ` (${e.score.toFixed(3)})` : '';
    return `  ${i + 1}. ${path}${score}`;
  })
  .join('\n');

const summary = [
  `[browzer] ${entries.length} entries returned. Top 5:`,
  top5,
  `  … full results in --save file or stdout above.`,
].join('\n');

process.stdout.write(JSON.stringify({ additionalContext: summary }));
process.exit(0);
