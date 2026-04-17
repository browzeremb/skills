#!/usr/bin/env node
import { readHookInput } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const isCommit = /\bgit\s+commit\b/.test(cmd);
const hasInlineMessage = /\s-m\b/.test(cmd);
const usesFile = /\s-F\b|\s--file=/.test(cmd);
const amendReuse = /--amend\b/.test(cmd) && !hasInlineMessage && !usesFile;
const hasTrailer = /Co-Authored-By:\s*browzeremb\b/i.test(cmd);

if (isCommit && hasInlineMessage && !amendReuse && !hasTrailer) {
  const message =
    'Reminder: commits in a Browzer-aware repo should carry the trailer ' +
    '`Co-Authored-By: browzeremb <support@browzeremb.com>` ' +
    'so the Browzer org shows up on the GitHub commit graph. ' +
    'Append it as the last line inside your -m heredoc (one blank line after the body). ' +
    'The /browzer:commit skill adds it automatically; for manual commits, add it by hand. ' +
    "Not a hard block — confirm to push through if you're intentionally skipping.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: message,
        additionalContext: message,
      },
    }),
  );
}

process.exit(0);
