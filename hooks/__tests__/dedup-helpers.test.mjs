// Unit + integration tests for the once-per-session and fingerprint-change
// dedup pattern introduced in v5.2.1:
//
// Unit:
//   - sessionBannerEmittedOnce(label) — first call false (banner emits),
//     second call true (banner suppressed); isolated by CLAUDE_SESSION_ID.
//   - sessionFingerprintAlreadyEmitted(label, fp) — first call false, second
//     call with same fp true, second call with different fp false again.
//
// Integration:
//   - browzer-suggest-grep emits advisory on first Grep, silent on second.
//   - browzer-block-glob (soft mode) emits advisory on first Glob, silent
//     on second; in hard-block mode (config.hooks.glob.mode === 'block') it
//     ALWAYS emits the deny reason.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARDS = path.resolve(HERE, '..', 'guards');

let TMP;
let WS_ROOT;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-dedup-'));
  WS_ROOT = path.join(TMP, 'workspace');
  fs.mkdirSync(path.join(WS_ROOT, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(WS_ROOT, '.browzer', 'config.json'),
    JSON.stringify({
      workspaceId: 'test-dedup',
      gateway: 'https://example.com',
    }),
  );
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeFakeHome(label) {
  const home = path.join(TMP, `home-${label}`);
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(path.join(home, '.browzer', 'config.json'), '{}');
  return home;
}

function runGuard(guardName, payload, extraEnv = {}, cwd = WS_ROOT) {
  const guard = path.join(GUARDS, guardName);
  const home = makeFakeHome(
    `${guardName}-${Math.random().toString(36).slice(2)}`,
  );
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: TMP,
      CLAUDE_PROJECT_DIR: '',
      ...extraEnv,
    },
    cwd,
    timeout: 10_000,
  });
  return result;
}

// ──────────────────────────────────────────────────────────────────
// Unit tests for the helpers
// ──────────────────────────────────────────────────────────────────

const { sessionBannerEmittedOnce, sessionFingerprintAlreadyEmitted } =
  await import('../guards/_util.mjs');

describe('sessionBannerEmittedOnce', () => {
  it('first call returns false and writes the sentinel; second returns true', () => {
    const sessionId = 'unit-banner-a';
    process.env.CLAUDE_SESSION_ID = sessionId;
    process.env.CLAUDE_PROJECT_DIR = '';
    process.env.TMPDIR = TMP;

    const label = '.brz-unit-banner-a';
    assert.equal(
      sessionBannerEmittedOnce(label),
      false,
      'first call must report not-yet-emitted',
    );
    const sentinel = path.join(TMP, `${label}-${sessionId}.flag`);
    assert.ok(
      fs.existsSync(sentinel),
      'sentinel must be written on first call',
    );

    assert.equal(
      sessionBannerEmittedOnce(label),
      true,
      'second call must report already-emitted',
    );
  });

  it('distinct labels do not collide', () => {
    process.env.CLAUDE_SESSION_ID = 'unit-banner-b';
    process.env.TMPDIR = TMP;
    assert.equal(sessionBannerEmittedOnce('.brz-unit-banner-b-X'), false);
    assert.equal(sessionBannerEmittedOnce('.brz-unit-banner-b-Y'), false);
    assert.equal(sessionBannerEmittedOnce('.brz-unit-banner-b-X'), true);
    assert.equal(sessionBannerEmittedOnce('.brz-unit-banner-b-Y'), true);
  });

  it('distinct CLAUDE_SESSION_IDs do not collide', () => {
    process.env.TMPDIR = TMP;

    process.env.CLAUDE_SESSION_ID = 'unit-banner-iso-1';
    assert.equal(sessionBannerEmittedOnce('.brz-unit-banner-iso'), false);
    assert.equal(sessionBannerEmittedOnce('.brz-unit-banner-iso'), true);

    process.env.CLAUDE_SESSION_ID = 'unit-banner-iso-2';
    assert.equal(
      sessionBannerEmittedOnce('.brz-unit-banner-iso'),
      false,
      'different session must get an independent sentinel',
    );
  });
});

