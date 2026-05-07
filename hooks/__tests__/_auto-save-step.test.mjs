// Tests for hooks/_auto-save-step.mjs — the PostToolUse(Write) autosave hook.
//
// We exercise the script as a child process with a stubbed `browzer` binary
// on PATH. The hook is opaque otherwise; we assert exit code + stub argv.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

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
});
