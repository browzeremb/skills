// Regression test for FR-7: autosave hook emits structured wakeup JSON on failure.
//
// Contract under test:
//   When `browzer save-step` exits non-zero, _auto-save-step.mjs must:
//   1. Exit with code 2 (asyncRewake-compatible block signal).
//   2. Write a one-line human-readable message to stderr with [autosave] prefix.
//   3. Write valid JSON to stdout with hookSpecificOutput.additionalContext
//      that contains 'auto-save-step failed' (the wakeup signal for the agent loop).
//
// Strategy: create a fake `browzer` binary in a temp PATH dir that exits 2
// and writes a CUE-like error to stderr, then spawn the hook synchronously
// and assert all three invariants.
//
// NOTE — Test scope boundary:
//   This test suite verifies the HOOK-SIDE contract only:
//   that _auto-save-step.mjs correctly emits exit-code 2 and a structured
//   hookSpecificOutput JSON payload when `browzer save-step` exits non-zero.
//
//   It does NOT (and cannot) verify the HARNESS-SIDE contract: that Claude
//   Code's asyncRewake=true matcher in hooks.json actually re-fires the main
//   agent loop with that additionalContext injected. The harness re-fire
//   behaviour is owned by the Claude Code runtime (Anthropic) and is tracked
//   separately. Incident reference: TASK_06 autosave silent failure observed
//   during the 2026-05-12 feature run, where the wakeup signal was emitted
//   correctly by this hook but the harness did not wake the agent — requiring
//   a manual `browzer save-step` retry to unblock. That incident confirms the
//   harness contract is distinct from the hook contract tested here.
//   See: https://github.com/anthropics/claude-code (internal tracker) for the
//   asyncRewake regression report.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', '_auto-save-step.mjs');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fr7-wakeup-'));

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/**
 * Creates a fake `browzer` binary that exits with the given code and writes
 * the given message to stderr. Returns the directory containing the binary
 * (suitable for prepending to PATH).
 */
function makeFakeBrowzer(exitCode, stderrMsg) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'fake-bin-'));
  const bin = path.join(dir, 'browzer');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho '${stderrMsg.replace(/'/g, "'\\''")}' >&2\nexit ${exitCode}\n`,
  );
  fs.chmodSync(bin, 0o755);
  return dir;
}

/**
 * Creates a real staging file so the hook's existsSync check passes.
 * Returns the absolute file path.
 */
function makeStaging(label, phase = 'PRD') {
  const stagingDir = path.join(
    TMP_ROOT,
    'repo',
    label,
    'docs',
    'browzer',
    'feat-x',
    'staging',
  );
  fs.mkdirSync(stagingDir, { recursive: true });
  const ext = phase.startsWith('TASK') ? 'json' : 'md';
  const filePath = path.join(stagingDir, `${phase}.${ext}`);
  fs.writeFileSync(filePath, phase === 'PRD' ? '## Summary\ntest\n' : '{}');
  return filePath;
}

// ============================================================
describe('_auto-save-step.mjs — FR-7 wakeup invariants', () => {
  it('exits 2, emits [autosave] on stderr, emits wakeup JSON on stdout when browzer exits 2', () => {
    const cueError = 'CUE: unknown field foo at path execution.agents[0].foo';
    const fakeBinDir = makeFakeBrowzer(2, cueError);
    const filePath = makeStaging('fr7-01', 'PRD');

    // Prepend fake bin dir to PATH so findBrowzerBin() falls through to `which`
    // and finds our stub. We also unset HOME so the ~/.local/bin lookup misses.
    const newPath = `${fakeBinDir}:${process.env.PATH}`;

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_input: { file_path: filePath },
        cwd: path.dirname(path.dirname(path.dirname(path.dirname(filePath)))),
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: newPath,
        HOME: path.join(TMP_ROOT, 'no-home'),
        BROWZER_AUTOSAVE: undefined,
      },
      timeout: 15_000,
    });

    // 1. Exit code must be 2.
    assert.equal(
      result.status,
      2,
      `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`,
    );

    // 2. Stderr must contain [autosave] and the CUE fragment.
    assert.match(
      result.stderr,
      /\[autosave\] save-step PRD:/,
      `stderr missing [autosave] prefix. stderr was: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /CUE/,
      `stderr missing CUE error fragment. stderr was: ${result.stderr}`,
    );

    // 3. Stdout must be valid JSON with hookSpecificOutput.additionalContext
    //    containing 'auto-save-step failed'.
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.stdout);
    }, `stdout is not valid JSON. stdout was: ${result.stdout}`);

    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx === 'string' && ctx.length > 0,
      `expected hookSpecificOutput.additionalContext to be a non-empty string, got: ${JSON.stringify(ctx)}`,
    );
    assert.ok(
      ctx.includes('auto-save-step failed'),
      `additionalContext must contain 'auto-save-step failed'. got: ${ctx}`,
    );
  });

  it('also exits 2 + emits wakeup JSON for TASK_NN phase when browzer exits non-zero', () => {
    const cueError = 'CUE: execution.gates.baseline.lint: invalid value "bad"';
    const fakeBinDir = makeFakeBrowzer(1, cueError);
    const filePath = makeStaging('fr7-02', 'TASK_03');

    const newPath = `${fakeBinDir}:${process.env.PATH}`;

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_input: { file_path: filePath },
        cwd: path.dirname(path.dirname(path.dirname(path.dirname(filePath)))),
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: newPath,
        HOME: path.join(TMP_ROOT, 'no-home'),
      },
      timeout: 15_000,
    });

    assert.equal(result.status, 2, `Expected exit 2. stderr: ${result.stderr}`);

    // stderr-format invariant: [autosave] prefix must appear on every exit path.
    assert.match(
      result.stderr,
      /\[autosave\]/,
      `stderr missing [autosave] prefix. stderr was: ${result.stderr}`,
    );

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.stdout);
    }, `stdout is not valid JSON: ${result.stdout}`);

    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx === 'string' && ctx.includes('auto-save-step failed'),
      `additionalContext must contain 'auto-save-step failed'. got: ${JSON.stringify(ctx)}`,
    );
  });

  it('hookSpecificOutput is top-level key in stdout JSON (not nested)', () => {
    const fakeBinDir = makeFakeBrowzer(3, 'some error');
    const filePath = makeStaging('fr7-03', 'CODE_REVIEW');

    const newPath = `${fakeBinDir}:${process.env.PATH}`;
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_input: { file_path: filePath },
        cwd: path.dirname(path.dirname(path.dirname(path.dirname(filePath)))),
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: newPath,
        HOME: path.join(TMP_ROOT, 'no-home'),
      },
      timeout: 15_000,
    });

    assert.equal(result.status, 2);

    // stderr-format invariant: [autosave] prefix must appear on every exit path.
    assert.match(
      result.stderr,
      /\[autosave\]/,
      `stderr missing [autosave] prefix. stderr was: ${result.stderr}`,
    );

    const parsed = JSON.parse(result.stdout);
    // hookSpecificOutput must be at the ROOT of the JSON object, not nested.
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, 'hookSpecificOutput'),
      `hookSpecificOutput must be a top-level key. keys: ${Object.keys(parsed)}`,
    );
    // Ensure it is NOT nested inside another hookSpecificOutput.
    assert.equal(
      typeof parsed?.hookSpecificOutput?.hookSpecificOutput,
      'undefined',
      'hookSpecificOutput must not be doubly-nested',
    );
  });
});
