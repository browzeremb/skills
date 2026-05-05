#!/usr/bin/env node
import { readHookInput } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const isCommit = /\bgit\s+commit\b/.test(cmd);
const hasInlineMessage = /\s-m\b/.test(cmd);
const usesFile = /\s-F\b|\s--file=/.test(cmd);
const amendReuse = /--amend\b/.test(cmd) && !hasInlineMessage && !usesFile;
// `on-behalf-of:` is the canonical org-attribution trailer per GitHub's docs
// — `Co-authored-by:` is for human collaborators and does NOT produce the
// "on behalf of @browzeremb" badge in the commit/PR UI. The legacy form is
// still accepted here so historical scripts don't suddenly trip the gate;
// new commits should use `on-behalf-of: @browzeremb <...>`.
const hasOnBehalfOf =
  /on-behalf-of:\s*@browzeremb\s*<274369678\+browzeremb@users\.noreply\.github\.com>/i.test(
    cmd,
  );
const hasLegacyCoAuthor =
  /Co-authored-by:\s*browzeremb\s*<274369678\+browzeremb@users\.noreply\.github\.com>/i.test(
    cmd,
  );
const hasTrailer = hasOnBehalfOf || hasLegacyCoAuthor;

if (isCommit && hasInlineMessage && !amendReuse && !hasTrailer) {
  const message =
    'Reminder: commits in a Browzer-aware repo should carry the trailer ' +
    '`on-behalf-of: @browzeremb <274369678+browzeremb@users.noreply.github.com>` ' +
    'so GitHub renders the "on behalf of @browzeremb" badge on the commit/PR UI ' +
    '(see https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-on-behalf-of-an-organization). ' +
    '`Co-authored-by:` is for human collaborators and does NOT produce the org-attribution badge — use `on-behalf-of:` instead. ' +
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
