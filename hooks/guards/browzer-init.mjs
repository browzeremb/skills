#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';
const cwd = input?.cwd ?? input?.tool_input?.cwd ?? process.cwd();

const isInit = /\bbrowzer\s+init\b/.test(cmd);
const alreadyBound = existsSync(join(cwd, '.browzer'));

if (isInit && alreadyBound) {
  process.stderr.write(
    `Warning: this directory is already bound to a Browzer workspace (.browzer/ exists in ${cwd}). ` +
      `Running \`browzer init\` again will rebind locally — the previous workspace index stays on the server, but this directory will point at a new workspace id. ` +
      `To inspect the current binding first: \`browzer status --json --save /tmp/status.json\`. ` +
      `To detach without re-init: \`browzer workspace unlink\`. ` +
      `Proceeding — this is a warn, not a block.\n`,
  );
}

process.exit(0);
