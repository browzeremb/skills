#!/usr/bin/env node
import { readHookInput, isHookEnabled, isInBrowzerWorkspace, classifyPath } from './_util.mjs';

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

const newCmd = `browzer read ${JSON.stringify(filePath)} --filter=auto`;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { ...input.tool_input, command: newCmd },
    additionalContext: `Browzer rewrote \`${cmd.trim()}\` → \`${newCmd}\` (token-economy filter applied).`,
  },
}));
process.exit(0);
