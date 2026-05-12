// Tests for hooks/guards/quality-gate-stop.mjs.
//
// Strategy: spawn the guard as a subprocess (matching integration.test.mjs's
// pattern) with HOME repointed to a tmp dir that fakes both the
// ~/.browzer/credentials file and the workspace's .browzer/config.json. The
// guard short-circuits the actual detached spawn under BROWZER_GATE_DRY_RUN=1
// and instead leaves a 'pending' receipt — ideal for state assertions.
//
// AC-2 tests: baseline receipt seeded with 1 known failure → context hook
// MUST NOT surface that test name.

import { strict as assert } from 'node:assert';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { writeReceipt } from '../_gate-receipts.mjs';
import {
  baselinePathFor,
  hasSessionBaseline,
  readSessionBaseline,
  writeSessionBaseline,
} from '../guards/quality-gate-stop.mjs';

const guardsDir = path.join(import.meta.dirname, '..', 'guards');
const guardPath = path.join(guardsDir, 'quality-gate-stop.mjs');

function freshWorkspace(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gate-stop-${label}-`));
  fs.mkdirSync(path.join(root, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.browzer', 'config.json'),
    JSON.stringify({ workspaceId: 'test-ws', gateway: 'https://e' }),
  );
  // Always-passing config so the guard reaches the receipt path.
  fs.writeFileSync(
    path.join(root, '.browzer', 'skills.config.json'),
    JSON.stringify({
      version: 1,
      gates: { affected: 'echo gate-ok && exit 0' },
    }),
  );
  // Initialize git repo so computeFingerprint returns a non-null hash.
  execSync('git init -q', { cwd: root });
  execSync(
    'git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q',
    {
      cwd: root,
    },
  );
  // Modified file so the working tree has something to fingerprint.
  fs.writeFileSync(path.join(root, 'foo.txt'), 'modified');
  return root;
}

function fakeHome(root) {
  // ~/.browzer/credentials is required by isInBrowzerWorkspace().
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-stop-home-'));
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(path.join(home, '.browzer', 'config.json'), '{}');
  return home;
}

function runGuard(workspace, hookInput, envOverrides = {}) {
  return new Promise((resolve) => {
    const home = fakeHome(workspace);
    const env = {
      ...process.env,
      HOME: home,
      BROWZER_GATE_DRY_RUN: '1',
      ...envOverrides,
    };
    const child = spawn(process.execPath, [guardPath], {
      env,
      cwd: workspace,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(hookInput));
    child.on('close', (code) => resolve({ code, stdout, stderr, home }));
  });
}

function listReceiptFiles(workspace) {
  const dir = path.join(workspace, '.browzer', '.gate-receipts');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
}

function readFirstReceipt(workspace) {
  const files = listReceiptFiles(workspace);
  if (files.length === 0) return null;
  const dir = path.join(workspace, '.browzer', '.gate-receipts');
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

describe('quality-gate-stop guard', () => {
  it('exits 0 and writes a pending receipt on first run (dry-run mode)', async () => {
    const ws = freshWorkspace('first-run');
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const receipts = listReceiptFiles(ws);
    assert.equal(receipts.length, 1);
    const rcpt = readFirstReceipt(ws);
    assert.equal(rcpt.status, 'pending');
    assert.match(rcpt.command, /gate-ok/);
    assert.equal(rcpt.source, 'config');
    assert.equal(rcpt.mode, 'affected');
  });

  it('IDEMPOTENT: a fresh pending receipt for the same fingerprint suppresses re-spawn', async () => {
    const ws = freshWorkspace('idem-pending');
    await runGuard(ws, {});
    const before = readFirstReceipt(ws);
    // Run again immediately; guard should see the fresh pending receipt and
    // exit without overwriting it.
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0);
    const after = readFirstReceipt(ws);
    assert.equal(after.startedAt, before.startedAt);
    assert.equal(after.status, 'pending');
  });

  it('IDEMPOTENT: a fresh passed receipt suppresses re-spawn', async () => {
    const ws = freshWorkspace('idem-passed');
    // Seed a passed receipt for the current working-tree fingerprint.
    // We compute the fingerprint by importing the helper directly.
    const { computeFingerprint } = await import('../_gate-receipts.mjs');
    const fp = computeFingerprint({ cwd: ws });
    assert.ok(fp);
    writeReceipt({
      cwd: ws,
      fingerprint: fp,
      receipt: {
        status: 'passed',
        command: 'echo cached',
        source: 'config',
        mode: 'affected',
        startedAt: Date.now() - 1000,
        completedAt: Date.now() - 500,
        durationMs: 500,
        exitCode: 0,
        stdoutTail: 'ok',
        stderrTail: '',
        ttlSec: 300,
      },
    });
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0);
    const rcpt = readFirstReceipt(ws);
    // Receipt content should be unchanged — guard skipped the write.
    assert.equal(rcpt.status, 'passed');
    assert.equal(rcpt.command, 'echo cached');
  });

  it('stop_hook_active=true short-circuits exit 0 with no receipt', async () => {
    const ws = freshWorkspace('stop-loop-guard');
    const r = await runGuard(ws, { stop_hook_active: true });
    assert.equal(r.code, 0);
    assert.equal(listReceiptFiles(ws).length, 0);
  });

  it('BROWZER_HOOK=off short-circuits exit 0 with no receipt', async () => {
    const ws = freshWorkspace('hook-off');
    const r = await runGuard(ws, {}, { BROWZER_HOOK: 'off' });
    assert.equal(r.code, 0);
    assert.equal(listReceiptFiles(ws).length, 0);
  });

  it('non-Browzer cwd short-circuits exit 0 with no receipt', async () => {
    const stranger = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gate-stop-stranger-'),
    );
    execSync('git init -q', { cwd: stranger });
    fs.writeFileSync(path.join(stranger, 'foo.txt'), 'modified');
    const home = fakeHome(stranger); // creds exist, but .browzer/config.json is absent
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [guardPath], {
        env: {
          ...process.env,
          HOME: home,
          BROWZER_GATE_DRY_RUN: '1',
        },
        cwd: stranger,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end('{}');
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(r.code, 0);
    assert.equal(listReceiptFiles(stranger).length, 0);
  });

  it('disabled config (hooks.qualityGate.enabled=false) skips the receipt', async () => {
    const ws = freshWorkspace('disabled');
    fs.writeFileSync(
      path.join(ws, '.browzer', 'skills.config.json'),
      JSON.stringify({
        version: 1,
        gates: { affected: 'echo nope' },
        hooks: { qualityGate: { enabled: false } },
      }),
    );
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0);
    assert.equal(listReceiptFiles(ws).length, 0);
  });

  it('no resolved gate command (no manifests) → exit 0 + advisory + no receipt', async () => {
    const ws = freshWorkspace('no-gate');
    fs.unlinkSync(path.join(ws, '.browzer', 'skills.config.json'));
    // Ensure cascade has nothing to grab.
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0);
    assert.equal(listReceiptFiles(ws).length, 0);
  });

  it('not a git repo (no fingerprint) → exit 0 + no receipt (transient mode)', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-stop-nogit-'));
    fs.mkdirSync(path.join(ws, '.browzer'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.browzer', 'config.json'),
      JSON.stringify({ workspaceId: 'x', gateway: 'https://e' }),
    );
    fs.writeFileSync(
      path.join(ws, '.browzer', 'skills.config.json'),
      JSON.stringify({ version: 1, gates: { affected: 'echo x' } }),
    );
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0);
    assert.equal(listReceiptFiles(ws).length, 0);
  });

  it('writes a NEW pending receipt when the working-tree fingerprint changes', async () => {
    const ws = freshWorkspace('new-fp');
    await runGuard(ws, {});
    const firstFiles = listReceiptFiles(ws);
    assert.equal(firstFiles.length, 1);
    // Modify the tree to shift the fingerprint.
    fs.writeFileSync(path.join(ws, 'foo.txt'), 'second-version');
    const r = await runGuard(ws, {});
    assert.equal(r.code, 0);
    const secondFiles = listReceiptFiles(ws);
    // First slot persists, second slot now exists.
    assert.equal(secondFiles.length, 2);
    assert.notDeepEqual(secondFiles, firstFiles);
  });
});

// ---------------------------------------------------------------------------
// FR-2 / AC-2: session baseline helpers unit tests
// ---------------------------------------------------------------------------
describe('quality-gate-stop — session baseline helpers (FR-2 / AC-2)', () => {
  // Collect baseline file paths created during this describe block so they
  // can be cleaned up in after(). This prevents tmp-file leakage across runs.
  const createdBaselinePaths = [];

  after(() => {
    for (const p of createdBaselinePaths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('baselinePathFor returns a path under $TMPDIR/.browzer-gate keyed by sessionId', () => {
    const p = baselinePathFor('sess-abc');
    assert.ok(p.includes('.browzer-gate'));
    assert.ok(p.endsWith('sess-abc-baseline.json'));
    assert.ok(path.isAbsolute(p));
  });

  it('hasSessionBaseline returns false when no baseline file exists', () => {
    const sessionId = `test-session-${randomUUID()}-miss`;
    assert.equal(hasSessionBaseline(sessionId), false);
  });

  it('hasSessionBaseline returns false for null/undefined sessionId', () => {
    assert.equal(hasSessionBaseline(null), false);
    assert.equal(hasSessionBaseline(undefined), false);
  });

  it('writeSessionBaseline + readSessionBaseline round-trip (atomic write)', () => {
    const sessionId = `test-session-${randomUUID()}-rt`;
    const failures = ['not ok 1 - some slow test', '✗ another failing test'];
    writeSessionBaseline(sessionId, failures);
    createdBaselinePaths.push(baselinePathFor(sessionId));
    assert.equal(hasSessionBaseline(sessionId), true);
    const read = readSessionBaseline(sessionId);
    assert.deepEqual(read, failures);
  });

  it('readSessionBaseline returns [] for unknown session', () => {
    const result = readSessionBaseline(`ghost-session-${randomUUID()}`);
    assert.deepEqual(result, []);
  });

  it('readSessionBaseline returns [] for null sessionId', () => {
    assert.deepEqual(readSessionBaseline(null), []);
  });

  it('writeSessionBaseline is a no-op for null sessionId (no file created)', () => {
    // Calling with null must not throw and must not write any file.
    assert.doesNotThrow(() => writeSessionBaseline(null, ['some failure']));
    // Confirm hasSessionBaseline still returns false (no phantom file created).
    assert.equal(hasSessionBaseline(null), false);
  });

  // F-5: over-match-prevention — a baseline entry "foo bar" must NOT suppress
  // a line that mentions "foo bar baz" (a different, longer test name).
  it('F-5: baseline word-boundary regex does not suppress lines with longer test names', async () => {
    const sessionId = `f5-session-${randomUUID()}`;
    // Baseline contains the short name only.
    const baselineFailure = 'foo bar';
    writeSessionBaseline(sessionId, [baselineFailure]);
    createdBaselinePaths.push(baselinePathFor(sessionId));

    // Build a fake workspace with a receipt whose stderrTail includes:
    //   - the exact baseline entry (should be filtered)
    //   - a longer name that is a superset (must NOT be filtered)
    const ws = freshWorkspace('f5-over-match');
    const { computeFingerprint } = await import('../_gate-receipts.mjs');
    const fp = computeFingerprint({ cwd: ws });
    assert.ok(fp, 'workspace must be a git repo');

    writeReceipt({
      cwd: ws,
      fingerprint: fp,
      receipt: {
        status: 'failed',
        command: 'echo fail',
        source: 'config',
        mode: 'affected',
        startedAt: Date.now() - 2000,
        completedAt: Date.now() - 1000,
        durationMs: 1000,
        exitCode: 1,
        stdoutTail: '',
        stderrTail: `not ok 1 - ${baselineFailure}\nnot ok 2 - ${baselineFailure} baz`,
        ttlSec: 300,
      },
    });

    const contextGuardPath = path.join(
      import.meta.dirname,
      '..',
      'guards',
      'quality-gate-context.mjs',
    );
    const home = fakeHome(ws);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [contextGuardPath], {
        env: { ...process.env, HOME: home },
        cwd: ws,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(JSON.stringify({ session_id: sessionId }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    // The exact baseline line must be suppressed.
    assert.ok(
      !result.stdout.includes(`- ${baselineFailure}\n`) &&
        !result.stdout.includes(`- ${baselineFailure}[all failures`),
      `Expected exact baseline match to be filtered. Got: ${result.stdout}`,
    );
    // The longer "foo bar baz" line must still appear (over-match prevention).
    assert.ok(
      result.stdout.includes(`${baselineFailure} baz`),
      `Expected "foo bar baz" to survive filtering (over-match prevention). Got: ${result.stdout}`,
    );
  });

  // AC-2: baseline with 1 known failure → quality-gate-context MUST NOT
  // surface that test name in additionalContext.
  it('AC-2: context hook filters baseline failures from the failure surface', async () => {
    const sessionId = `ac2-session-${randomUUID()}`;
    const knownFailure = 'not ok 42 - my pre-existing broken test';

    // Seed the session baseline with the known failure.
    writeSessionBaseline(sessionId, [knownFailure]);
    createdBaselinePaths.push(baselinePathFor(sessionId));

    // Build a fake workspace with a gate receipt that contains the known failure.
    const ws = freshWorkspace('ac2-ctx');
    const { computeFingerprint } = await import('../_gate-receipts.mjs');
    const fp = computeFingerprint({ cwd: ws });
    assert.ok(fp, 'workspace must be a git repo');

    writeReceipt({
      cwd: ws,
      fingerprint: fp,
      receipt: {
        status: 'failed',
        command: 'echo fail',
        source: 'config',
        mode: 'affected',
        startedAt: Date.now() - 2000,
        completedAt: Date.now() - 1000,
        durationMs: 1000,
        exitCode: 1,
        stdoutTail: '',
        stderrTail: `${knownFailure}\nsome other output`,
        ttlSec: 300,
      },
    });

    // Run quality-gate-context.mjs as a subprocess with the sessionId injected.
    const contextGuardPath = path.join(
      import.meta.dirname,
      '..',
      'guards',
      'quality-gate-context.mjs',
    );
    const home = fakeHome(ws);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [contextGuardPath], {
        env: { ...process.env, HOME: home },
        cwd: ws,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      // Inject hook input with the session_id so the context hook reads the baseline.
      child.stdin.end(JSON.stringify({ session_id: sessionId }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    // The known baseline failure MUST NOT appear in the emitted context.
    assert.ok(
      !result.stdout.includes(knownFailure),
      `Expected baseline failure "${knownFailure}" to be filtered from context output.\nActual stdout: ${result.stdout}`,
    );
    // But the gate status header SHOULD still appear (the gate did fail overall).
    assert.ok(
      result.stdout.includes('quality gate failed') ||
        result.stdout.includes('[browzer]'),
      `Expected gate status in context output.\nActual stdout: ${result.stdout}`,
    );
  });
});
