// E2E pipeline test for the token-economy v2 hook lane (PRD FR-14, AC-13).
// Closes F-017 (CODE_REVIEW deferral): wires every postuse / track guard
// against a stub JSON-RPC daemon, captures the Track payload, and asserts
// the (source, estimationMethod, savedTokens) contract end-to-end.
//
// Approach: stub the daemon's Unix socket with a Node `net.Server` so we
// can exercise the hook → daemonCall round-trip without depending on a Go
// `browzer daemon start` binary on PATH. True cross-language e2e (the
// SQLite tracker / batcher / POST chain on the Go side) is covered by
// `packages/cli/internal/daemon/integration_test.go`. This file pins the
// Node-side contract: payload shape, source labels, estimation method,
// and the daemon-down → pending-events.jsonl fallback.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const guardsDir = path.join(import.meta.dirname, '..', 'guards');

/**
 * Spawn a guard with a fully isolated HOME + workspace. Returns
 * `{ code, stdout, stderr, payloads, tmp }` where `payloads` is the list
 * of Track JSON-RPC params captured by the stub daemon during the run.
 *
 * If `withDaemon` is false the socket path is set to a non-existent path
 * so `daemonCall` rejects → trackEvent falls into appendPendingEvent.
 *
 * If `workspaceConfig` is supplied, written to `.browzer/config.json` —
 * needed by the postuse-glob block-mode test.
 */
async function runGuardE2E(name, hookInput, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-e2e-'));
  fs.mkdirSync(path.join(tmp, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(
    path.join(tmp, '.browzer', 'config.json'),
    JSON.stringify(opts.workspaceConfig ?? {}),
  );

  const sockPath = path.join(tmp, 'daemon.sock');
  const payloads = [];
  let server = null;

  if (opts.withDaemon !== false) {
    server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const req = JSON.parse(buf.slice(0, nl));
          if (req.method === 'Track') payloads.push(req.params);
          conn.end(
            `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`,
          );
        } catch {
          conn.end();
        }
      });
    });
    await new Promise((resolve) => server.listen(sockPath, resolve));
  }

  const env = {
    ...process.env,
    BROWZER_HOOK: 'on',
    BROWZER_DAEMON_SOCKET:
      opts.withDaemon === false ? path.join(tmp, 'no-such.sock') : sockPath,
    HOME: tmp,
  };

  const result = await new Promise((resolve) => {
    const child = spawn('node', [path.join(guardsDir, name)], {
      env,
      cwd: tmp,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdin.end(JSON.stringify(hookInput));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  return { ...result, payloads, tmp };
}

test('e2e-token-economy / postuse-read emits hook-read with estimationMethod=estimated', async () => {
  // Build a >40KB code file so the heuristic fires (post-F-010: no shadow
  // daemon call, savedTokens is purely the 0.4× estimated tokens).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-e2e-readfile-'));
  const filePath = path.join(tmp, 'big.ts');
  fs.writeFileSync(filePath, 'const x = 1;\n'.repeat(5000)); // ~65KB

  const r = await runGuardE2E('browzer-postuse-read.mjs', {
    tool_name: 'Read',
    session_id: 's1',
    tool_input: { file_path: filePath },
    tool_response: { content: '' },
  });

  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  assert.equal(r.payloads.length, 1, 'expected one Track call');
  const p = r.payloads[0];
  assert.equal(p.source, 'hook-read');
  assert.equal(p.command, 'Read');
  assert.equal(p.estimationMethod, 'estimated');
  assert.ok(p.savedTokens > 0, `savedTokens=${p.savedTokens} must be positive`);
  assert.equal(p.filterLevel, 'auto');
  assert.equal(p.filterFailed, false);
  assert.equal(p.sessionId, 's1');
  assert.ok(typeof p.pathHash === 'string' && p.pathHash.length === 12);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('e2e-token-economy / postuse-grep emits hook-grep-suggested with estimationMethod=measured', async () => {
  const content = 'x'.repeat(1234);
  const r = await runGuardE2E('browzer-postuse-grep.mjs', {
    tool_name: 'Grep',
    session_id: 's2',
    tool_input: { pattern: 'createLogger', path: 'src' },
    tool_response: { content },
  });

  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  assert.equal(r.payloads.length, 1);
  const p = r.payloads[0];
  assert.equal(p.source, 'hook-grep-suggested');
  assert.equal(p.command, 'Grep');
  assert.equal(p.estimationMethod, 'measured');
  // tokensOf(n) === ceil(n/4)
  assert.equal(p.savedTokens, Math.ceil(1234 / 4));
  assert.equal(p.outputBytes, 1234);
  assert.equal(p.filterLevel, 'suggested');
});

test('e2e-token-economy / postuse-glob block-mode emits counterfactual savedTokens from manifest', async () => {
  // Fixture: workspace config tagging block-mode + a manifest matching the
  // glob pattern. The hook reads ~/.browzer/workspaces/<id>/manifest.json.
  const r = await (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-e2e-glob-'));
    fs.mkdirSync(path.join(tmp, '.browzer'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.browzer', 'credentials'), '{}');
    const wsCfg = {
      workspaceId: 'ws_glob',
      hooks: { glob: { mode: 'block' } },
    };
    fs.writeFileSync(
      path.join(tmp, '.browzer', 'config.json'),
      JSON.stringify(wsCfg),
    );

    // Seed the manifest at HOME/.browzer/workspaces/ws_glob/manifest.json.
    const manifestDir = path.join(tmp, '.browzer', 'workspaces', 'ws_glob');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({
        workspaceId: 'ws_glob',
        indexedAt: '2026-05-07T00:00:00Z',
        files: {
          'src/foo.ts': { lineCount: 100 }, // 100 * 80 = 8000 bytes
          'src/bar.ts': { lineCount: 200 }, // 200 * 80 = 16000 bytes
          'docs/readme.md': { lineCount: 50 }, // skipped — pattern is *.ts
        },
      }),
    );

    const sockPath = path.join(tmp, 'daemon.sock');
    const payloads = [];
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const req = JSON.parse(buf.slice(0, nl));
          if (req.method === 'Track') payloads.push(req.params);
          conn.end(
            `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`,
          );
        } catch {
          conn.end();
        }
      });
    });
    await new Promise((resolve) => server.listen(sockPath, resolve));

    const env = {
      ...process.env,
      BROWZER_HOOK: 'on',
      BROWZER_DAEMON_SOCKET: sockPath,
      HOME: tmp,
    };
    const child = spawn(
      'node',
      [path.join(guardsDir, 'browzer-postuse-glob.mjs')],
      {
        env,
        cwd: tmp,
      },
    );
    child.stdin.end(
      JSON.stringify({
        tool_name: 'Glob',
        session_id: 's3',
        tool_input: { pattern: 'src/*.ts' },
        tool_response: { content: '' },
      }),
    );
    const code = await new Promise((resolve) => child.on('close', resolve));
    await new Promise((resolve) => server.close(resolve));
    return { code, payloads };
  })();

  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const p = r.payloads[0];
  assert.equal(p.source, 'hook-glob-blocked');
  assert.equal(p.estimationMethod, 'counterfactual');
  // (100 + 200) lines * 80 bytes/line = 24000 bytes; tokensOf = ceil(/4) = 6000.
  assert.equal(p.savedTokens, 6000);
  assert.equal(p.filterLevel, 'blocked');
});

