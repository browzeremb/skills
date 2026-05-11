// Tests for hooks/_stop-staging-nudge.mjs — the Stop hook staging nudge.
//
// Strategy: spawn the hook as a child process with a controlled tmp workspace.
// We exercise the three required cases:
//   1. TASK_01 PENDING, staging/TASK_01.json missing  → nudge fires
//   2. TASK_01 PENDING, staging/TASK_01.json present  → silent exit 0
//   3. No workflow.json near cwd                       → silent exit 0

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', '_stop-staging-nudge.mjs');

/**
 * Build a minimal workflow.json with one TASK_01 step at `status`.
 */
function makeWorkflow(taskStatus = 'PENDING') {
  return JSON.stringify({
    version: 2,
    steps: [
      { name: 'CONFIG', status: 'COMPLETED' },
      { name: 'ORIGINAL_REQUEST', status: 'COMPLETED' },
      { name: 'PRD', status: 'COMPLETED' },
      { name: 'TASK_01', status: taskStatus },
    ],
  });
}

/**
 * Create a temp workspace with docs/browzer/<feat>/workflow.json seeded.
 * Optionally create the staging artifact.
 */
function makeWorkspace({ taskStatus = 'PENDING', withArtifact = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-nudge-'));
  const feat = 'feat-test';
  const browzerDir = path.join(root, 'docs', 'browzer', feat);
  fs.mkdirSync(browzerDir, { recursive: true });
  fs.writeFileSync(
    path.join(browzerDir, 'workflow.json'),
    makeWorkflow(taskStatus),
  );

  const stagingDir = path.join(browzerDir, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  if (withArtifact) {
    fs.writeFileSync(path.join(stagingDir, 'TASK_01.json'), '{}');
  }

  return { root, feat, stagingDir };
}

function runHook(cwd, envOverrides = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
    cwd,
    timeout: 5_000,
  });
}

describe('_stop-staging-nudge.mjs', () => {
  it('emits a nudge when TASK_01 is PENDING and staging artifact is missing', () => {
    const { root } = makeWorkspace({
      taskStatus: 'PENDING',
      withArtifact: false,
    });
    const r = runHook(root);

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'Expected JSON nudge on stdout, got empty');

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected valid JSON on stdout, got: ${r.stdout}`);
    }

    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes('TASK_01.json'),
      `Expected nudge to mention TASK_01.json. Got: ${ctx}`,
    );
    assert.ok(
      ctx.toLowerCase().includes('not found') ||
        ctx.toLowerCase().includes('write it'),
      `Expected guidance in nudge. Got: ${ctx}`,
    );
    assert.equal(
      parsed?.hookSpecificOutput?.hookEventName,
      'Stop',
      'hookEventName must be "Stop"',
    );
  });

  it('exits 0 silently when TASK_01 is PENDING and staging artifact exists', () => {
    const { root } = makeWorkspace({
      taskStatus: 'PENDING',
      withArtifact: true,
    });
    const r = runHook(root);

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', `Expected no stdout output, got: ${r.stdout}`);
    assert.equal(r.stderr, '', `Expected no stderr output, got: ${r.stderr}`);
  });

  it('exits 0 silently when no workflow.json is found near cwd', () => {
    const stranger = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-stranger-'),
    );
    const r = runHook(stranger);

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', `Expected no stdout output, got: ${r.stdout}`);
    assert.equal(r.stderr, '', `Expected no stderr output, got: ${r.stderr}`);
  });

  it('exits 0 silently when BROWZER_AUTOSAVE=0', () => {
    const { root } = makeWorkspace({
      taskStatus: 'PENDING',
      withArtifact: false,
    });
    const r = runHook(root, { BROWZER_AUTOSAVE: '0' });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', `Expected no output when autosave disabled`);
  });

  it('exits 0 silently when all steps are COMPLETED (no active phase)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-nudge-done-'));
    const feat = 'feat-done';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'PRD', status: 'COMPLETED' },
          { name: 'TASK_01', status: 'COMPLETED' },
        ],
      }),
    );

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', `Expected no nudge when all steps completed`);
  });

  it('picks the last active step when multiple phases are in-flight (reverse scan)', () => {
    // Workflow has TASK_01 IN_PROGRESS (earlier) and TASK_02 PENDING (later).
    // The reverse scan must surface TASK_02 (last active), not TASK_01.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-nudge-multi-'));
    const feat = 'feat-multi';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'PRD', status: 'COMPLETED' },
          { name: 'TASK_01', status: 'IN_PROGRESS' },
          { name: 'TASK_02', status: 'PENDING' },
        ],
      }),
    );
    // Create staging artifact for TASK_01 but NOT for TASK_02.
    const stagingDir = path.join(browzerDir, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'TASK_01.json'), '{}');

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(
        `Expected valid JSON nudge on stdout (TASK_02 missing). Got: ${r.stdout}`,
      );
    }

    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes('TASK_02'),
      `Expected nudge to reference TASK_02 (the last active step). Got: ${ctx}`,
    );
    assert.ok(
      !ctx.includes('TASK_01'),
      `TASK_01 must not appear in nudge (its artifact exists). Got: ${ctx}`,
    );
  });

  it('emits nudge for PRD phase with .md extension', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-nudge-prd-'));
    const feat = 'feat-prd';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [{ name: 'PRD', status: 'IN_PROGRESS' }],
      }),
    );
    // Do NOT create staging/PRD.md

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected valid JSON on stdout, got: ${r.stdout}`);
    }

    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes('PRD.md'),
      `Expected nudge to reference PRD.md (not .json). Got: ${ctx}`,
    );
  });
});
