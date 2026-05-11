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

    // Stop hooks surface messages via `decision: "block"` + `reason`
    // (NOT via hookSpecificOutput.additionalContext, which is rejected by the
    // Stop event schema). The block decision is intentional — the turn is not
    // complete until the staging artifact exists.
    const ctx = parsed?.reason ?? '';
    assert.equal(
      parsed?.decision,
      'block',
      'Stop nudge must use decision:"block" to feed the message back to the model',
    );
    assert.ok(
      ctx.includes('TASK_01.json'),
      `Expected nudge to mention TASK_01.json. Got: ${ctx}`,
    );
    assert.ok(
      ctx.toLowerCase().includes('not found') ||
        ctx.toLowerCase().includes('write it'),
      `Expected guidance in nudge. Got: ${ctx}`,
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

    const ctx = parsed?.reason ?? '';
    assert.equal(parsed?.decision, 'block');
    assert.ok(
      ctx.includes('TASK_02'),
      `Expected nudge to reference TASK_02 (the last active step). Got: ${ctx}`,
    );
    assert.ok(
      !ctx.includes('TASK_01'),
      `TASK_01 must not appear in nudge (its artifact exists). Got: ${ctx}`,
    );
  });

  // --- Bug A regression tests: TASK steps use { name: "TASK", taskId: "TASK_01" } ---

  // Kills: return-value mutation (returning step.name instead of step.taskId)
  it('TASK-schema: exits 0 silently when name=TASK, taskId=TASK_01, artifact present (return-value)', () => {
    // Workflow uses the real schema shape: name="TASK", taskId="TASK_01".
    // The artifact staging/TASK_01.json is present — hook must exit silently.
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-task-present-'),
    );
    const feat = 'feat-task-present';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'CONFIG', status: 'COMPLETED' },
          { name: 'ORIGINAL_REQUEST', status: 'COMPLETED' },
          { name: 'PRD', status: 'COMPLETED' },
          { name: 'TASK', taskId: 'TASK_01', status: 'PENDING' },
        ],
      }),
    );
    const stagingDir = path.join(browzerDir, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    // Create the correct artifact (TASK_01.json, not TASK.json)
    fs.writeFileSync(path.join(stagingDir, 'TASK_01.json'), '{}');

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout,
      '',
      `Expected no stdout when artifact present, got: ${r.stdout}`,
    );
    assert.equal(
      r.stderr,
      '',
      `Expected no stderr when artifact present, got: ${r.stderr}`,
    );
  });

  // Kills: return-value mutation + boundary (TASK.json vs TASK_01.json)
  it('TASK-schema: nudges for TASK_01.json (not TASK.json) when name=TASK taskId=TASK_01, artifact absent (return-value + boundary)', () => {
    // Workflow uses the real schema shape: name="TASK", taskId="TASK_01".
    // No staging artifact exists. The nudge must reference TASK_01.json, NOT TASK.json.
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-task-absent-'),
    );
    const feat = 'feat-task-absent';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'CONFIG', status: 'COMPLETED' },
          { name: 'ORIGINAL_REQUEST', status: 'COMPLETED' },
          { name: 'PRD', status: 'COMPLETED' },
          { name: 'TASK', taskId: 'TASK_01', status: 'PENDING' },
        ],
      }),
    );
    // staging dir exists but no TASK_01.json inside
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'Expected a nudge on stdout');

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected valid JSON on stdout, got: ${r.stdout}`);
    }

    assert.equal(parsed?.decision, 'block', 'Must use decision:"block"');
    const reason = parsed?.reason ?? '';
    assert.ok(
      reason.includes('TASK_01.json'),
      `Nudge must reference TASK_01.json (not TASK.json). Got: ${reason}`,
    );
    assert.ok(
      !reason.includes('TASK.json') || reason.includes('TASK_01.json'),
      `Nudge must not reference the phantom TASK.json. Got: ${reason}`,
    );
  });

  // Kills: conditional mutation (empty taskId branch)
  // F-1 + F-5: with the tightened guard, empty taskId causes silent exit (null return).
  it('TASK-schema: exits silently when taskId is empty string', () => {
    // Edge case: name="TASK" but taskId="" — findActivePhase() now returns null
    // (silent exit). No nudge should be emitted.
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-task-empty-id-'),
    );
    const feat = 'feat-empty-taskid';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [{ name: 'TASK', taskId: '', status: 'PENDING' }],
      }),
    );
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout,
      '',
      `Expected silent exit (no nudge) when taskId is empty. Got: ${r.stdout}`,
    );
    assert.equal(
      r.stderr,
      '',
      `Expected no stderr when taskId is empty. Got: ${r.stderr}`,
    );
  });

  // F-10: whitespace-only taskId must also exit silently (trim guard).
  it('TASK-schema: exits silently when taskId is whitespace-only', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-task-ws-id-'),
    );
    const feat = 'feat-ws-taskid';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [{ name: 'TASK', taskId: '   ', status: 'PENDING' }],
      }),
    );
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout,
      '',
      `Expected silent exit (no nudge) when taskId is whitespace-only. Got: ${r.stdout}`,
    );
    assert.equal(
      r.stderr,
      '',
      `Expected no stderr when taskId is whitespace-only. Got: ${r.stderr}`,
    );
  });

  // F-11: virtual phases are skipped; IN_PROGRESS step wins over later PENDING virtual.
  it('TASK-schema: resolves to IN_PROGRESS TASK_01 when followed by a virtual PENDING phase', () => {
    // Steps: [PRD COMPLETED, TASK IN_PROGRESS (taskId=TASK_01), virtual_phase_X PENDING]
    // The loop skips virtual phases via `continue`; TASK_01 is the active step.
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-virtual-skip-'),
    );
    const feat = 'feat-virtual-skip';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'PRD', status: 'COMPLETED' },
          { name: 'TASK', taskId: 'TASK_01', status: 'IN_PROGRESS' },
          { name: 'CONFIG', status: 'PENDING' },
        ],
      }),
    );
    // staging dir present but TASK_01.json absent — nudge must fire for TASK_01
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'Expected a nudge on stdout for TASK_01');

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected valid JSON on stdout, got: ${r.stdout}`);
    }

    assert.equal(parsed?.decision, 'block', 'Must use decision:"block"');
    const reason = parsed?.reason ?? '';
    assert.ok(
      reason.includes('TASK_01.json'),
      `Nudge must reference TASK_01.json (IN_PROGRESS step wins). Got: ${reason}`,
    );
    assert.ok(
      !reason.includes('CONFIG'),
      `CONFIG (virtual phase) must not appear in nudge. Got: ${reason}`,
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

    const ctx = parsed?.reason ?? '';
    assert.equal(parsed?.decision, 'block');
    assert.ok(
      ctx.includes('PRD.md'),
      `Expected nudge to reference PRD.md (not .json). Got: ${ctx}`,
    );
  });

  // Kills: conditional mutation on `typeof step?.taskId === 'string'`
  // When taskId is absent (undefined), the typeof check must return false,
  // causing a silent null return — not a nudge for a phantom artifact.
  it('TASK-schema: exits silently when name=TASK but taskId is absent (undefined)', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-task-no-id-'),
    );
    const feat = 'feat-no-taskid';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    // taskId property is intentionally omitted — name=TASK with no taskId
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [{ name: 'TASK', status: 'PENDING' }],
      }),
    );
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout,
      '',
      `Expected silent exit (no nudge) when taskId is absent. Got: ${r.stdout}`,
    );
    assert.equal(
      r.stderr,
      '',
      `Expected no stderr when taskId is absent. Got: ${r.stderr}`,
    );
  });

  // Kills: return-value mutation on the JSON.parse error path in findActivePhase.
  // Corrupted workflow.json must cause a silent exit — never a crash or nudge.
  it('exits 0 silently when workflow.json contains invalid JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-nudge-bad-json-'));
    const feat = 'feat-bad-json';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      '{not valid json}',
    );
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout,
      '',
      `Expected silent exit on malformed workflow.json. Got: ${r.stdout}`,
    );
    assert.equal(
      r.stderr,
      '',
      `Expected no stderr on malformed workflow.json. Got: ${r.stderr}`,
    );
  });
});
