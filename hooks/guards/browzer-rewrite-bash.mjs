#!/usr/bin/env node
import fs from 'node:fs';
import {
  classifyPath,
  isHookEnabled,
  isInBrowzerWorkspace,
  NEVER_REWRITE_RE,
  readHookInput,
} from './_util.mjs';

if (!isHookEnabled()) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Bash') process.exit(0);

const cmd = input.tool_input?.command;
if (typeof cmd !== 'string') process.exit(0);

// Match exactly: <verb> <single-token-path>; reject pipes, redirects, chains, flags.
const m = cmd.match(/^\s*(cat|head|tail|less|more)\s+([^\s|;&<>]+)\s*$/);
if (!m) process.exit(0);

const filePath = m[2];
if (classifyPath(filePath) !== 'code') process.exit(0);
if (NEVER_REWRITE_RE.test(filePath)) process.exit(0);

// Skip files small enough that the rewrite round-trip costs more than it saves.
// 500 lines is roughly 2-3k tokens — below this the daemon adds overhead with
// negligible savings, and the rewritten output would force the model to
// re-parse "Browzer optimized..." prose for raw content it could read directly.
try {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) process.exit(0);
  // Cheap heuristic: average line length ~80 bytes; skip if <40KB.
  // Avoids reading the whole file just to count lines.
  if (stat.size < 40 * 1024) process.exit(0);
} catch {
  process.exit(0);
}

const newCmd = `browzer read ${JSON.stringify(filePath)} --filter=auto`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input.tool_input, command: newCmd },
      additionalContext: `Browzer rewrote \`${cmd.trim()}\` → \`${newCmd}\` (token-economy filter applied).`,
    },
  }),
);
process.exit(0);
