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

// --- BROWZER_LLM=1 injection (WF-SYNC-2, 2026-05-04) ---
// Every `browzer ...` invocation gets BROWZER_LLM=1 prefixed so the per-mutation
// audit line is suppressed in agent shells. Done as a hook (instead of inline
// `export BROWZER_LLM=1` in skill bash) because each Bash tool call in Claude
// Code runs in an isolated shell — `export` in one call does NOT persist to
// the next. The previous `: "${BROWZER_LLM:=1}"; export` blocks (76871ee2 WS-3)
// were inert for this reason. The flag-equivalent --llm and per-call env are
// the only modes that actually work in agent context.
//
// Idempotence guards skip the prefix when:
//   - operator already set BROWZER_LLM=<anything> on this command line,
//   - operator already passed --llm or --llm=<value>,
//   - the command starts with a subshell `(` or brace-group `{` (we can't
//     safely prepend env there without breaking shell parsing),
//   - the leading token isn't `browzer` (compound `cmd && browzer ...` —
//     regex won't match; opt-out is implicit).
{
  const browzerCmdRe = /^\s*browzer(\s|$)/;
  if (browzerCmdRe.test(cmd)) {
    const alreadyHasEnv = /(^|\s)BROWZER_LLM=/.test(cmd);
    const alreadyHasFlag = /(^|\s)--llm(\s|=|$)/.test(cmd);
    const wrappedSubshell = /^\s*[({]/.test(cmd);
    if (!alreadyHasEnv && !alreadyHasFlag && !wrappedSubshell) {
      const newCmd = `BROWZER_LLM=1 ${cmd.replace(/^\s+/, '')}`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...input.tool_input, command: newCmd },
            additionalContext: `Browzer prefixed BROWZER_LLM=1 to suppress per-mutation audit telemetry (override: BROWZER_LLM=0 or --llm=0).`,
          },
        }),
      );
      process.exit(0);
    }
    // Leading `browzer` but opted out — exit clean; do not fall through to
    // the cat/head/tail rewrite (it can't match a browzer command anyway).
    process.exit(0);
  }
}

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
