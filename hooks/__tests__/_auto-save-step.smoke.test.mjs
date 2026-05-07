// Smoke test for hooks/_auto-save-step.mjs — PostToolUse(Write) autosave hook.
//
// Goal: prove the hook's pre-CLI logic (stdin parse + path matching) fires
// correctly when given a valid synthetic payload. The browzer binary is stubbed
// so the test is self-contained and works without a Browzer-initialized workspace.
//
// Matcher invariant under test (documented in CLAUDE.md):
//   hooks.json if: "Write(docs/browzer/*/staging/**)" uses a relative glob.
//   Claude Code's `if` rule evaluates the ABSOLUTE file_path from the hook
//   payload, so the hook itself MUST accept both relative and absolute paths.
//   The STAGING_RE in _auto-save-step.mjs uses a suffix match (no ^ anchor)
//   so it correctly matches absolute paths like /abs/docs/browzer/feat/staging/PRD.md.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', '_auto-save-step.mjs');

// ---------------- fixture setup ----------------

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-smoke-'));

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/**
 * Creates a stub browzer binary under TMP_ROOT/stub-<label>/browzer
 * that exits with `exitCode` and writes its argv to an argLog file.
 */
function makeBrowzerStub(label = 'ok', exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `stub-${label}-`));
  const argLog = path.join(dir, 'argv.json');
  const stub = path.join(dir, 'browzer');
  // ESM helper invoked by the shell wrapper — avoids CJS require() inside an
  // ESM-typed package. The wrapper passes the argLog path as BROWZER_STUB_ARGLOG
  // so the ESM file stays content-static (no template interpolation).
  const helper = path.join(dir, 'browzer-stub-helper.mjs');
  fs.writeFileSync(
    helper,
    `import fs from 'node:fs';\nfs.writeFileSync(process.env.BROWZER_STUB_ARGLOG, JSON.stringify(process.argv.slice(2)));\n`,
  );
  // Shell wrapper: forward all positional args to the ESM helper, then exit
  // with the configured code. No CJS require() anywhere.
  fs.writeFileSync(
    stub,
    `#!/bin/sh\nBROWZER_STUB_ARGLOG=${JSON.stringify(argLog)} node ${JSON.stringify(helper)} "$@"\nexit ${exitCode}\n`,
  );
  fs.chmodSync(stub, 0o755);
  return { dir, argLog, stub };
}

/**
 * Wires the stub binary as ~/.local/bin/browzer inside a fake HOME dir,
 * so the hook's findBrowzerBin() picks it up.
 */
function wireStubAsHome(stubDir) {
  const home = fs.mkdtempSync(path.join(TMP_ROOT, 'home-'));
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, 'browzer');
  fs.copyFileSync(path.join(stubDir, 'browzer'), dest);
  fs.chmodSync(dest, 0o755);
  return home;
}

/**
 * Spawns the hook as a child process, pipes the JSON payload on stdin, and
 * waits for exit. Returns {code, stdout, stderr}.
 */
function runHookAsync(payload, envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Synchronous convenience wrapper (used for simpler assertions).
function runHook(payload, envOverrides = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
    timeout: 15_000,
  });
}

// ============================================================
// MATCHER INVARIANT TESTS
// These directly validate that the STAGING_RE accepts the paths
// Claude Code will emit — absolute paths from the Write tool.
// ============================================================