test('e2e-token-economy / track-cli matches browzer commands and tracks', async () => {
  // Use a guaranteed-nonexistent --save path so the hook falls back to
  // measuring stdout. Stat() on a missing file → 0 bytes → stdout path.
  const missingSavePath = path.join(
    os.tmpdir(),
    `brz-e2e-track-cli-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const r = await runGuardE2E('browzer-track-cli.mjs', {
    tool_name: 'Bash',
    session_id: 's4',
    tool_input: {
      command: `browzer explore foo --json --save ${missingSavePath}`,
    },
    tool_response: { stdout: 'noise' },
  });

  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  assert.equal(r.payloads.length, 1);
  const p = r.payloads[0];
  assert.equal(p.source, 'hook-cli-explore');
  assert.equal(p.command, 'Bash:browzer explore');
  assert.equal(p.estimationMethod, 'measured');
  assert.equal(p.outputBytes, Buffer.byteLength('noise', 'utf8'));
});

test('e2e-token-economy / track-wasted matches grep -r and tracks negative savedTokens', async () => {
  const stdout = 'x'.repeat(800);
  const r = await runGuardE2E('browzer-track-wasted.mjs', {
    tool_name: 'Bash',
    session_id: 's5',
    tool_input: { command: 'grep -r foo .' },
    tool_response: { stdout },
  });

  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  assert.equal(r.payloads.length, 1);
  const p = r.payloads[0];
  assert.equal(p.source, 'wasted-grep');
  assert.equal(p.command, 'Bash:grep');
  assert.equal(p.estimationMethod, 'counterfactual');
  // tokensOf(800) = 200; wasted lane emits the negative.
  assert.equal(p.savedTokens, -200);
  assert.ok(p.savedTokens < 0, 'wasted-grep must emit negative savedTokens');
});

test('e2e-token-economy / daemon down → appendPendingEvent fallback writes JSONL', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-e2e-fallback-'));
  fs.mkdirSync(path.join(tmp, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(path.join(tmp, '.browzer', 'config.json'), '{}');

  const filePath = path.join(tmp, 'big.ts');
  fs.writeFileSync(filePath, 'const x = 1;\n'.repeat(5000));

  const env = {
    ...process.env,
    BROWZER_HOOK: 'on',
    BROWZER_DAEMON_SOCKET: path.join(tmp, 'definitely-missing.sock'),
    HOME: tmp,
  };

  const result = await new Promise((resolve) => {
    const child = spawn(
      'node',
      [path.join(guardsDir, 'browzer-postuse-read.mjs')],
      {
        env,
        cwd: tmp,
      },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdin.end(
      JSON.stringify({
        tool_name: 'Read',
        session_id: 's6',
        tool_input: { file_path: filePath },
        tool_response: { content: '' },
      }),
    );
    child.on('close', (code) => resolve({ code, stderr }));
  });

  assert.equal(result.code, 0, `stderr=${result.stderr}`);

  const pending = path.join(tmp, '.browzer', 'pending-events.jsonl');
  assert.ok(
    fs.existsSync(pending),
    'pending-events.jsonl must exist after daemon-down Track failure',
  );
  const lines = fs.readFileSync(pending, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.method, 'Track');
  assert.equal(ev.source, 'hook-read');
  assert.equal(ev.estimationMethod, 'estimated');
});
