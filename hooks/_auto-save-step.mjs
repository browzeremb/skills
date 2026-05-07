#!/usr/bin/env node
// _auto-save-step.mjs — PostToolUse(Write) hook entrypoint.
//
// Reads the Claude Code hook payload from stdin, looks for a Write into
// docs/browzer/<feat>/staging/<PHASE>.{md,json}, and execs `browzer
// save-step <PHASE> --id <feat> --from <abs-path>` to validate + persist
// the artefact into workflow.json.
//
// Exit semantics (asyncRewake-friendly):
//   0  silent — non-matching path, autosave disabled, or success
//   2  CLI failure — stderr is a structured one-liner so the agent wakes
//      with the error
//
// Environment toggles:
//   BROWZER_AUTOSAVE=0   bypass entirely (debug)
//   BROWZER_LLM=1        forwarded to the CLI for quiet success path

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// load-bearing: do not add a leading ^ anchor — see packages/skills/CLAUDE.md "Autosave matcher invariant"
const STAGING_RE = /docs\/browzer\/([^/]+)\/staging\/([A-Z_0-9]+)\.(md|json)$/;

function readStdinSync() {
  // Node 22 ESM has no synchronous stdin API; we shell out to avoid a top-
  // level await for a one-shot script.
  try {
    const fs = require('node:fs');
    return fs.readFileSync(0, 'utf8');
  } catch {
    // Fallback for ESM modules where `require` is undefined.
    return '';
  }
}

async function readStdinAsync() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function findBrowzerBin() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const candidate = `${home}/.local/bin/browzer`;
    if (existsSync(candidate)) return candidate;
  }
  // Fallback to PATH lookup.
  const which = spawnSync('which', ['browzer'], { encoding: 'utf8' });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) return found;
  }
  return 'browzer';
}

async function main() {
  if (process.env.BROWZER_AUTOSAVE === '0') {
    process.exit(0);
  }

  const raw = await readStdinAsync();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    // Malformed payload — silent no-op (don't fail the surrounding tool call).
    process.exit(0);
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    process.exit(0);
  }

  const m = STAGING_RE.exec(filePath);
  if (!m) {
    process.exit(0);
  }
  const feat = m[1];
  const phase = m[2];

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

  const bin = findBrowzerBin();
  // Honor caller's BROWZER_LLM setting (opt-in toggle from the header docs);
  // do not unconditionally force '1'.
  const env = { ...process.env };
  const result = spawnSync(
    bin,
    ['save-step', phase, '--id', feat, '--from', absPath, '--await'],
    { encoding: 'utf8', env, cwd },
  );

  if (result.error) {
    process.stderr.write(
      `[autosave] save-step ${phase}: spawn failed: ${result.error.message}\n`,
    );
    process.exit(2);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const exitDesc = result.signal
      ? `signal ${result.signal}`
      : `exit ${result.status}`;
    process.stderr.write(
      `[autosave] save-step ${phase}: ${stderr || exitDesc}\n`,
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[autosave] internal error: ${err?.message || err}\n`);
  process.exit(2);
});

// Avoid no-unused-import warnings if linters get pedantic.
void readStdinSync;
