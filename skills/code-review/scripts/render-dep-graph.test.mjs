/**
 * render-dep-graph.test.mjs
 *
 * node --test coverage for render-dep-graph.mjs.
 * Uses RENDER_DEP_GRAPH_FIXTURE_DIR to inject fixture JSON files instead of
 * calling `browzer deps`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'render-dep-graph.mjs');

// ---------------------------------------------------------------------------
// Helper: run the script synchronously, capturing stdout/stderr
// ---------------------------------------------------------------------------
function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// Helper: write a fixture JSON file
// ---------------------------------------------------------------------------
function writeFixture(dir, filePath, importedBy) {
  const name = filePath.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
  writeFileSync(join(dir, name), JSON.stringify({ importedBy }), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('renders graph LR with importedBy entries', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rdg-'));
  const outDir = mkdtempSync(join(tmpdir(), 'rdg-out-'));
  const outFile = join(outDir, 'DEP_GRAPH.mmd');

  try {
    writeFixture(fixtureDir, 'apps/api/src/lib/auth.ts', [
      'apps/api/src/routes/login.ts',
      'apps/api/src/routes/logout.ts',
    ]);

    const { exitCode, stderr } = run(
      ['--files', 'apps/api/src/lib/auth.ts', '--out', outFile],
      { RENDER_DEP_GRAPH_FIXTURE_DIR: fixtureDir },
    );

    assert.equal(exitCode, 0, `unexpected exit code; stderr: ${stderr}`);

    const content = readFileSync(outFile, 'utf8');
    assert.ok(content.startsWith('graph LR\n'), 'must start with graph LR');
    assert.ok(
      content.includes('F0["apps/api/src/lib/auth.ts"]'),
      'must contain F0 node',
    );
    assert.ok(
      content.includes('F0_0["apps/api/src/routes/login.ts"]'),
      'must contain first reverse importer',
    );
    assert.ok(
      content.includes('F0_1["apps/api/src/routes/logout.ts"]'),
      'must contain second reverse importer',
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('renders multiple files', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rdg-'));
  const outDir = mkdtempSync(join(tmpdir(), 'rdg-out-'));
  const outFile = join(outDir, 'DEP_GRAPH.mmd');

  try {
    writeFixture(fixtureDir, 'apps/api/src/lib/auth.ts', [
      'apps/api/src/routes/login.ts',
    ]);
    writeFixture(fixtureDir, 'packages/core/src/index.ts', [
      'apps/api/src/server.ts',
    ]);

    const { exitCode } = run(
      [
        '--files',
        'apps/api/src/lib/auth.ts,packages/core/src/index.ts',
        '--out',
        outFile,
      ],
      { RENDER_DEP_GRAPH_FIXTURE_DIR: fixtureDir },
    );

    assert.equal(exitCode, 0);

    const content = readFileSync(outFile, 'utf8');
    assert.ok(content.includes('F0["apps/api/src/lib/auth.ts"]'));
    assert.ok(content.includes('F1["packages/core/src/index.ts"]'));
    assert.ok(content.includes('F1_0["apps/api/src/server.ts"]'));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('caps at 25 reverse importers and appends overflow node', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rdg-'));
  const outDir = mkdtempSync(join(tmpdir(), 'rdg-out-'));
  const outFile = join(outDir, 'DEP_GRAPH.mmd');

  try {
    const importedBy = Array.from(
      { length: 30 },
      (_, i) => `apps/consumer-${i}.ts`,
    );
    writeFixture(fixtureDir, 'packages/core/src/index.ts', importedBy);

    const { exitCode } = run(
      ['--files', 'packages/core/src/index.ts', '--out', outFile],
      { RENDER_DEP_GRAPH_FIXTURE_DIR: fixtureDir },
    );

    assert.equal(exitCode, 0);

    const content = readFileSync(outFile, 'utf8');
    // Only 25 real entries (indices 0-24)
    assert.ok(content.includes('F0_24["apps/consumer-24.ts"]'));
    assert.ok(!content.includes('F0_25["apps/consumer-25.ts"]'));
    // Overflow node
    assert.ok(content.includes('... (+5 more)'));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('partial success: skips files with missing fixtures and exits 0', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rdg-'));
  const outDir = mkdtempSync(join(tmpdir(), 'rdg-out-'));
  const outFile = join(outDir, 'DEP_GRAPH.mmd');

  try {
    // Only provide fixture for the second file
    writeFixture(fixtureDir, 'packages/core/src/index.ts', [
      'apps/api/src/server.ts',
    ]);

    const { exitCode, stderr } = run(
      [
        '--files',
        'apps/api/src/lib/auth.ts,packages/core/src/index.ts',
        '--out',
        outFile,
      ],
      { RENDER_DEP_GRAPH_FIXTURE_DIR: fixtureDir },
    );

    // Still exits 0 (partial success)
    assert.equal(exitCode, 0);
    // Warns on stderr about missing file
    assert.ok(
      stderr.includes('apps/api/src/lib/auth.ts') ||
        stderr.includes('skipping'),
      'expected stderr warning about skipped file',
    );

    const content = readFileSync(outFile, 'utf8');
    // The second file (now re-indexed at F1) should still appear
    assert.ok(content.includes('packages/core/src/index.ts'));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('renders empty graph when all files fail', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rdg-empty-'));
  const outDir = mkdtempSync(join(tmpdir(), 'rdg-out-'));
  const outFile = join(outDir, 'DEP_GRAPH.mmd');

  try {
    const { exitCode } = run(
      ['--files', 'apps/api/src/lib/auth.ts', '--out', outFile],
      { RENDER_DEP_GRAPH_FIXTURE_DIR: fixtureDir },
    );

    assert.equal(exitCode, 0);
    const content = readFileSync(outFile, 'utf8');
    assert.ok(content.startsWith('graph LR\n'));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('exits 1 when --files or --out are missing', () => {
  const { exitCode } = run([]);
  assert.equal(exitCode, 1);
});

test('renders file with zero reverse importers (leaf node only)', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rdg-'));
  const outDir = mkdtempSync(join(tmpdir(), 'rdg-out-'));
  const outFile = join(outDir, 'DEP_GRAPH.mmd');

  try {
    writeFixture(fixtureDir, 'apps/api/src/lib/leaf.ts', []);

    const { exitCode } = run(
      ['--files', 'apps/api/src/lib/leaf.ts', '--out', outFile],
      { RENDER_DEP_GRAPH_FIXTURE_DIR: fixtureDir },
    );

    assert.equal(exitCode, 0);
    const content = readFileSync(outFile, 'utf8');
    assert.ok(content.includes('F0["apps/api/src/lib/leaf.ts"]'));
    // No arrows expected
    assert.ok(!content.includes('-->'));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