describe('_auto-save-step.mjs — smoke + matcher invariant', () => {
  // --- 1. Relative path (legacy compat) ---
  it('exits 0 silently for non-staging relative path (no-op)', () => {
    const r = runHook({
      tool_input: { file_path: 'docs/some-other/random/file.md' },
      cwd: '/tmp',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  // --- 2. Absolute path into staging/ (the real runtime shape) ---
  it('fires browzer save-step when file_path is an ABSOLUTE staging path', async () => {
    const { dir: stubDir, argLog } = makeBrowzerStub('abs-ok', 0);
    const home = wireStubAsHome(stubDir);

    // Create a real file at the staging path so the hook finds it.
    const cwd = fs.mkdtempSync(path.join(TMP_ROOT, 'abs-cwd-'));
    const stagingDir = path.join(
      cwd,
      'docs',
      'browzer',
      'feat-smoke-01',
      'staging',
    );
    fs.mkdirSync(stagingDir, { recursive: true });
    const filePath = path.join(stagingDir, 'PRD.md');
    fs.writeFileSync(filePath, '## Summary\nsmoke\n');

    const r = await runHookAsync(
      { tool_input: { file_path: filePath }, cwd },
      { HOME: home },
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);

    // Assert the stub was called with the right argv.
    const argv = JSON.parse(fs.readFileSync(argLog, 'utf8'));
    assert.deepEqual(argv, [
      'save-step',
      'PRD',
      '--id',
      'feat-smoke-01',
      '--from',
      filePath,
      '--await',
    ]);
  });

  // --- 3. JSON extension staging file ---
  it('fires browzer save-step for a staging .json file (TASK_06.json)', async () => {
    const { dir: stubDir, argLog } = makeBrowzerStub('json-ok', 0);
    const home = wireStubAsHome(stubDir);

    const cwd = fs.mkdtempSync(path.join(TMP_ROOT, 'json-cwd-'));
    const stagingDir = path.join(
      cwd,
      'docs',
      'browzer',
      'feat-smoke-02',
      'staging',
    );
    fs.mkdirSync(stagingDir, { recursive: true });
    const filePath = path.join(stagingDir, 'TASK_06.json');
    fs.writeFileSync(filePath, '{}');

    const r = await runHookAsync(
      { tool_input: { file_path: filePath }, cwd },
      { HOME: home },
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const argv = JSON.parse(fs.readFileSync(argLog, 'utf8'));
    assert.equal(argv[0], 'save-step');
    assert.equal(argv[1], 'TASK_06');
    assert.equal(argv[3], 'feat-smoke-02');
  });

  // --- 4. BROWZER_AUTOSAVE=0 bypass ---
  it('exits 0 immediately when BROWZER_AUTOSAVE=0 (no stub invocation)', () => {
    const cwd = fs.mkdtempSync(path.join(TMP_ROOT, 'bypass-cwd-'));
    const stagingDir = path.join(
      cwd,
      'docs',
      'browzer',
      'feat-bypass',
      'staging',
    );
    fs.mkdirSync(stagingDir, { recursive: true });
    const filePath = path.join(stagingDir, 'PRD.md');
    fs.writeFileSync(filePath, 'x');

    const r = runHook(
      { tool_input: { file_path: filePath }, cwd },
      { BROWZER_AUTOSAVE: '0' },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  // --- 5. browse CLI failure → exit 2 with structured stderr ---
  it('exits 2 with [autosave] prefix on stderr when browzer CLI fails', async () => {
    const { dir: stubDir } = makeBrowzerStub('fail', 1);
    const home = wireStubAsHome(stubDir);

    const cwd = fs.mkdtempSync(path.join(TMP_ROOT, 'fail-cwd-'));
    const stagingDir = path.join(
      cwd,
      'docs',
      'browzer',
      'feat-fail',
      'staging',
    );
    fs.mkdirSync(stagingDir, { recursive: true });
    const filePath = path.join(stagingDir, 'CODE_REVIEW.json');
    fs.writeFileSync(filePath, '{}');

    const r = await runHookAsync(
      { tool_input: { file_path: filePath }, cwd },
      { HOME: home },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\[autosave\]/);
  });

  // --- 6. Relative path in file_path resolved via cwd ---
  it('resolves a relative file_path against cwd before passing to browzer', async () => {
    const { dir: stubDir, argLog } = makeBrowzerStub('rel-ok', 0);
    const home = wireStubAsHome(stubDir);

    const cwd = fs.mkdtempSync(path.join(TMP_ROOT, 'rel-cwd-'));
    const stagingDir = path.join(cwd, 'docs', 'browzer', 'feat-rel', 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const absFilePath = path.join(stagingDir, 'PRD.md');
    fs.writeFileSync(absFilePath, 'relative-test');

    const relFilePath = 'docs/browzer/feat-rel/staging/PRD.md';

    const r = await runHookAsync(
      { tool_input: { file_path: relFilePath }, cwd },
      { HOME: home },
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const argv = JSON.parse(fs.readFileSync(argLog, 'utf8'));
    // --from must be the absolute resolved path.
    assert.equal(argv[5], absFilePath);
  });

  // --- 7. Empty payload → silent exit 0 ---
  it('exits 0 silently on empty/malformed payload', () => {
    const r = runHook({});
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});
