// Unit tests for the quality-gate debounce path in _gate-receipts.mjs.
//
// AC-12: two consecutive invocations against an unchanged tree — first triggers
// gate (no fresh receipt), second returns cached receipt in <100ms.
// This test simulates both invocations using computeFingerprint + readFreshReceipt
// without actually spawning pnpm browzer:gate.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Resolve module path from this file's location (ESM-safe, no import.meta.dirname).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_MODULE = path.resolve(HERE, '..', '_gate-receipts.mjs');

const {
  computeFingerprint,
  readFreshReceipt,
  readReceipt,
  writeReceipt,
  listValidReceipts,
  pruneOldReceipts,
} = await import(RECEIPTS_MODULE);

// ---- helpers ----

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-debounce-'));

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function freshGitWorkspace(label) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, `ws-${label}-`));
  fs.mkdirSync(path.join(root, '.browzer'), { recursive: true });
  execSync('git init -q', { cwd: root });
  execSync(
    'git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q',
    {
      cwd: root,
    },
  );
  // Put a tracked modified file in the working tree so the fingerprint is non-trivial.
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'v1');
  return root;
}

function seedPassedReceipt(ws, fingerprint, extraFields = {}) {
  return writeReceipt({
    cwd: ws,
    fingerprint,
    receipt: {
      status: 'passed',
      command: 'echo gate-ok',
      source: 'config',
      mode: 'affected',
      startedAt: Date.now() - 2000,
      completedAt: Date.now() - 1500,
      durationMs: 500,
      exitCode: 0,
      stdoutTail: 'all tests pass',
      stderrTail: '',
      ttlSec: 300,
      ...extraFields,
    },
  });
}

// ================================================================
// Tests
// ================================================================

describe('_gate-receipts: debounce (cache reuse on unchanged tree)', () => {
  // --- 1. computeFingerprint returns non-null for a git workspace ---
  it('computeFingerprint returns a 64-char hex string for a git workspace', () => {
    const ws = freshGitWorkspace('fp-basic');
    const fp = computeFingerprint({ cwd: ws });
    assert.ok(fp, 'expected non-null fingerprint');
    assert.match(fp, /^[0-9a-f]{64}$/, 'expected 64-char sha256 hex');
  });

  // --- 2. Same tree = same fingerprint (determinism) ---
  it('same tree state produces the same fingerprint on two calls', () => {
    const ws = freshGitWorkspace('fp-determinism');
    const fp1 = computeFingerprint({ cwd: ws });
    const fp2 = computeFingerprint({ cwd: ws });
    assert.equal(
      fp1,
      fp2,
      'fingerprint must be deterministic for unchanged tree',
    );
  });

  // --- 3. Modified tree = different fingerprint ---
  it('modifying a file shifts the fingerprint', () => {
    const ws = freshGitWorkspace('fp-shift');
    const fp1 = computeFingerprint({ cwd: ws });
    // Write a different content to shift the mtime/size.
    fs.writeFileSync(path.join(ws, 'fixture.txt'), 'v2-modified');
    const fp2 = computeFingerprint({ cwd: ws });
    assert.notEqual(
      fp1,
      fp2,
      'fingerprint must change after file modification',
    );
  });

  // --- 4. readFreshReceipt returns null when no receipt exists ---
  it('readFreshReceipt returns null before any gate run', () => {
    const ws = freshGitWorkspace('no-receipt');
    const fp = computeFingerprint({ cwd: ws });
    const receipt = readFreshReceipt({ cwd: ws, fingerprint: fp });
    assert.equal(receipt, null);
  });

  // --- 5. AC-12: FIRST run — no fresh receipt → gate must run ---
  // (We don't spawn the actual gate; we assert the nil-receipt branch.)
  it('AC-12 first invocation: no fresh receipt → gate would run (nil signal)', () => {
    const ws = freshGitWorkspace('first-run');
    const fp = computeFingerprint({ cwd: ws });
    const t0 = Date.now();
    const receipt = readFreshReceipt({ cwd: ws, fingerprint: fp });
    const elapsed = Date.now() - t0;
    assert.equal(
      receipt,
      null,
      'first call must return null (gate not run yet)',
    );
    assert.ok(
      elapsed < 100,
      `fingerprint + receipt lookup must be <100ms, got ${elapsed}ms`,
    );
  });

  // --- 6. AC-12: SECOND run — fresh receipt exists → return cached, <100ms ---
  it('AC-12 second invocation: fresh receipt present → returned in <100ms', () => {
    const ws = freshGitWorkspace('second-run');
    const fp = computeFingerprint({ cwd: ws });

    // Simulate what quality-gate-stop writes after the real gate finishes.
    seedPassedReceipt(ws, fp);

    const t0 = Date.now();
    const receipt = readFreshReceipt({ cwd: ws, fingerprint: fp });
    const elapsed = Date.now() - t0;

    assert.ok(receipt, 'second call must return the cached receipt');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.command, 'echo gate-ok');
    assert.ok(
      elapsed < 100,
      `cached receipt lookup must be <100ms, got ${elapsed}ms`,
    );
  });

  // --- 7. Stale receipt (TTL expired) triggers re-run ---
  it('stale receipt (TTL=1s, created >1s ago) is treated as absent', () => {
    const ws = freshGitWorkspace('stale-receipt');
    const fp = computeFingerprint({ cwd: ws });

    // Write a receipt with 1s TTL and completedAt 2s in the past → already expired.
    writeReceipt({
      cwd: ws,
      fingerprint: fp,
      receipt: {
        status: 'passed',
        command: 'echo stale',
        source: 'config',
        mode: 'affected',
        startedAt: Date.now() - 3000,
        completedAt: Date.now() - 2000,
        durationMs: 1000,
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        ttlSec: 1, // expires after 1 second
      },
    });

    const receipt = readFreshReceipt({ cwd: ws, fingerprint: fp });
    assert.equal(
      receipt,
      null,
      'expired receipt must not be returned as fresh',
    );
  });

  // --- 8. listValidReceipts returns the fresh receipt for additionalContext surfacing ---
  it('listValidReceipts includes fresh receipt (used by quality-gate-context)', () => {
    const ws = freshGitWorkspace('list-valid');
    const fp = computeFingerprint({ cwd: ws });
    seedPassedReceipt(ws, fp);

    const valid = listValidReceipts({ cwd: ws });
    assert.ok(valid.length >= 1, 'expected at least one valid receipt');
    assert.equal(valid[0].status, 'passed');
  });

  // --- 9. pruneOldReceipts removes expired disk-TTL files ---
  it('pruneOldReceipts removes files older than 24h (mtime-based)', () => {
    const ws = freshGitWorkspace('prune');
    const dirRel = '.browzer/.gate-receipts';
    const receiptDir = path.join(ws, dirRel);
    fs.mkdirSync(receiptDir, { recursive: true });

    // Plant a fake old-looking file with a past mtime.
    const oldFile = path.join(receiptDir, 'aabbccdd0011.json');
    fs.writeFileSync(
      oldFile,
      JSON.stringify({ version: 1, fingerprint: 'x', status: 'passed' }),
    );
    // Backdate mtime 25h.
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);

    // Plant a fresh file that should survive.
    const fp = computeFingerprint({ cwd: ws });
    seedPassedReceipt(ws, fp);

    pruneOldReceipts({ cwd: ws, dirRel });

    assert.ok(!fs.existsSync(oldFile), 'old receipt must be pruned');
    const remaining = fs
      .readdirSync(receiptDir)
      .filter((n) => n.endsWith('.json'));
    assert.ok(remaining.length >= 1, 'fresh receipt must survive pruning');
  });
});
