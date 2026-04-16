#!/usr/bin/env node
import { readHookInput } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const HAS_CONTRACT = /\s--(save|json|schema)\b/;

// Split on shell command separators so that `browzer (explore|search|deps)` appearing
// inside a string argument of another command (e.g. git commit -m "... browzer search ...")
// is not mistaken for an actual browzer invocation.
const segments = cmd.split(/&&|\|\|?|;|\n/);
const m = segments
  .map((s) => s.trim().match(/^browzer\s+(explore|search|deps)\b/))
  .find(Boolean);

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
