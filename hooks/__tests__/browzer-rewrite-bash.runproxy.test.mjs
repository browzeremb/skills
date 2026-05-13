// Regression test for run-proxy banner dedup:
//
// Without this dedup, every git/vitest/pnpm/biome/tsc rewrite emits ~80 chars
// of "Browzer rewrote ..." prose into the model's context. In a typical feature
// run with 20+ test/lint calls, that's 1-3 KB of repetitive banner noise.
//
// Contract under test:
//   - First run-proxy rewrite this session → emits `additionalContext`.
//   - Second rewrite (same CLAUDE_SESSION_ID) → no `additionalContext`.
//   - Command rewrite (`updatedInput.command`) still applies on the silent call.
//   - A different CLAUDE_SESSION_ID gets its own independent sentinel.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '..', 'guards', 'browzer-rewrite-bash.mjs');

let ISOLATED_TMPDIR;
let WS_ROOT;

before(() => {
  ISOLATED_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-runproxy-'));
  WS_ROOT = path.join(ISOLATED_TMPDIR, 'workspace');
  fs.mkdirSync(path.join(WS_ROOT, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(WS_ROOT, '.browzer', 'config.json'),
    JSON.stringify({
      workspaceId: 'test-runproxy',
      gateway: 'https://example.com',
    }),
  );
});

after(() => {
  fs.rmSync(ISOLATED_TMPDIR, { recursive: true, force: true });
});

function makeFakeHome(label) {
  const home = path.join(ISOLATED_TMPDIR, `home-${label}`);
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(path.join(home, '.browzer', 'config.json'), '{}');
  return home;
}

function invokeGuard(sessionId, command, extraEnv = {}) {
  const home = makeFakeHome(
    `${sessionId}-${Math.random().toString(36).slice(2)}`,
  );
  const payload = {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: WS_ROOT,
  };

  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: ISOLATED_TMPDIR,
      CLAUDE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: '',
      ...extraEnv,
    },
    cwd: WS_ROOT,
    timeout: 10_000,
  });

  assert.equal(
    result.status,
    0,
    `Guard exited non-zero (${result.status}). stderr: ${result.stderr}`,
  );

  if (!result.stdout || result.stdout.trim() === '') return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Guard stdout is not valid JSON: ${result.stdout}`);
  }
}

describe('browzer-rewrite-bash: run-proxy banner dedup', () => {
  it('first run-proxy rewrite emits additionalContext banner', () => {
    const sessionId = 'test-runproxy-first-a';
    const parsed = invokeGuard(sessionId, 'git status');

    assert.ok(parsed !== null, 'expected JSON output on first invocation');
    const newCmd = parsed?.hookSpecificOutput?.updatedInput?.command;
    assert.equal(
      newCmd,
      'browzer run git status',
      `expected command rewrite. got: ${JSON.stringify(newCmd)}`,
    );
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx === 'string' && ctx.length > 0,
      `expected non-empty additionalContext on first run-proxy rewrite. got: ${JSON.stringify(ctx)}`,
    );
    assert.match(
      ctx,
      /run-proxy compression/,
      'banner must mention run-proxy compression',
    );
  });

  it('second rewrite with same CLAUDE_SESSION_ID has NO additionalContext (banner deduped)', () => {
    const sessionId = 'test-runproxy-second-b';

    // First call — emit banner and create sentinel.
    const first = invokeGuard(sessionId, 'git status');
    assert.ok(first !== null);
    assert.ok(
      typeof first?.hookSpecificOutput?.additionalContext === 'string',
      'first call must have banner',
    );

    // Sentinel file must exist.
    const sentinelPath = path.join(
      ISOLATED_TMPDIR,
      `.browzer-runproxy-banner-${sessionId}.flag`,
    );
    assert.ok(
      fs.existsSync(sentinelPath),
      `sentinel must exist after first run-proxy rewrite: ${sentinelPath}`,
    );

    // Second call with same session — banner suppressed, but rewrite still applied.
    const second = invokeGuard(sessionId, 'pnpm turbo test');
    assert.ok(second !== null, 'second call must still emit rewrite JSON');
    const newCmd2 = second?.hookSpecificOutput?.updatedInput?.command;
    assert.equal(
      newCmd2,
      'browzer run pnpm turbo test',
      'second call: command rewrite must still apply',
    );
    const ctx2 = second?.hookSpecificOutput?.additionalContext;
    assert.equal(
      ctx2,
      undefined,
      `second call must NOT have additionalContext. got: ${JSON.stringify(ctx2)}`,
    );
  });

  it('different CLAUDE_SESSION_ID gets independent sentinel (no cross-session bleed)', () => {
    const sessionA = 'test-runproxy-iso-alpha';
    const sessionB = 'test-runproxy-iso-beta';

    // Prime session A — banner first call, silent second.
    invokeGuard(sessionA, 'vitest run');
    const secondA = invokeGuard(sessionA, 'biome check');
    assert.equal(
      secondA?.hookSpecificOutput?.additionalContext,
      undefined,
      'session A: second call must have no banner',
    );

    // Session B first call — must emit banner independently.
    const firstB = invokeGuard(sessionB, 'go test ./...');
    const ctxB = firstB?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctxB === 'string' && ctxB.length > 0,
      `session B first call must emit banner independently. got: ${JSON.stringify(ctxB)}`,
    );
  });

  it('falls through to banner-every-call mode when TMPDIR is unwritable (graceful degradation)', () => {
    const sessionId = 'test-runproxy-tmpdir-fail';
    const unwritable = '/dev/null/nosuchdir';
    const first = invokeGuard(sessionId, 'git status', { TMPDIR: unwritable });
    assert.ok(
      first !== null,
      'hook must produce JSON output even when TMPDIR is unwritable',
    );
    const newCmd = first?.hookSpecificOutput?.updatedInput?.command;
    assert.equal(
      newCmd,
      'browzer run git status',
      'command rewrite must still apply on TMPDIR-failure path',
    );
    // The banner WILL re-emit on subsequent calls in this degraded mode — that
    // is the documented graceful-degradation contract. We just verify the hook
    // did not crash.
  });
});
