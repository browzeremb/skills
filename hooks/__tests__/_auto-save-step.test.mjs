// Tests for hooks/_auto-save-step.mjs — the PostToolUse(Write) autosave hook.
//
// We exercise the script as a child process with a stubbed `browzer` binary
// on PATH. The hook is opaque otherwise; we assert exit code + stub argv.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', '_auto-save-step.mjs');

function makeStubBrowzer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-browzer-'));
  const argLog = path.join(dir, 'argv.json');
  const stub = path.join(dir, 'browzer');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argLog)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;
  fs.writeFileSync(stub, script);
  fs.chmodSync(stub, 0o755);
  return { dir, argLog, stub };
}

function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000, // guard against hook hangs
  });
}

describe('_auto-save-step.mjs', () => {
  it('exits 0 silently when file_path does not match the staging regex', () => {
    const r = runHook({ tool_input: { file_path: '/tmp/random/file.md' } });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, '');
  });

  it('exits 0 silently when BROWZER_AUTOSAVE=0', () => {
    const r = runHook(
      {
        tool_input: { file_path: 'docs/browzer/feat-x/staging/PRD.md' },
      },
      { BROWZER_AUTOSAVE: '0' },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, '');
  });

  it('execs browzer save-step with the right args on a matching path', () => {
    const stub = makeStubBrowzer();
    const home = stub.dir; // pretend $HOME/.local/bin/browzer exists
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-cwd-'));
    const stagingDir = path.join(cwd, 'docs/browzer/feat-y/staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'PRD.md');
    fs.writeFileSync(file, '## Summary\nhi\n');

    const r = runHook(
      {
        tool_input: { file_path: file },
        cwd,
      },
      { HOME: home },
    );

    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const argv = JSON.parse(fs.readFileSync(stub.argLog, 'utf8'));
    assert.deepEqual(argv, [
      'save-step',
      'PRD',
      '--id',
      'feat-y',
      '--from',
      file,
      '--await',
    ]);
  });

  // AC-4: when the staging file does not exist on disk, the hook MUST emit
  // an additionalContext nudge (FR-4) and exit 0 (non-blocking).
  it('AC-4: emits additionalContext with artifact path when staging file is missing', () => {
    // We provide a file_path that matches the staging regex but do NOT create
    // the file on disk — so existsSync returns false.
    const missingPath =
      '/tmp/nonexistent-ac4/docs/browzer/feat-missing/staging/PRD.md';
    const r = runHook({ tool_input: { file_path: missingPath }, cwd: '/tmp' });
    assert.equal(
      r.status,
      0,
      `Expected exit 0, got ${r.status}. stderr=${r.stderr}`,
    );
    // The hook must emit JSON with additionalContext containing the artifact path.
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected JSON on stdout, got: ${r.stdout}`);
    }
    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes(missingPath),
      `Expected additionalContext to contain the artifact path "${missingPath}".\nActual: ${ctx}`,
    );
    assert.ok(
      ctx.toLowerCase().includes('not found') ||
        ctx.toLowerCase().includes('write it'),
      `Expected additionalContext to contain guidance. Actual: ${ctx}`,
    );
  });

  // AC-4 (relative path): same nudge behavior fires when file_path is a
  // relative staging path (no leading /abs/...) — validates STAGING_RE suffix-match.
  it('AC-4 (relative path): emits additionalContext nudge for a relative staging path that does not exist', () => {
    const relativePath = 'docs/browzer/feat-x/staging/PRD.md';
    const r = runHook({ tool_input: { file_path: relativePath }, cwd: '/tmp' });
    assert.equal(
      r.status,
      0,
      `Expected exit 0, got ${r.status}. stderr=${r.stderr}`,
    );
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected JSON on stdout, got: ${r.stdout}`);
    }
    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    // The resolved abs path (resolve('/tmp', relativePath)) should appear in ctx.
    assert.ok(
      ctx.includes('browzer/feat-x/staging/PRD.md'),
      `Expected additionalContext to reference the staging path. Actual: ${ctx}`,
    );
    assert.ok(
      ctx.toLowerCase().includes('not found') ||
        ctx.toLowerCase().includes('write it'),
      `Expected additionalContext to contain guidance. Actual: ${ctx}`,
    );
  });

  // --- Bug B regression tests: TASK_NN staging files must use TASK_NN as phase ---
  //
  // CLI-contract assertions: `_auto-save-step.mjs` invokes `browzer save-step <PHASE>`
  // where TASK_NN is passed directly as the positional phase argument (NOT as `--task-id`).
  // The original bug report (BUG_STOP_HOOK_TASK_PHASE.md Bug B) hypothesized a `--task-id`
  // flag that does not exist in the CLI surface; these tests pin the actual contract.

  // Kills: boundary + return-value (TASK_NN extracted as phase, not swapped to "TASK")
  // Note: `browzer save-step --help` confirms TASK_NN is a valid PHASE argument.
  // The CLI accepts `save-step TASK_01 --id <feat> --from <path>` directly;
  // there is no `--task-id` flag. We assert the exact argv the CLI expects.
  it('Bug B: staged TASK_01.json passes TASK_01 as phase to save-step (boundary + return-value)', () => {
    const stub = makeStubBrowzer();
    const home = stub.dir;
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-task01-'));
    const stagingDir = path.join(cwd, 'docs/browzer/feat-taskb/staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'TASK_01.json');
    fs.writeFileSync(file, '{"execution":{}}');

    const r = runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const argv = JSON.parse(fs.readFileSync(stub.argLog, 'utf8'));
    // CLI accepts TASK_NN directly as the phase name (confirmed via `browzer save-step --help`)
    assert.deepEqual(argv, [
      'save-step',
      'TASK_01',
      '--id',
      'feat-taskb',
      '--from',
      file,
      '--await',
    ]);
  });

  // Regression: non-TASK paths must keep the existing invocation shape unchanged
  // Kills: conditional mutation (TASK_NN branch incorrectly applied to non-TASK phases)
  it('Bug B regression: staged PRD.md passes PRD as phase (non-TASK path untouched)', () => {
    const stub = makeStubBrowzer();
    const home = stub.dir;
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-prd-'));
    const stagingDir = path.join(cwd, 'docs/browzer/feat-prd-reg/staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'PRD.md');
    fs.writeFileSync(file, '## Summary\nok\n');

    const r = runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const argv = JSON.parse(fs.readFileSync(stub.argLog, 'utf8'));
    // Non-TASK phases: phase name passed directly, no structural change
    assert.deepEqual(argv, [
      'save-step',
      'PRD',
      '--id',
      'feat-prd-reg',
      '--from',
      file,
      '--await',
    ]);
  });

  it('exits 2 with structured stderr on CLI failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-fail-'));
    const stub = path.join(dir, 'browzer');
    fs.writeFileSync(
      stub,
      "#!/usr/bin/env node\nprocess.stderr.write('schema validation failed: foo\\n');\nprocess.exit(1);\n",
    );
    fs.chmodSync(stub, 0o755);
    const home = dir;
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-cwd-fail-'));
    const stagingDir = path.join(cwd, 'docs/browzer/feat-z/staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'TASK_03.json');
    fs.writeFileSync(file, '{}');

    const r = runHook(
      {
        tool_input: { file_path: file },
        cwd,
      },
      { HOME: home },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\[autosave\] save-step TASK_03/);
  });

  // AC-7 (FR-7): on CLI failure the hook MUST emit JSON to stdout with
  // hookSpecificOutput.additionalContext naming the failing phase and feat-id.
  // Success path MUST produce empty stdout.
  it('AC-7 (FR-7): emits hookSpecificOutput.additionalContext JSON to stdout on CLI failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-fr7-'));
    const stub = path.join(dir, 'browzer');
    fs.writeFileSync(
      stub,
      "#!/usr/bin/env node\nprocess.stderr.write('CUE validation error: unknown field\\n');\nprocess.exit(1);\n",
    );
    fs.chmodSync(stub, 0o755);
    const home = dir;
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-fr7-'));
    const stagingDir = path.join(cwd, 'docs/browzer/feat-fr7-test/staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'TASK_06.json');
    fs.writeFileSync(file, '{"execution":{}}');

    const r = runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

    // Exit code must be 2 (CLI failure).
    assert.equal(
      r.status,
      2,
      `Expected exit 2, got ${r.status}. stderr=${r.stderr}`,
    );

    // stdout must be valid JSON with hookSpecificOutput.additionalContext.
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(`Expected JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
    }
    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      typeof ctx === 'string' && ctx.length > 0,
      `Expected non-empty additionalContext string. Got: ${JSON.stringify(ctx)}`,
    );
    // Must name the failing phase.
    assert.ok(
      ctx.includes('TASK_06'),
      `Expected additionalContext to contain phase "TASK_06". Got: ${ctx}`,
    );
    // Must name the feat-id.
    assert.ok(
      ctx.includes('feat-fr7-test'),
      `Expected additionalContext to contain feat-id "feat-fr7-test". Got: ${ctx}`,
    );
    // Must include the exit code.
    assert.ok(
      ctx.includes('exitCode='),
      `Expected additionalContext to contain "exitCode=". Got: ${ctx}`,
    );
  });

  // F-1 / stale-receipt scoping: receipts from a *different* feat-id must NOT
  // be included in signals[]. We write two receipt files to os.tmpdir():
  //   update-docs-feat-OTHER-001.json  ← wrong feat-id, must be excluded
  //   update-docs-feat-TARGET-001.json ← correct feat-id, must be included
  // The test asserts that only the TARGET receipt appears in signals[].
  it('F-1: stale receipts from a different feat-id are excluded from signals[]', () => {
    const tmp = os.tmpdir();
    const targetFeat = `feat-target-${Date.now()}`;
    const otherFeat = `feat-other-${Date.now()}`;

    const targetReceipt = path.join(tmp, `update-docs-${targetFeat}-001.json`);
    const otherReceipt = path.join(tmp, `update-docs-${otherFeat}-001.json`);

    fs.writeFileSync(
      targetReceipt,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: `${tmp}/update-docs-${targetFeat}-001.json`,
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    fs.writeFileSync(
      otherReceipt,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: `${tmp}/update-docs-${otherFeat}-001.json`,
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(tmp, 'autosave-scope-'));
      const stagingDir = path.join(cwd, `docs/browzer/${targetFeat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true, pass2: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

      // Read the (possibly rewritten) staging file.
      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      const signals = rewritten.signals ?? [];

      // The other-feat receipt must NOT appear.
      const hasOther = signals.some((s) =>
        JSON.stringify(s).includes(otherFeat),
      );
      assert.ok(
        !hasOther,
        `Stale receipt from ${otherFeat} leaked into signals[]: ${JSON.stringify(signals)}`,
      );

      // The target receipt MUST appear (at least one signal present).
      assert.ok(
        signals.length > 0,
        `Expected signals[] to contain target receipt, got empty: ${JSON.stringify(signals)}`,
      );
      const hasTarget = signals.some((s) =>
        JSON.stringify(s).includes(targetFeat),
      );
      assert.ok(
        hasTarget,
        `Expected target receipt (${targetFeat}) in signals[]: ${JSON.stringify(signals)}`,
      );
    } finally {
      try {
        fs.unlinkSync(targetReceipt);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(otherReceipt);
      } catch {
        /* ignore */
      }
    }
  });

  // F-13 / SE-F-1: when no scoped receipts exist AND twoPassRun is green,
  // signals[] must remain unchanged from what the skill wrote (no sentinel).
  it('F-13: no-receipts case leaves signals[] unchanged (no null-receipt sentinel)', () => {
    const stub = makeStubBrowzer();
    const home = stub.dir;
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    // Use a feat-id that is guaranteed to have no matching receipts in /tmp.
    const noReceiptFeat = `feat-no-receipts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-norec-'));
    const stagingDir = path.join(cwd, `docs/browzer/${noReceiptFeat}/staging`);
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'UPDATE_DOCS.json');
    // signals[] is empty — enrichment is attempted.
    const originalContent = {
      twoPassRun: { pass1: true, pass2: true },
      changedFiles: ['README.md'],
      signals: [],
    };
    fs.writeFileSync(file, JSON.stringify(originalContent));

    runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

    const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
    // signals[] must still be empty — no null-receipt sentinel injected.
    assert.deepEqual(
      rewritten.signals,
      [],
      `Expected signals[] to remain [] (no sentinel). Got: ${JSON.stringify(rewritten.signals)}`,
    );
    // receipt:null must NOT appear anywhere in signals[].
    const hasNullReceipt = (rewritten.signals ?? []).some(
      (s) => s.receipt === null && s.kind === 'no-receipts',
    );
    assert.ok(!hasNullReceipt, 'Null-receipt sentinel must not be emitted');
  });

  // F-14 / SE-F-2: observedAt must be OMITTED from the synthesized signal
  // when the receipt JSON lacks both observedAt and timestamp fields.
  it('F-14: observedAt is omitted from signal when receipt has no timestamp', () => {
    const tmp = os.tmpdir();
    const feat = `feat-no-ts-${Date.now()}`;
    const receiptFile = path.join(tmp, `update-docs-${feat}-001.json`);

    // Receipt deliberately has no observedAt or timestamp field.
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: `${tmp}/update-docs-${feat}-001.json`,
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(tmp, 'autosave-nots-'));
      const stagingDir = path.join(cwd, `docs/browzer/${feat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      const signals = rewritten.signals ?? [];
      assert.ok(
        signals.length > 0,
        `Expected at least one signal, got: ${JSON.stringify(signals)}`,
      );

      for (const s of signals) {
        assert.ok(
          !Object.hasOwn(s, 'observedAt'),
          `Signal must NOT have fabricated observedAt when receipt has none. Got: ${JSON.stringify(s)}`,
        );
      }
    } finally {
      try {
        fs.unlinkSync(receiptFile);
      } catch {
        /* ignore */
      }
    }
  });

  // SE-F-4: collectReceipts falls back to literal /tmp when os.tmpdir() differs.
  // On macOS os.tmpdir() returns a path under /var/folders/... — so /tmp is a
  // distinct second search directory. We write a receipt directly to /tmp and
  // verify that enrichUpdateDocsSignals still picks it up.
  // Skip on Linux where os.tmpdir() === '/tmp' (the fallback dir equals primary).
  it('SE-F-4: receipt in /tmp is collected when os.tmpdir() differs from /tmp', function () {
    if (os.tmpdir() === '/tmp') {
      // On Linux the fallback is a no-op; skip rather than silently pass.
      this.skip('os.tmpdir() === /tmp — fallback path is a no-op on this OS');
    }

    const feat = `feat-se-f4-${Date.now()}`;
    const receiptFile = `/tmp/update-docs-${feat}-001.json`;
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: receiptFile,
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-sef4-'));
      const stagingDir = path.join(cwd, `docs/browzer/${feat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      const signals = rewritten.signals ?? [];
      // The receipt written to /tmp must appear in signals[].
      assert.ok(
        signals.length > 0,
        `Expected signals[] to contain the /tmp receipt. Got: ${JSON.stringify(signals)}`,
      );
      const hasTarget = signals.some((s) => JSON.stringify(s).includes(feat));
      assert.ok(
        hasTarget,
        `Expected receipt for feat ${feat} from /tmp. Got: ${JSON.stringify(signals)}`,
      );
    } finally {
      try {
        fs.unlinkSync(receiptFile);
      } catch {
        /* ignore */
      }
    }
  });

  // SE-F-6: coerceSignal must skip (return null, filtered out) a receipt whose
  // kind field is non-string. Three sub-cases: numeric kind, boolean kind, and
  // absent kind (undefined). Only receipts with a string kind must be included.
  it('SE-F-6: receipts with non-string kind are excluded from signals[]', () => {
    const tmp = os.tmpdir();
    const feat = `feat-se-f6-${Date.now()}`;

    // Three receipts with invalid kind values.
    const badKindNum = path.join(tmp, `update-docs-${feat}-001.json`);
    const badKindBool = path.join(tmp, `update-docs-${feat}-002.json`);
    const noKind = path.join(tmp, `update-docs-${feat}-003.json`);
    // One valid receipt — must survive filtering.
    const goodReceipt = path.join(tmp, `update-docs-${feat}-004.json`);

    fs.writeFileSync(
      badKindNum,
      JSON.stringify({ kind: 42, receipt: badKindNum }),
    );
    fs.writeFileSync(
      badKindBool,
      JSON.stringify({ kind: true, receipt: badKindBool }),
    );
    fs.writeFileSync(
      noKind,
      JSON.stringify({ receipt: noKind, observedAt: '2026-01-01T00:00:00Z' }),
    );
    fs.writeFileSync(
      goodReceipt,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: goodReceipt,
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(tmp, 'autosave-sef6-'));
      const stagingDir = path.join(cwd, `docs/browzer/${feat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true, pass2: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      const signals = rewritten.signals ?? [];

      // Every signal must have a string kind.
      for (const s of signals) {
        assert.equal(
          typeof s.kind,
          'string',
          `Signal has non-string kind: ${JSON.stringify(s)}`,
        );
      }

      // The valid receipt must be present.
      assert.ok(
        signals.length > 0,
        `Expected at least the good receipt in signals[]. Got: ${JSON.stringify(signals)}`,
      );
      const hasGood = signals.some((s) => s.kind === 'doc-patch');
      assert.ok(
        hasGood,
        `Expected "doc-patch" signal from valid receipt. Got: ${JSON.stringify(signals)}`,
      );
    } finally {
      for (const f of [badKindNum, badKindBool, noKind, goodReceipt]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
  });

  // F-2: when writeFileSync throws during signals[] enrichment rewrite, the hook
  // MUST log a WARN to stderr and still exit 0 (non-blocking). We make the
  // staging file read-only AFTER the hook reads it (so shouldEnrich returns
  // true), by pre-writing a read-only file. The trick: write the file, chmod
  // 0o444 so the in-place rewrite fails, then run the hook.
  it('F-2: stderr WARN is emitted and hook exits 0 when signals enrichment write fails', () => {
    const tmp = os.tmpdir();
    const feat = `feat-f2-${Date.now()}`;
    const receiptFile = path.join(tmp, `update-docs-${feat}-001.json`);
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: receiptFile,
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(tmp, 'autosave-f2-'));
      const stagingDir = path.join(cwd, `docs/browzer/${feat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      // Make the staging file read-only so writeFileSync in enrichUpdateDocsSignals throws.
      fs.chmodSync(file, 0o444);

      const r = runHook(
        { tool_input: { file_path: file }, cwd },
        { HOME: home },
      );

      // Restore permissions for cleanup.
      try {
        fs.chmodSync(file, 0o644);
      } catch {
        /* ignore */
      }

      // Hook must still exit 0 (write failure is non-blocking).
      assert.equal(
        r.status,
        0,
        `Expected exit 0 even on write failure, got ${r.status}. stderr=${r.stderr}`,
      );

      // Stderr must contain the WARN message.
      assert.ok(
        r.stderr.includes('[auto-save-step] WARN') &&
          r.stderr.toLowerCase().includes('enrichment write failed'),
        `Expected WARN log on stderr. Got: ${JSON.stringify(r.stderr)}`,
      );
    } finally {
      try {
        fs.unlinkSync(receiptFile);
      } catch {
        /* ignore */
      }
    }
  });

  // QA-2 / F-009 collision regression: a feat-id that is a strict prefix of
  // another feat-id (e.g. `feat-test` ⊂ `feat-test-extended`) MUST NOT capture
  // the longer feat's receipts. Pre-fix: filename `f.includes(featId)` returned
  // true for `update-docs-feat-test-extended-001.json` when featId === 'feat-test'.
  // Post-fix: anchored FILENAME_RE captures the WHOLE feat-id slug between
  // `update-docs-` and the trailing `-<seq>.json`, then exact-equality-checks
  // against the current featId — so `feat-test-extended` cannot match `feat-test`.
  it('QA-2 / F-009: feat-test does NOT match receipts for feat-test-extended (collision regression)', () => {
    const tmp = os.tmpdir();
    // Use stable strings (NOT timestamp-suffixed) so we hit the exact prefix-collision case.
    const shortFeat = `feat-test-${Date.now()}`;
    const longFeat = `${shortFeat}-extended`;
    const longReceipt = path.join(tmp, `update-docs-${longFeat}-001.json`);

    fs.writeFileSync(
      longReceipt,
      JSON.stringify({
        kind: 'doc-patch',
        receipt: longReceipt,
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(tmp, 'autosave-collision-'));
      // Staging path uses the SHORT feat-id — collectReceipts(shortFeat) must
      // skip the longFeat receipt despite the substring overlap.
      const stagingDir = path.join(cwd, `docs/browzer/${shortFeat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true, pass2: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      const signals = rewritten.signals ?? [];

      // The longFeat receipt MUST NOT leak into signals[] for shortFeat.
      const hasLong = signals.some((s) => JSON.stringify(s).includes(longFeat));
      assert.ok(
        !hasLong,
        `Substring collision: ${longFeat} receipt leaked into signals[] for ${shortFeat}: ${JSON.stringify(signals)}`,
      );

      // Since no scoped receipts exist, signals[] must remain empty
      // (F-13 / SE-F-1: no null-receipt sentinel).
      assert.deepEqual(
        signals,
        [],
        `Expected signals[] = [] when no scoped receipts match. Got: ${JSON.stringify(signals)}`,
      );
    } finally {
      try {
        fs.unlinkSync(longReceipt);
      } catch {
        /* ignore */
      }
    }
  });

  // F-006: payload featId discriminator must be trimmed before equality, and
  // a malformed (non-string) discriminator must emit a one-line stderr WARN
  // instead of being silently skipped.
  it('F-006: payload featId is trimmed before equality + non-string discriminator emits WARN', () => {
    const tmp = os.tmpdir();
    const feat = `feat-trim-${Date.now()}`;

    // Receipt 1: featId surrounded by whitespace — must match after trim.
    const trimReceipt = path.join(tmp, `update-docs-${feat}-001.json`);
    fs.writeFileSync(
      trimReceipt,
      JSON.stringify({
        featId: `  ${feat}\n`,
        kind: 'doc-patch',
        receipt: trimReceipt,
      }),
    );

    // Receipt 2: featId is a number (malformed) — must skip + WARN.
    const malformedReceipt = path.join(tmp, `update-docs-${feat}-002.json`);
    fs.writeFileSync(
      malformedReceipt,
      JSON.stringify({
        featId: 42,
        kind: 'doc-patch',
        receipt: malformedReceipt,
      }),
    );

    try {
      const stub = makeStubBrowzer();
      const home = stub.dir;
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
      fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

      const cwd = fs.mkdtempSync(path.join(tmp, 'autosave-f006-'));
      const stagingDir = path.join(cwd, `docs/browzer/${feat}/staging`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const file = path.join(stagingDir, 'UPDATE_DOCS.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          twoPassRun: { pass1: true },
          changedFiles: ['README.md'],
          signals: [],
        }),
      );

      const r = runHook(
        { tool_input: { file_path: file }, cwd },
        { HOME: home },
      );

      // Trimmed featId receipt must be enriched into signals[].
      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      const signals = rewritten.signals ?? [];
      assert.ok(
        signals.some((s) => s.kind === 'doc-patch'),
        `Expected trimmed-featId receipt to enter signals[]. Got: ${JSON.stringify(signals)}`,
      );

      // Malformed (non-string) discriminator must produce a stderr WARN.
      assert.ok(
        r.stderr.includes('[auto-save-step] WARN') &&
          r.stderr.includes('non-string featId discriminator'),
        `Expected non-string discriminator WARN on stderr. Got: ${JSON.stringify(r.stderr)}`,
      );
    } finally {
      for (const f of [trimReceipt, malformedReceipt]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
  });

  // AC-7 (FR-7) success path: stdout MUST be empty on a successful save-step.
  it('AC-7 (FR-7) success path: stdout is empty when browzer save-step succeeds', () => {
    const stub = makeStubBrowzer();
    const home = stub.dir;
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(stub.stub, path.join(home, '.local', 'bin', 'browzer'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'browzer'), 0o755);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-fr7-ok-'));
    const stagingDir = path.join(cwd, 'docs/browzer/feat-fr7-ok/staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const file = path.join(stagingDir, 'TASK_06.json');
    fs.writeFileSync(file, '{"execution":{}}');

    const r = runHook({ tool_input: { file_path: file }, cwd }, { HOME: home });

    assert.equal(
      r.status,
      0,
      `Expected exit 0, got ${r.status}. stderr=${r.stderr}`,
    );
    // Success path: stdout must be empty (no hookSpecificOutput emitted).
    assert.equal(
      r.stdout,
      '',
      `Expected empty stdout on success, got: ${JSON.stringify(r.stdout)}`,
    );
  });
});
