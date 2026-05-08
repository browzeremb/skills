// Tests for hooks/guards/browzer-postuse-run.mjs — the PostToolUse(Bash) hook
// that injects an additionalContext summary when browzer explore/search/deps/ask
// returns more than 10 entries.
//
// Strategy: spawn the guard as a child process (matching _auto-save-step.test.mjs
// pattern). We assert exit code, stdout content, and stderr.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'guards', 'browzer-postuse-run.mjs');

/**
 * Build a fake browzer workspace: creds + .browzer/config.json in a tmp dir
 * so isInBrowzerWorkspace() returns true.
 */
function makeWorkspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'postuse-run-home-'));
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(
    path.join(home, '.browzer', 'config.json'),
    JSON.stringify({ workspaceId: 'test', gateway: 'https://e' }),
  );

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'postuse-run-cwd-'));
  fs.mkdirSync(path.join(cwd, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.browzer', 'config.json'),
    JSON.stringify({ workspaceId: 'test', gateway: 'https://e' }),
  );
  return { home, cwd };
}

function runHook(payload, envOverrides = {}) {
  const { home, cwd } = makeWorkspace();
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, ...envOverrides },
    timeout: 10_000,
  });
}

/**
 * Build an explore JSON response with `n` entries.
 */
function makeExploreOutput(n) {
  const entries = Array.from({ length: n }, (_, i) => ({
    path: `src/file${i}.ts`,
    score: 0.9 - i * 0.01,
    type: 'file',
  }));
  return JSON.stringify({ entries });
}

describe('browzer-postuse-run.mjs', () => {
  it('exits 0 silently for non-browzer command', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: { stdout: 'On branch main\n' },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  it('exits 0 silently when explore --json returns ≤10 entries', () => {
    const stdout = makeExploreOutput(5);
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'browzer explore "foo" --json' },
      tool_response: { stdout },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
  });

  it('injects additionalContext summary when explore --json returns >10 entries', () => {
    const stdout = makeExploreOutput(15);
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'browzer explore "bar" --json' },
      tool_response: { stdout },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'expected non-empty stdout');
    const out = JSON.parse(r.stdout);
    assert.ok(
      typeof out.additionalContext === 'string',
      'expected additionalContext string',
    );
    assert.match(out.additionalContext, /15 entries returned/);
    assert.match(out.additionalContext, /src\/file0\.ts/);
  });

  it('exits 0 silently when stdout is invalid JSON', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'browzer explore "baz" --json' },
      tool_response: { stdout: 'not-json-at-all' },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
  });

  it('exits 0 silently when tool_name is not Bash', () => {
    const stdout = makeExploreOutput(15);
    const r = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/some.json' },
      tool_response: { content: stdout },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
  });

  it('exits 0 silently when BROWZER_HOOK=off', () => {
    const stdout = makeExploreOutput(15);
    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'browzer explore "baz" --json' },
        tool_response: { stdout },
      },
      { BROWZER_HOOK: 'off' },
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
  });
});
