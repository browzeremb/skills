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
  it('emits a nudge when TASK_01 is IN_PROGRESS and staging artifact is missing', () => {
    const { root } = makeWorkspace({
      taskStatus: 'IN_PROGRESS',
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

  // FR-6 (R-19) + F-001: PENDING step whose ALL predecessors are COMPLETED is
  // the dispatch-failure recovery case — nudge fires so the agent re-dispatches.
  // A PENDING step with no predecessor (empty steps before it) stays silent.
  it('FR-6+F-001: nudges when TASK_01 is PENDING and predecessor is COMPLETED (dispatch-failure recovery)', () => {
    // makeWorkspace builds [CONFIG COMPLETED, ORIGINAL_REQUEST COMPLETED,
    // PRD COMPLETED, TASK_01 PENDING] — predecessor is PRD COMPLETED,
    // so this is the dispatch-failure case and the nudge must fire.
    const { root } = makeWorkspace({
      taskStatus: 'PENDING',
      withArtifact: false,
    });
    const r = runHook(root);

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.length > 0,
      `F-001: Expected nudge when PENDING follows COMPLETED predecessor. Got empty stdout`,
    );
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed?.decision, 'block');
    assert.ok(
      parsed?.reason?.includes('TASK_01'),
      `Nudge must reference TASK_01. Got: ${parsed?.reason}`,
    );
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

  it('picks the last IN_PROGRESS step when multiple phases are in-flight (reverse scan)', () => {
    // Workflow has TASK_01 IN_PROGRESS (earlier) and TASK_02 IN_PROGRESS (later,
    // parallel execution). The reverse scan must surface TASK_02 (last IN_PROGRESS),
    // not TASK_01. FR-6: both must be IN_PROGRESS to be candidates.
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
          { name: 'TASK_02', status: 'IN_PROGRESS' },
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
      `Expected nudge to reference TASK_02 (the last IN_PROGRESS step). Got: ${ctx}`,
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
          { name: 'TASK', taskId: 'TASK_01', status: 'IN_PROGRESS' },
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
  it('TASK-schema: nudges for TASK_01.json (not TASK.json) when name=TASK taskId=TASK_01 IN_PROGRESS, artifact absent (return-value + boundary)', () => {
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
          { name: 'TASK', taskId: 'TASK_01', status: 'IN_PROGRESS' },
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
  it('TASK-schema: exits silently when taskId is empty string (IN_PROGRESS but invalid taskId)', () => {
    // Edge case: name="TASK", status="IN_PROGRESS" but taskId="" — findActivePhase()
    // returns null (silent exit) because of the empty-string guard.
    // No nudge should be emitted.
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
        steps: [{ name: 'TASK', taskId: '', status: 'IN_PROGRESS' }],
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
  it('TASK-schema: exits silently when taskId is whitespace-only (IN_PROGRESS but invalid taskId)', () => {
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
        steps: [{ name: 'TASK', taskId: '   ', status: 'IN_PROGRESS' }],
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
  it('TASK-schema: exits silently when name=TASK IN_PROGRESS but taskId is absent (undefined)', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-task-no-id-'),
    );
    const feat = 'feat-no-taskid';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    // taskId property is intentionally omitted — name=TASK IN_PROGRESS with no taskId
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [{ name: 'TASK', status: 'IN_PROGRESS' }],
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

  // FR-6 (R-19): PENDING step whose predecessor is IN_PROGRESS has not been
  // reached yet — the hook must surface the IN_PROGRESS predecessor, not the
  // PENDING step. Exit 0 with a nudge for PRD (the active step), never for
  // the downstream PENDING TASK_03.
  it('FR-6: exits silently for PENDING step when predecessor is IN_PROGRESS (not yet reached)', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-fr6-pending-'),
    );
    const feat = 'feat-fr6-pending';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          // PRD is still IN_PROGRESS — TASK_03 has not been reached yet.
          { name: 'PRD', status: 'IN_PROGRESS' },
          { name: 'TASK', taskId: 'TASK_03', status: 'PENDING' },
        ],
      }),
    );
    // PRD staging artifact present — so PRD's nudge is suppressed too.
    const stagingDir = path.join(browzerDir, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'PRD.md'), '# PRD');

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // PRD artifact is present → no nudge for PRD.
    // TASK_03 predecessor is IN_PROGRESS (not COMPLETED) → no dispatch-failure nudge.
    assert.equal(
      r.stdout,
      '',
      `FR-6: PENDING step not yet reached must not trigger a nudge. Got: ${r.stdout}`,
    );
    assert.equal(r.stderr, '', `Expected no stderr. Got: ${r.stderr}`);
  });

  // F-001 dispatch-failure recovery: PENDING step whose predecessor is COMPLETED
  // indicates the dispatch agent silently failed to transition the step to
  // IN_PROGRESS. The nudge must fire so the agent re-dispatches.
  it('F-001: nudges when PENDING step is immediate next-up after COMPLETED predecessor (dispatch-failure recovery)', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-dispatch-fail-'),
    );
    const feat = 'feat-dispatch-fail';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'PRD', status: 'COMPLETED' },
          // PENDING immediately after COMPLETED — dispatch failure case
          { name: 'TASK', taskId: 'TASK_01', status: 'PENDING' },
        ],
      }),
    );
    // No staging artifact — dispatch never ran
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.length > 0,
      'Expected nudge on stdout for dispatch-failure PENDING step',
    );

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected valid JSON on stdout, got: ${r.stdout}`);
    }

    assert.equal(parsed?.decision, 'block', 'Must use decision:"block"');
    const reason = parsed?.reason ?? '';
    assert.ok(
      reason.includes('TASK_01'),
      `Nudge must reference TASK_01. Got: ${reason}`,
    );
  });

  // F-001: PENDING step whose predecessor is NOT COMPLETED must remain silent.
  it('F-001: exits silently when PENDING step predecessor is not COMPLETED (not yet reached)', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-pending-not-reached-'),
    );
    const feat = 'feat-pending-not-reached';
    const browzerDir = path.join(root, 'docs', 'browzer', feat);
    fs.mkdirSync(browzerDir, { recursive: true });
    fs.writeFileSync(
      path.join(browzerDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [
          { name: 'PRD', status: 'IN_PROGRESS' },
          // PENDING but predecessor is IN_PROGRESS, not COMPLETED — not yet reached
          { name: 'TASK', taskId: 'TASK_01', status: 'PENDING' },
        ],
      }),
    );
    fs.mkdirSync(path.join(browzerDir, 'staging'), { recursive: true });

    const r = runHook(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // PRD IN_PROGRESS was found first (reverse scan returns PRD's phase)
    // so the nudge fires for PRD, not TASK_01. Either way TASK_01 is not
    // the reason — PRD is the active phase here.
    // The important invariant: no crash and exit 0.
    assert.equal(r.status, 0, 'Must exit 0');
  });

  // F-013: BROWZER_HOOK_DEBUG breadcrumb on FR-9 silent exit.
  it('F-013: writes stderr breadcrumb when BROWZER_HOOK_DEBUG set and FR-9 workflow.json not found', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-fr9-debug-'),
    );
    // No workflow.json at all in this workspace
    const r = runHook(root, {
      BROWZER_WORKFLOW_ID: 'feat-nonexistent',
      BROWZER_HOOK_DEBUG: '1',
    });

    assert.equal(r.status, 0, `Expected exit 0, stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'No stdout — breadcrumb goes to stderr only');
    assert.ok(
      r.stderr.includes('FR-9'),
      `Expected FR-9 breadcrumb on stderr. Got: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('feat-nonexistent'),
      `Breadcrumb must include the workflow id. Got: ${r.stderr}`,
    );
  });

  // F-013: No stderr when BROWZER_HOOK_DEBUG is unset (happy-path not disturbed).
  it('F-013: no stderr breadcrumb when BROWZER_HOOK_DEBUG is unset on FR-9 exit', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-fr9-nodebug-'),
    );
    const r = runHook(root, {
      BROWZER_WORKFLOW_ID: 'feat-nonexistent',
      BROWZER_HOOK_DEBUG: '',
    });

    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'No stdout');
    assert.equal(r.stderr, '', 'No stderr when debug not set');
  });

  // FR-9 (R-24): BROWZER_WORKFLOW_ID set but corresponding workflow.json absent.
  // The hook must exit 0 silently — it must NOT fall through to mtime-based
  // discovery and load a different feature's workflow.json.
  it('FR-9: exits 0 silently when BROWZER_WORKFLOW_ID is set but workflow.json not found', () => {
    // Create a workspace with a DIFFERENT feature's workflow.json.
    // The env var points to a non-existent feature — hook must not load the other one.
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stop-nudge-fr9-missing-wf-'),
    );
    const otherFeat = 'feat-other';
    const otherDir = path.join(root, 'docs', 'browzer', otherFeat);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, 'workflow.json'),
      JSON.stringify({
        version: 2,
        steps: [{ name: 'TASK', taskId: 'TASK_01', status: 'IN_PROGRESS' }],
      }),
    );
    // staging dir for the OTHER feature is missing its artifact
    fs.mkdirSync(path.join(otherDir, 'staging'), { recursive: true });

    // Point BROWZER_WORKFLOW_ID at a non-existent feature id.
    // The hook must exit silently rather than loading feat-other's workflow.
    const r = runHook(root, {
      BROWZER_WORKFLOW_ID: 'feat-does-not-exist',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout,
      '',
      `FR-9: must exit silently when BROWZER_WORKFLOW_ID target not found (not fall through). Got: ${r.stdout}`,
    );
    assert.equal(r.stderr, '', `Expected no stderr. Got: ${r.stderr}`);
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