describe('sessionFingerprintAlreadyEmitted', () => {
  it('first call returns false; same fingerprint returns true', () => {
    process.env.CLAUDE_SESSION_ID = 'unit-fp-a';
    process.env.TMPDIR = TMP;
    const label = '.brz-unit-fp-a';
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'abc123'), false);
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'abc123'), true);
  });

  it('different fingerprint resets and returns false again', () => {
    process.env.CLAUDE_SESSION_ID = 'unit-fp-b';
    process.env.TMPDIR = TMP;
    const label = '.brz-unit-fp-b';
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'fp-1'), false);
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'fp-1'), true);
    assert.equal(
      sessionFingerprintAlreadyEmitted(label, 'fp-2'),
      false,
      'fingerprint change must report not-yet-emitted (state changed)',
    );
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'fp-2'), true);
  });

  it('distinct sessions do not collide', () => {
    process.env.TMPDIR = TMP;
    const label = '.brz-unit-fp-iso';
    process.env.CLAUDE_SESSION_ID = 'unit-fp-iso-1';
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'shared-fp'), false);
    assert.equal(sessionFingerprintAlreadyEmitted(label, 'shared-fp'), true);

    process.env.CLAUDE_SESSION_ID = 'unit-fp-iso-2';
    assert.equal(
      sessionFingerprintAlreadyEmitted(label, 'shared-fp'),
      false,
      'different session must not see fp from another session',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Integration: browzer-suggest-grep dedup
// ──────────────────────────────────────────────────────────────────

describe('browzer-suggest-grep: once-per-session advisory', () => {
  it('first Grep emits additionalContext; second Grep silent', () => {
    const sessionId = 'integ-grep-a';
    const payload = {
      tool_name: 'Grep',
      tool_input: { pattern: 'foo', path: 'src' },
      cwd: WS_ROOT,
    };

    const r1 = runGuard('browzer-suggest-grep.mjs', payload, {
      CLAUDE_SESSION_ID: sessionId,
    });
    assert.equal(r1.status, 0, `r1 stderr: ${r1.stderr}`);
    assert.ok(r1.stdout.trim().length > 0, 'first call must emit JSON');
    const ctx1 = JSON.parse(r1.stdout)?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx1 === 'string' && /Browzer/.test(ctx1),
      'first call must include the redirect advisory',
    );

    const r2 = runGuard('browzer-suggest-grep.mjs', payload, {
      CLAUDE_SESSION_ID: sessionId,
    });
    assert.equal(r2.status, 0, `r2 stderr: ${r2.stderr}`);
    assert.equal(
      r2.stdout.trim(),
      '',
      `second call must be silent (no stdout). got: ${JSON.stringify(r2.stdout)}`,
    );
  });

  it('different CLAUDE_SESSION_ID gets an independent emission', () => {
    const payload = {
      tool_name: 'Grep',
      tool_input: { pattern: 'bar', path: 'src' },
      cwd: WS_ROOT,
    };

    // Session A — first call emits.
    const ra = runGuard('browzer-suggest-grep.mjs', payload, {
      CLAUDE_SESSION_ID: 'integ-grep-iso-A',
    });
    assert.ok(ra.stdout.trim().length > 0, 'session A must emit');

    // Session B — first call must ALSO emit (independent sentinel).
    const rb = runGuard('browzer-suggest-grep.mjs', payload, {
      CLAUDE_SESSION_ID: 'integ-grep-iso-B',
    });
    assert.ok(
      rb.stdout.trim().length > 0,
      'session B must emit independently of session A',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Integration: browzer-block-glob soft-mode dedup vs hard-mode always-emit
// ──────────────────────────────────────────────────────────────────

describe('browzer-block-glob: soft-mode dedup, hard-mode always emits', () => {
  it('soft mode (default): first Glob emits, second silent', () => {
    const sessionId = 'integ-glob-soft-a';
    const payload = {
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts' },
      cwd: WS_ROOT,
    };

    const r1 = runGuard('browzer-block-glob.mjs', payload, {
      CLAUDE_SESSION_ID: sessionId,
    });
    assert.equal(r1.status, 0, `r1 stderr: ${r1.stderr}`);
    assert.ok(r1.stdout.trim().length > 0, 'soft mode: first call must emit');
    const ctx1 = JSON.parse(r1.stdout)?.hookSpecificOutput?.additionalContext;
    assert.ok(typeof ctx1 === 'string' && /Glob bypasses/.test(ctx1));

    const r2 = runGuard('browzer-block-glob.mjs', payload, {
      CLAUDE_SESSION_ID: sessionId,
    });
    assert.equal(r2.status, 0);
    assert.equal(
      r2.stdout.trim(),
      '',
      `soft mode: second call must be silent. got: ${JSON.stringify(r2.stdout)}`,
    );
  });

  it('hard-block mode: ALWAYS emits deny reason, no dedup', () => {
    // Create a per-test workspace with hard-block config.
    const wsHard = path.join(TMP, 'ws-hard');
    fs.mkdirSync(path.join(wsHard, '.browzer'), { recursive: true });
    fs.writeFileSync(
      path.join(wsHard, '.browzer', 'config.json'),
      JSON.stringify({
        workspaceId: 'test-hard',
        gateway: 'https://e',
        hooks: { glob: { mode: 'block' } },
      }),
    );

    const sessionId = 'integ-glob-hard-a';
    const payload = {
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts' },
      cwd: wsHard,
    };

    const r1 = runGuard(
      'browzer-block-glob.mjs',
      payload,
      { CLAUDE_SESSION_ID: sessionId },
      wsHard,
    );
    assert.equal(r1.status, 2, 'hard mode must exit 2 (block)');
    const ctx1 = JSON.parse(r1.stdout)?.hookSpecificOutput?.additionalContext;
    assert.ok(/Glob bypasses/.test(ctx1));

    const r2 = runGuard(
      'browzer-block-glob.mjs',
      payload,
      { CLAUDE_SESSION_ID: sessionId },
      wsHard,
    );
    assert.equal(r2.status, 2, 'hard mode: second call must also exit 2');
    const ctx2 = JSON.parse(r2.stdout)?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx2 === 'string' && /Glob bypasses/.test(ctx2),
      'hard mode: every call must include the deny reason — no dedup',
    );
  });
});
