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

function runGuard(name, hookInput, envOverrides = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      BROWZER_DAEMON_SOCKET: sockPath,
      // Force in-workspace check to pass by also faking the creds + .browzer dir.
      HOME: tmp,
      ...envOverrides,
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

test('rewrite-read emits advisory additionalContext without mutating file_path', async () => {
  // Since 2026-04-16 retro §3.1, the guard intentionally does NOT swap
  // tool_input.file_path — it surfaces daemon savings as advisory
  // `additionalContext` only. Mutating file_path caused Edit failures
  // downstream ("File has not been read yet"). See comment at
  // browzer-rewrite-read.mjs:54-56.
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
  assert.equal(
    out.hookSpecificOutput.updatedInput,
    undefined,
    'guard must not mutate tool_input — causes Edit harness failures',
  );
  assert.match(out.hookSpecificOutput.additionalContext, /Browzer indexed/);
  assert.match(out.hookSpecificOutput.additionalContext, /~100 tokens/);
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
  // Guard rewrites `cat <file>` → `browzer read <file>` only when the
  // target is ≥40KB (cheap stat-based heuristic at browzer-rewrite-bash.mjs:37).
  // Smaller files bypass the rewrite because the round-trip costs more than
  // it saves. Create a 60KB file to cross the threshold.
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  const src = path.join(tmp, 'src', 'foo.ts');
  fs.writeFileSync(src, 'x'.repeat(60 * 1024));

  const r = await runGuard('browzer-rewrite-bash.mjs', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: `cat ${src}` },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
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

test('rewrite-read respawns daemon via `browzer daemon start --background` when socket is dead', async () => {
  // Dead-socket path that no mock daemon is listening on.
  const deadSock = path.join(tmp, 'd-dead.sock');
  try {
    fs.unlinkSync(deadSock);
  } catch {}

  // Fake browzer binary that records its arguments to a marker file.
  const binDir = path.join(tmp, 'bin-respawn');
  fs.mkdirSync(binDir, { recursive: true });
  const marker = path.join(tmp, 'browzer-spawned.marker');
  try {
    fs.unlinkSync(marker);
  } catch {}
  const fakeBrowzer = path.join(binDir, 'browzer');
  fs.writeFileSync(fakeBrowzer, `#!/bin/sh\necho "$@" > "${marker}"\n`, {
    mode: 0o755,
  });

  const src = path.join(tmp, 'src-respawn.ts');
  fs.writeFileSync(src, 'function foo() { return 42; }');

  const r = await runGuard(
    'browzer-rewrite-read.mjs',
    {
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: src },
    },
    {
      BROWZER_DAEMON_SOCKET: deadSock,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  );

  // Guard must not fail when daemon is down — it degrades gracefully.
  assert.equal(r.code, 0, `guard should exit 0; stderr=${r.stderr}`);

  // Poll for the detached spawn to finish writing the marker. The
  // grandchild is started via `detached: true` so it's racing the
  // test's assertion window; 2s is generous on a loaded CI runner.
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(
    fs.existsSync(marker),
    `guard should have spawned browzer when daemon socket was dead; ` +
      `marker not found at ${marker}`,
  );
  const recorded = fs.readFileSync(marker, 'utf8').trim();
  assert.equal(recorded, 'daemon start --background');
});
