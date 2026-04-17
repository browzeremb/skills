#!/usr/bin/env node
import { readHookInput, stripQuoted } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

// Skip when the user is running git directly AND the command has no shell
// operators chaining a second simple-command. `git commit -m "<body>"`,
// `git stash save "<msg>"`, etc. embed arbitrary literal text whose
// substring may legitimately mention `browzer (explore|search|deps)`
// (2026-04-16 retro §3.6 — the meta case where the retro's own commit
// message body, enumerating CLI call counts, was blocked by this hook).
// Operator presence (`&&`, `||`, `|`, `;`, `\n`) means a second command
// can follow — fall through to the segment-level scan so chains like
// `git status && browzer explore foo` (no `--save`) still get caught.
const firstToken =
  cmd
    .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '')
    .trimStart()
    .split(/\s+/)[0] ?? '';
const HAS_SHELL_OPERATOR = /&&|\|\|?|;|\n/;
if (firstToken === 'git' && !HAS_SHELL_OPERATOR.test(cmd)) process.exit(0);

// Strip quoted regions (single-quoted, double-quoted, $() substitutions,
// heredoc bodies) BEFORE scanning. What remains is the "shell skeleton":
// the parts the parent shell interprets as command tokens. This stops
// substring matches against `browzer explore` text living inside an
// echo/printf/awk/ssh argument body for any caller, not just git.
const skeleton = stripQuoted(cmd);

const HAS_CONTRACT = /\s--(save|json|schema)\b/;

const segments = skeleton.split(/&&|\|\|?|;|\n/);
const m = segments
  .map((s) => s.trim().match(/^browzer\s+(explore|search|deps)\b/))
  .find(Boolean);

if (m && !HAS_CONTRACT.test(skeleton)) {
  const sub = m[1];
  process.stderr.write(
    `Blocked: \`browzer ${sub}\` without \`--save\`, \`--json\`, or \`--schema\`. ` +
      `Human-formatted output is not parseable in an agent loop. ` +
      `Re-run with \`--save /tmp/${sub}.json\` (preferred) or \`--json\`. ` +
      `To inspect the response shape first: \`browzer ${sub} --schema\`.\n`,
  );
  process.exit(2);
}

process.exit(0);
