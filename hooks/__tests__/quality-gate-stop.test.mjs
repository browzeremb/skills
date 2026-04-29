// Tests for hooks/guards/quality-gate-stop.mjs.
//
// Strategy: spawn the guard as a subprocess (matching integration.test.mjs's
// pattern) with HOME repointed to a tmp dir that fakes both the
// ~/.browzer/credentials file and the workspace's .browzer/config.json. The
// guard short-circuits the actual detached spawn under BROWZER_GATE_DRY_RUN=1
// and instead leaves a 'pending' receipt — ideal for state assertions.

import { strict as assert } from 'node:assert';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { writeReceipt } from '../_gate-receipts.mjs';

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
