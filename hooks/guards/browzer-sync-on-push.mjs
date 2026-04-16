#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readHookInput } from './_util.mjs';

const input = readHookInput();
const cmd = input?.tool_input?.command ?? '';

const isGitPush = /\bgit\s+push\b/.test(cmd);
const isGhPush = /\bgh\s+(?:pr\s+(?:create|push)|repo\s+sync)\b/.test(cmd);
const isGlabPush = /\bglab\s+(?:mr\s+(?:create|push)|repo\s+push)\b/.test(cmd);

if (!(isGitPush || isGhPush || isGlabPush)) {
  process.exit(0);
}

process.stderr.write(
  'Browzer: git push detected — running `browzer sync` to refresh the index.\n',
);

const result = spawnSync('browzer', ['sync'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  timeout: 5 * 60_000,
});

if (result.stdout) process.stderr.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  process.stderr.write(
    `Browzer sync exited with code ${result.status ?? 'null'} (not blocking).\n`,
  );
}

process.exit(0);
