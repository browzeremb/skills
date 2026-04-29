// Tests for hooks/_gate-resolve.mjs — the agnostic quality-gate command
// resolver. Each case builds a tmp directory matching one cascade branch,
// imports resolveGateCommand, and asserts {command, source, mode}.
//
// Pure node:test + tmp dirs + node stdlib. No deps.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  detectPackageManager,
  getEffectiveConfig,
  loadSkillsConfig,
  resolveGateCommand,
} from '../_gate-resolve.mjs';

function freshTmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-resolve-${label}-`));
  return dir;
}

function write(dir, rel, contents) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe('detectPackageManager', () => {
  it('returns null when no lockfile and no packageManager', () => {
    const cwd = freshTmp('pm-empty');
    write(cwd, 'package.json', '{"name":"x"}');
    assert.equal(detectPackageManager(cwd), null);
  });

  it('detects pnpm via pnpm-lock.yaml', () => {
    const cwd = freshTmp('pm-pnpm');
    write(cwd, 'pnpm-lock.yaml', '');
    write(cwd, 'package.json', '{"name":"x"}');
    assert.equal(detectPackageManager(cwd), 'pnpm');
  });

  it('detects yarn via yarn.lock', () => {
    const cwd = freshTmp('pm-yarn');
    write(cwd, 'yarn.lock', '');
    assert.equal(detectPackageManager(cwd), 'yarn');
  });

  it('detects npm via package-lock.json', () => {
    const cwd = freshTmp('pm-npm');
    write(cwd, 'package-lock.json', '{}');
    assert.equal(detectPackageManager(cwd), 'npm');
  });

  it('detects bun via bun.lockb', () => {
    const cwd = freshTmp('pm-bun');
    write(cwd, 'bun.lockb', '');
    assert.equal(detectPackageManager(cwd), 'bun');
  });

  it('packageManager field overrides lockfile probe', () => {
    const cwd = freshTmp('pm-override');
    write(cwd, 'package.json', '{"name":"x","packageManager":"yarn@4.0.0"}');
    write(cwd, 'pnpm-lock.yaml', ''); // would otherwise win
    assert.equal(detectPackageManager(cwd), 'yarn');
  });

  it('lockfile precedence: pnpm > yarn > npm > bun', () => {
    const cwd = freshTmp('pm-precedence');
    write(cwd, 'pnpm-lock.yaml', '');
    write(cwd, 'yarn.lock', '');
    write(cwd, 'package-lock.json', '{}');
    write(cwd, 'bun.lockb', '');
    assert.equal(detectPackageManager(cwd), 'pnpm');
  });
});

describe('resolveGateCommand cascade', () => {
  it('step 1: explicit gates.affected from .browzer/skills.config.json wins', () => {
    const cwd = freshTmp('cascade-config');
    write(
      cwd,
      '.browzer/skills.config.json',
      JSON.stringify({ version: 1, gates: { affected: 'make ci' } }),
    );
    // Adding a turbo.json should NOT override.
    write(cwd, 'turbo.json', '{}');
    write(cwd, 'pnpm-lock.yaml', '');
    const r = resolveGateCommand({ cwd });
    assert.deepEqual(r, {
      command: 'make ci',
      source: 'config',
      mode: 'affected',
    });
  });

  it('step 2: package.json#scripts["browzer:gate"] used via detected PM', () => {
    const cwd = freshTmp('cascade-pkg-script');
    write(
      cwd,
      'package.json',
      JSON.stringify({ scripts: { 'browzer:gate': 'do-the-thing' } }),
    );
    write(cwd, 'yarn.lock', '');
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'package-script');
    assert.equal(r.mode, 'affected');
    assert.match(r.command, /^yarn run browzer:gate$/);
  });

  it('step 2: PM defaults to npm when nothing else matches but scripts.browzer:gate exists', () => {
    const cwd = freshTmp('cascade-pkg-no-pm');
    write(
      cwd,
      'package.json',
      JSON.stringify({ scripts: { 'browzer:gate': 'do-the-thing' } }),
    );
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'package-script');
    assert.match(r.command, /^npm run browzer:gate$/);
  });

  it('step 3a: turbo.json + pnpm-lock → pnpm turbo command', () => {
    const cwd = freshTmp('cascade-turbo-pnpm');
    write(cwd, 'turbo.json', '{}');
    write(cwd, 'package.json', '{"name":"x"}');
    write(cwd, 'pnpm-lock.yaml', '');
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'auto:turbo');
    assert.equal(r.mode, 'affected');
    assert.match(r.command, /^pnpm turbo lint typecheck test --filter=/);
  });

  it('step 3a: turbo.json + package-lock (npm) → npx turbo (no global pnpm assumed)', () => {
    const cwd = freshTmp('cascade-turbo-npm');
    write(cwd, 'turbo.json', '{}');
    write(cwd, 'package.json', '{"name":"x"}');
    write(cwd, 'package-lock.json', '{}');
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'auto:turbo');
    assert.match(r.command, /^npx turbo lint typecheck test --filter=/);
  });

  it('step 3b: package.json#scripts.test → ${pm} test', () => {
    const cwd = freshTmp('cascade-npm-test');
    write(cwd, 'package.json', JSON.stringify({ scripts: { test: 'jest' } }));
    write(cwd, 'pnpm-lock.yaml', '');
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'auto:npm-test');
    assert.equal(r.command, 'pnpm test');
    assert.equal(r.mode, 'full');
  });

  it('step 3c: pyproject.toml → pytest && ruff check', () => {
    const cwd = freshTmp('cascade-python');
    write(cwd, 'pyproject.toml', '[project]\n');
    const r = resolveGateCommand({ cwd });
    assert.deepEqual(r, {
      command: 'pytest && ruff check',
      source: 'auto:python',
      mode: 'full',
    });
  });

  it('step 3d: go.mod → go test ./... && go vet ./...', () => {
    const cwd = freshTmp('cascade-go');
    write(cwd, 'go.mod', 'module x\n');
    const r = resolveGateCommand({ cwd });
    assert.deepEqual(r, {
      command: 'go test ./... && go vet ./...',
      source: 'auto:go',
      mode: 'full',
    });
  });

  it('step 3e: Cargo.toml → cargo test && cargo clippy', () => {
    const cwd = freshTmp('cascade-rust');
    write(cwd, 'Cargo.toml', '[package]\n');
    const r = resolveGateCommand({ cwd });
    assert.deepEqual(r, {
      command: 'cargo test && cargo clippy -- -D warnings',
      source: 'auto:rust',
      mode: 'full',
    });
  });

  it('returns null when nothing matches', () => {
    const cwd = freshTmp('cascade-empty');
    const r = resolveGateCommand({ cwd });
    assert.equal(r, null);
  });

  it('precedence: turbo wins over pyproject when both present', () => {
    const cwd = freshTmp('cascade-mixed-turbo-py');
    write(cwd, 'turbo.json', '{}');
    write(cwd, 'package.json', '{"name":"x"}');
    write(cwd, 'pnpm-lock.yaml', '');
    write(cwd, 'pyproject.toml', '[project]\n');
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'auto:turbo');
  });

  it('precedence: package-script wins over auto-detect', () => {
    const cwd = freshTmp('cascade-mixed-pkg-script-go');
    write(
      cwd,
      'package.json',
      JSON.stringify({ scripts: { 'browzer:gate': 'custom' } }),
    );
    write(cwd, 'go.mod', 'module x\n');
    const r = resolveGateCommand({ cwd });
    assert.equal(r.source, 'package-script');
  });
});

describe('loadSkillsConfig schema validation', () => {
  it('returns null + warns when version is missing or wrong', () => {
    const cwd = freshTmp('cfg-bad-version');
    write(cwd, '.browzer/skills.config.json', JSON.stringify({ version: 2 }));
    assert.equal(loadSkillsConfig(cwd), null);
  });

  it('returns null when gates is not an object', () => {
    const cwd = freshTmp('cfg-bad-gates');
    write(
      cwd,
      '.browzer/skills.config.json',
      JSON.stringify({ version: 1, gates: 'oops' }),
    );
    assert.equal(loadSkillsConfig(cwd), null);
  });

  it('returns null when gates.affected is not a string', () => {
    const cwd = freshTmp('cfg-bad-affected');
    write(
      cwd,
      '.browzer/skills.config.json',
      JSON.stringify({ version: 1, gates: { affected: 42 } }),
    );
    assert.equal(loadSkillsConfig(cwd), null);
  });

  it('returns null when timeout is out of range', () => {
    const cwd = freshTmp('cfg-bad-timeout');
    write(
      cwd,
      '.browzer/skills.config.json',
      JSON.stringify({
        version: 1,
        hooks: { qualityGate: { timeout: 9999 } },
      }),
    );
    assert.equal(loadSkillsConfig(cwd), null);
  });

  it('returns null when receipt.ttl is out of range', () => {
    const cwd = freshTmp('cfg-bad-ttl');
    write(
      cwd,
      '.browzer/skills.config.json',
      JSON.stringify({
        version: 1,
        hooks: { qualityGate: { receipt: { ttl: 1 } } },
      }),
    );
    assert.equal(loadSkillsConfig(cwd), null);
  });

  it('accepts a fully valid config', () => {
    const cwd = freshTmp('cfg-valid');
    const cfg = {
      version: 1,
      gates: { affected: 'make ci', full: 'make full' },
      hooks: {
        qualityGate: {
          enabled: true,
          timeout: 300,
          receipt: { ttl: 600, directory: '.browzer/.gate-receipts' },
        },
      },
    };
    write(cwd, '.browzer/skills.config.json', JSON.stringify(cfg));
    assert.deepEqual(loadSkillsConfig(cwd), cfg);
  });
});

describe('getEffectiveConfig', () => {
  it('falls back to defaults when no user config', () => {
    const cwd = freshTmp('eff-defaults');
    const cfg = getEffectiveConfig(cwd);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.hooks.qualityGate.enabled, true);
    assert.equal(cfg.hooks.qualityGate.timeout, 120);
    assert.equal(cfg.hooks.qualityGate.receipt.ttl, 300);
  });

  it('deep-merges user config over defaults', () => {
    const cwd = freshTmp('eff-merge');
    write(
      cwd,
      '.browzer/skills.config.json',
      JSON.stringify({
        version: 1,
        hooks: { qualityGate: { timeout: 600 } },
      }),
    );
    const cfg = getEffectiveConfig(cwd);
    assert.equal(cfg.hooks.qualityGate.timeout, 600);
    // Defaults preserved on un-overridden keys.
    assert.equal(cfg.hooks.qualityGate.enabled, true);
    assert.equal(cfg.hooks.qualityGate.receipt.ttl, 300);
  });
});
