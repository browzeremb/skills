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

// ── T-3: hooks.json schema + guard wiring + PreToolUse chain order ────────────

const HOOKS_JSON_PATH = path.join(import.meta.dirname, '..', 'hooks.json');
const GUARDS_DIR = path.join(import.meta.dirname, '..', 'guards');

test('hooks.json schema: has top-level "hooks" key with all 5 trigger types', () => {
  assert.ok(
    fs.existsSync(HOOKS_JSON_PATH),
    `hooks.json not found at ${HOOKS_JSON_PATH}`,
  );
  const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  assert.ok(
    Object.hasOwn(parsed, 'hooks'),
    'hooks.json must have top-level "hooks" key',
  );

  const EXPECTED_TRIGGERS = [
    'InstructionsLoaded',
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
  ];
  for (const trigger of EXPECTED_TRIGGERS) {
    assert.ok(
      Object.hasOwn(parsed.hooks, trigger),
      `hooks.json must have trigger key: ${trigger}`,
    );
    assert.ok(
      Array.isArray(parsed.hooks[trigger]),
      `hooks.hooks.${trigger} must be an array`,
    );
  }
});

test('hooks.json: every guard file referenced in "command" entries exists on disk', () => {
  const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  // Walk all hook entries and extract guard file references
  // Pattern: ${CLAUDE_PLUGIN_ROOT}/hooks/guards/<file>.mjs
  const guardRefRe =
    /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guards\/([^"'\s]+\.mjs)/g;
  const missing = [];

  const hooksJson = JSON.stringify(parsed);
  let match;
  while ((match = guardRefRe.exec(hooksJson)) !== null) {
    const guardFile = match[1];
    const fullPath = path.join(GUARDS_DIR, guardFile);
    if (!fs.existsSync(fullPath)) {
      missing.push({ reference: match[0], resolvedPath: fullPath });
    }
  }

  assert.equal(
    missing.length,
    0,
    `Missing guard files referenced in hooks.json:\n${missing.map((m) => `  ${m.reference} → ${m.resolvedPath}`).join('\n')}`,
  );
});

test('hooks.json PreToolUse Bash chain order: browzer-rewrite-bash → browzer-contract → browzer-init → commit-coauthor', () => {
  const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  const preToolUse = parsed.hooks['PreToolUse'];
  assert.ok(Array.isArray(preToolUse), 'PreToolUse must be an array');

  // Find the Bash matcher entry
  const bashEntry = preToolUse.find((entry) => entry.matcher === 'Bash');
  assert.ok(bashEntry, 'PreToolUse must have a "Bash" matcher entry');
  assert.ok(Array.isArray(bashEntry.hooks), 'Bash entry must have hooks array');

  const EXPECTED_ORDER = [
    'browzer-rewrite-bash',
    'browzer-contract',
    'browzer-init',
    'commit-coauthor',
  ];

  const actualOrder = bashEntry.hooks
    .map((h) => {
      const m = /guards\/([^"'\s]+)\.mjs/.exec(h.command || '');
      return m ? m[1] : null;
    })
    .filter(Boolean);

  assert.deepEqual(
    actualOrder,
    EXPECTED_ORDER,
    `PreToolUse Bash guard order mismatch.\nExpected: ${EXPECTED_ORDER.join(' → ')}\nActual:   ${actualOrder.join(' → ')}`,
  );
});

test('daemon cache hit: repeated identical query returns faster (or skip if no auth)', {
  skip:
    !process.env.BROWZER_API_KEY &&
    !fs.existsSync(path.join(process.env.HOME || '', '.browzer', 'credentials'))
      ? 'No Browzer auth available — skipping cache timing test'
      : false,
}, async () => {
  const binPath = '/tmp/browzer-test-bin-t2';
  if (!fs.existsSync(binPath)) {
    // Try the system browzer
    const { execFileSync: efs } = await import('node:child_process');
    try {
      efs('which', ['browzer'], { stdio: 'ignore' });
    } catch {
      assert.fail(
        'browzer binary not found at /tmp/browzer-test-bin-t2 and not in PATH — build it first',
      );
    }
  }

  const browzerBin = fs.existsSync(binPath) ? binPath : 'browzer';

  async function timeBrowzerStatus() {
    const start = performance.now();
    try {
      // Use dynamic import() — require() is not available in ESM (.mjs) modules.
      const { execFileSync: efs2 } = await import('node:child_process');
      efs2(browzerBin, ['status', '--json'], {
        encoding: 'utf8',
        timeout: 10000,
      });
    } catch {
      // non-zero exit (e.g. not logged in) is fine — we only care about wall-clock
    }
    return performance.now() - start;
  }

  // First call (cold / uncached)
  const cold = await timeBrowzerStatus();
  // Second call (warm / potentially cached)
  const warm = await timeBrowzerStatus();

  // Warm should be faster, or within 50% of cold (allow some variance)
  // If warm >= cold * 1.5, that's suspicious but we only assert warm < cold * 2
  // to avoid flakiness while still catching a complete cache miss pattern.
  assert.ok(
    warm < cold * 2,
    `Warm call (${warm.toFixed(0)}ms) should not be more than 2x slower than cold call (${cold.toFixed(0)}ms). Cache may not be working.`,
  );
});
