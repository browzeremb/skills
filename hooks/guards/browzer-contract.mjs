#!/usr/bin/env node
import { readHookInput } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const READ_CMD = /\bbrowzer\s+(explore|search|deps)\b/;
const HAS_CONTRACT = /\s--(save|json|schema)\b/;

const m = cmd.match(READ_CMD);
if (m && !HAS_CONTRACT.test(cmd)) {
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
