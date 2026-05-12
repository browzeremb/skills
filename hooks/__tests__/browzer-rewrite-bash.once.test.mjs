// Regression test for R-10: BROWZER_LLM=1 banner emits ONCE per session.
//
// Contract under test (browzer-rewrite-bash.mjs sentinel-file path):
//   - First invocation with a given CLAUDE_SESSION_ID → additionalContext populated.
//   - Second invocation with the SAME CLAUDE_SESSION_ID → additionalContext absent.
//   - Sentinel file keyed to session is written by the first call.
//   - A different CLAUDE_SESSION_ID gets its own independent sentinel (no cross-session bleed).
//
// Strategy: use a unique TMPDIR per test run so sentinel files never collide
// with other test suites or concurrent test runs.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '..', 'guards', 'browzer-rewrite-bash.mjs');

// Isolated TMPDIR — sentinel files written here never bleed across test runs.
let ISOLATED_TMPDIR;
let WS_ROOT;

before(() => {
  ISOLATED_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-once-'));
  WS_ROOT = path.join(ISOLATED_TMPDIR, 'workspace');
  // Create a fake Browzer workspace so isInBrowzerWorkspace() returns true.
  fs.mkdirSync(path.join(WS_ROOT, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(WS_ROOT, '.browzer', 'config.json'),
    JSON.stringify({
      workspaceId: 'test-once',
      gateway: 'https://example.com',
    }),
  );
});

after(() => {
  fs.rmSync(ISOLATED_TMPDIR, { recursive: true, force: true });
});

/**
 * Creates a minimal fake HOME dir that satisfies isInBrowzerWorkspace():
 * needs ~/.browzer/credentials and ~/.browzer/config.json.
 */
function makeFakeHome(label) {
  const home = path.join(ISOLATED_TMPDIR, `home-${label}`);
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(path.join(home, '.browzer', 'config.json'), '{}');
  return home;
}

/**
 * Invokes the guard synchronously with the given session id and returns
 * the parsed stdout JSON (or null on empty/invalid stdout).
 */
function invokeGuard(sessionId, extraEnv = {}) {
  const home = makeFakeHome(
    `${sessionId}-${Math.random().toString(36).slice(2)}`,
  );
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'browzer explore "test"' },
    cwd: WS_ROOT,
  };

  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      // Unset BROWZER_LLM so the env-based (R-13) guard never fires first.
      BROWZER_LLM: '',
      HOME: home,
      TMPDIR: ISOLATED_TMPDIR,
      CLAUDE_SESSION_ID: sessionId,
      // Unset CLAUDE_PROJECT_DIR so session resolution uses CLAUDE_SESSION_ID.
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

// ============================================================
describe('browzer-rewrite-bash: R-10 once-per-session banner via sentinel file', () => {
  it('first invocation emits additionalContext banner', () => {
    const sessionId = 'test-session-once-r10-a';
    const parsed = invokeGuard(sessionId);

    assert.ok(parsed !== null, 'Expected JSON output on first invocation');
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx === 'string' && ctx.length > 0,
      `Expected non-empty additionalContext on first call. got: ${JSON.stringify(ctx)}`,
    );
    assert.match(ctx, /BROWZER_LLM=1/, 'Banner must mention BROWZER_LLM=1');
  });

  it('second invocation with same CLAUDE_SESSION_ID has NO additionalContext', () => {
    const sessionId = 'test-session-once-r10-b';

    // First call — should emit banner and create sentinel.
    const first = invokeGuard(sessionId);
    assert.ok(first !== null, 'First call must produce JSON output');
    const ctx1 = first?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx1 === 'string' && ctx1.length > 0,
      `First call must have banner. got: ${JSON.stringify(ctx1)}`,
    );

    // Verify sentinel was written.
    const sentinelPath = path.join(
      ISOLATED_TMPDIR,
      `.browzer-llm-banner-${sessionId}.flag`,
    );
    assert.ok(
      fs.existsSync(sentinelPath),
      `Sentinel file must exist after first invocation: ${sentinelPath}`,
    );

    // Second call with same session — sentinel exists → no banner.
    const second = invokeGuard(sessionId);
    // The hook still emits a JSON object (for the command rewrite), but
    // additionalContext must be absent or undefined.
    const ctx2 = second?.hookSpecificOutput?.additionalContext;
    assert.equal(
      ctx2,
      undefined,
      `Second call with same session must NOT have additionalContext. got: ${JSON.stringify(ctx2)}`,
    );
  });

  it('different CLAUDE_SESSION_ID gets independent sentinel (no cross-session bleed)', () => {
    const sessionA = 'test-session-once-r10-c-alpha';
    const sessionB = 'test-session-once-r10-c-beta';

    // Prime session A (creates sentinel for A).
    invokeGuard(sessionA);
    // Prime session A again — second call for A should have no banner.
    const secondA = invokeGuard(sessionA);
    assert.equal(
      secondA?.hookSpecificOutput?.additionalContext,
      undefined,
      'Session A: second call must have no banner',
    );

    // First call for session B — MUST still emit the banner (different sentinel).
    const firstB = invokeGuard(sessionB);
    const ctxB = firstB?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctxB === 'string' && ctxB.length > 0,
      `Session B first call must emit banner independently. got: ${JSON.stringify(ctxB)}`,
    );
  });

  it('falls through to banner-every-call mode when TMPDIR is unwritable (F-014)', () => {
    // Use a path that cannot possibly be a writable directory so sentinel
    // creation always throws ENOENT / ENOTDIR.  The hook must still exit 0
    // and still apply the BROWZER_LLM=1 command rewrite (graceful degradation).
    const sessionId = 'test-session-once-f014-unwritable';
    const unwritableTmpdir = '/dev/null/nosuchdir';

    const first = invokeGuard(sessionId, { TMPDIR: unwritableTmpdir });
    assert.ok(
      first !== null,
      'Hook must produce JSON output even with unwritable TMPDIR',
    );
    const newCmd = first?.hookSpecificOutput?.updatedInput?.command;
    assert.ok(
      typeof newCmd === 'string' && /^BROWZER_LLM=1\s/.test(newCmd),
      `Command rewrite must still apply. got: ${JSON.stringify(newCmd)}`,
    );
    // Exit 0 is already asserted inside invokeGuard — reaching here means the
    // hook did not crash on the failed sentinel write.
  });

  it('command rewrite (BROWZER_LLM=1 prefix) still happens on second invocation', () => {
    const sessionId = 'test-session-once-r10-d';

    // Consume first banner.
    invokeGuard(sessionId);

    // Second call — command rewrite must still be present even though banner is gone.
    const second = invokeGuard(sessionId);
    assert.ok(second !== null, 'Expected JSON output on second invocation');
    const newCmd = second?.hookSpecificOutput?.updatedInput?.command;
    assert.ok(
      typeof newCmd === 'string',
      `Expected updatedInput.command on second call. got: ${JSON.stringify(second)}`,
    );
    assert.match(
      newCmd,
      /^BROWZER_LLM=1\s/,
      'Command must still be prefixed with BROWZER_LLM=1 on second call',
    );
  });
});
