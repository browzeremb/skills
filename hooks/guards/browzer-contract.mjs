#!/usr/bin/env node
// First offense per session: emit `permissionDecision: "ask"` so the operator
// can decide. Subsequent offenses: `allow` + advisory. Hard-block only when
// BROWZER_STRICT=1 is set in the environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHookInput, stripQuoted } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const firstToken =
  cmd
    .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '')
    .trimStart()
    .split(/\s+/)[0] ?? '';
const HAS_SHELL_OPERATOR = /&&|\|\|?|;|\n/;
if (firstToken === 'git' && !HAS_SHELL_OPERATOR.test(cmd)) process.exit(0);

const skeleton = stripQuoted(cmd);
const HAS_CONTRACT = /\s--(save|json|schema)\b/;
const segments = skeleton.split(/&&|\|\|?|;|\n/);
const m = segments
  .map((s) => s.trim().match(/^browzer\s+(explore|search|deps)\b/))
  .find(Boolean);

if (!m || HAS_CONTRACT.test(skeleton)) process.exit(0);

const sub = m[1];
const message =
  `\`browzer ${sub}\` was invoked without \`--save\`, \`--json\`, or \`--schema\`. ` +
  `Human-formatted output is hard to parse in an agent loop. ` +
  `Re-run with \`--save /tmp/${sub}.json\` (preferred) or \`--json\`. ` +
  `Inspect the response shape first with \`browzer ${sub} --schema\`.`;

const STRICT = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.BROWZER_STRICT ?? '').toLowerCase(),
);

if (STRICT) {
  process.stderr.write(`Blocked (BROWZER_STRICT=1): ${message}\n`);
  process.exit(2);
}

function offenseSeenThisSession(sessionId) {
  if (!sessionId) return false;
  const dir = join(tmpdir(), '.browzer-guard');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  const file = join(dir, `${sessionId}.contract.json`);
  let seen = {};
  if (existsSync(file)) {
    try {
      seen = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      seen = {};
    }
  }
  if (seen[sub]) return true;
  seen[sub] = Date.now();
  try {
    writeFileSync(file, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
  return false;
}

const seen = offenseSeenThisSession(input?.session_id);
const decision = seen ? 'allow' : 'ask';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: message,
      additionalContext: message,
    },
  }),
);
process.exit(0);
