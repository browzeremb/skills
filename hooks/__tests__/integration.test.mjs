import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const guardsDir = path.join(import.meta.dirname, '..', 'guards');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-hook-'));
const sockPath = path.join(tmp, 'd.sock');

function startMockDaemon(handler) {
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      const result = handler(req.method, req.params);
      conn.end(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
    });
  });
  server.listen(sockPath);
  return server;
}

function runGuard(name, hookInput) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      BROWZER_DAEMON_SOCKET: sockPath,
      // Force in-workspace check to pass by also faking the creds + .browzer dir.
      HOME: tmp,
    };
    fs.mkdirSync(path.join(tmp, '.browzer'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.browzer', 'credentials'), '{}');
    fs.writeFileSync(path.join(tmp, '.browzer', 'config.json'), '{}');
    const child = spawn('node', [path.join(guardsDir, name)], {
      env,
      cwd: tmp,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(hookInput));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('rewrite-read returns updatedInput pointing at temp file', async () => {
  const tempOutput = path.join(tmp, 'brz-out.ts');
  fs.writeFileSync(tempOutput, 'export function foo() {}');
  const srv = startMockDaemon((m) =>
    m === 'Read'
      ? {
          tempPath: tempOutput,
          savedTokens: 100,
          filter: 'aggressive',
          filterFailed: false,
        }
      : { ok: true },
  );

  const src = path.join(tmp, 'src.ts');
  fs.writeFileSync(src, 'function foo() { return 42; }');
  const r = await runGuard('browzer-rewrite-read.mjs', {
    session_id: 's1',
    tool_name: 'Read',
    tool_input: { file_path: src },
  });
  srv.close();
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(out.hookSpecificOutput.updatedInput.file_path, tempOutput);
});

test('block-glob exits 2 outside whitelist', async () => {
  const r = await runGuard('browzer-block-glob.mjs', {
    session_id: 's1',
    tool_name: 'Glob',
    tool_input: { pattern: 'src/**/*.ts' },
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /browzer explore/);
});

test('block-glob allows whitelist patterns', async () => {
  const r = await runGuard('browzer-block-glob.mjs', {
    session_id: 's1',
    tool_name: 'Glob',
    tool_input: { pattern: '.github/workflows/*.yml' },
  });
  assert.equal(r.code, 0);
});

test('rewrite-bash rewrites cat to browzer read', async () => {
  const r = await runGuard('browzer-rewrite-bash.mjs', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'cat src/foo.ts' },
  });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.updatedInput.command, /^browzer read /);
});

test('rewrite-bash leaves piped commands alone', async () => {
  const r = await runGuard('browzer-rewrite-bash.mjs', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'cat src/foo.ts | head' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
