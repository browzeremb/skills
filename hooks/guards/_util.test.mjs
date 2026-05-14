import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as utilModule from './_util.mjs';
import { classifyPath, isHookEnabled, tokensOf } from './_util.mjs';

test('classifyPath', () => {
  assert.equal(classifyPath('src/foo.ts'), 'code');
  assert.equal(classifyPath('README.md'), 'doc');
  assert.equal(classifyPath('package.json'), 'doc');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'config');
  assert.equal(classifyPath('node_modules/foo/index.js'), 'config');
});

test('tokensOf', () => {
  assert.equal(tokensOf(0), 0);
  assert.equal(tokensOf(4), 1);
  assert.equal(tokensOf(7), 2);
});

test('isHookEnabled honors env override', () => {
  process.env.BROWZER_HOOK = 'off';
  assert.equal(isHookEnabled(), false);
  delete process.env.BROWZER_HOOK;
});

test('isHookEnabled honors BROWZER_HOOK_DISABLE comma list', () => {
  process.env.BROWZER_HOOK_DISABLE = 'session-start, rewrite-read';
  assert.equal(isHookEnabled('rewrite-read'), false);
  assert.equal(isHookEnabled('session-start'), false);
  // Hook ID not in list → enabled (modulo config.json which is OS-dependent —
  // a true here is acceptable since the test focuses on the env-list logic).
  assert.equal(isHookEnabled('incremental-sync'), true);
  // Caller without an ID → list is ignored.
  assert.equal(isHookEnabled(), true);
  delete process.env.BROWZER_HOOK_DISABLE;
});

test('isHookEnabled binary BROWZER_HOOK=off wins over granular list', () => {
  process.env.BROWZER_HOOK = 'off';
  process.env.BROWZER_HOOK_DISABLE = 'incremental-sync';
  // Even though 'rewrite-read' is NOT in the disable list, the binary
  // off-switch silences every hook.
  assert.equal(isHookEnabled('rewrite-read'), false);
  delete process.env.BROWZER_HOOK;
  delete process.env.BROWZER_HOOK_DISABLE;
});

import { NEVER_REWRITE_RE, stripQuoted } from './_util.mjs';

test('NEVER_REWRITE_RE matches infra/config files', () => {
  for (const p of [
    'infra/Dockerfile',
    'services/auth/drizzle.config.ts',
    'lib/core/tsup.config.ts',
    'db/migrations/init.sql',
    'pyproject.toml',
    'config.yaml',
    'docker-compose.yml',
    '.env',
    '.env.local',
    'package.json',
    'CLAUDE.md',
    'AGENTS.md',
  ]) {
    assert.ok(NEVER_REWRITE_RE.test(p), `expected match for ${p}`);
  }
});

test('NEVER_REWRITE_RE does not match regular code files', () => {
  for (const p of [
    'src/foo.ts',
    'src/routes/example.ts',
    'lib/search/index.ts',
    'frontend/app/page.tsx',
    'scripts/migrate.js',
    'cmd/main.go',
  ]) {
    assert.equal(NEVER_REWRITE_RE.test(p), false, `unexpected match for ${p}`);
  }
});

test('stripQuoted removes single-quoted bodies', () => {
  assert.equal(stripQuoted("echo 'browzer explore foo' && ls"), 'echo  && ls');
});

test('stripQuoted removes double-quoted bodies', () => {
  assert.equal(stripQuoted('echo "browzer explore foo" && ls'), 'echo  && ls');
});

test('stripQuoted removes $() command substitutions', () => {
  assert.equal(
    stripQuoted('git commit -m "$(cat <<EOF\nbrowzer explore stuff\nEOF\n)"'),
    'git commit -m ',
  );
});

test('stripQuoted removes heredoc bodies (single-quoted delim)', () => {
  const cmd =
    'git commit -m "$(cat <<\'EOF\'\n- browzer explore — 1\n- browzer search — 0\nEOF\n)"';
  const stripped = stripQuoted(cmd);
  assert.ok(
    !stripped.includes('browzer explore'),
    'heredoc body should be stripped',
  );
  assert.ok(
    !stripped.includes('browzer search'),
    'heredoc body should be stripped',
  );
});

test('stripQuoted leaves bare browzer command intact', () => {
  assert.equal(
    stripQuoted('browzer explore foo --json'),
    'browzer explore foo --json',
  );
});

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guardsDir = dirname(fileURLToPath(import.meta.url));

function runGuard(file, hookInput) {
  return spawnSync('node', [join(guardsDir, file)], {
    input: JSON.stringify(hookInput),
    encoding: 'utf8',
    env: { ...process.env, BROWZER_HOOK: 'on' },
  });
}

test('browzer-suggest-grep emits additionalContext with browzer explore hint', () => {
  const r = runGuard('browzer-suggest-grep.mjs', {
    tool_name: 'Grep',
    tool_input: { pattern: 'createLogger', path: 'src/api' },
  });
  // Daemon socket likely missing on CI/dev; hook should still emit JSON
  // because the Track call's catch swallows the failure.
  if (r.status !== 0) return; // skip when not in a workspace (no creds)
  if (!r.stdout) return; // workspace check failed → exit 0 silently
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.additionalContext, /browzer explore/);
});

test('browzer-block-glob defaults to allow + advisory', () => {
  const r = runGuard('browzer-block-glob.mjs', {
    tool_name: 'Glob',
    tool_input: { pattern: 'apps/**/*.ts' },
  });
  if (!r.stdout) return; // skip outside workspace
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.additionalContext, /browzer explore/);
  assert.equal(r.status, 0);
});

// commit-coauthor was removed — it embedded a hard-coded org id and is not
// plugin-agnostic. Repos that need an org-attribution trailer should wire it
// via their own .claude/settings.local.json hook.

test('user-prompt-browzer-search redirects plan-mode prompts to prd/task skills', () => {
  const r = runGuard('user-prompt-browzer-search.mjs', {
    prompt: 'vamos planejar a migração para React 19',
  });
  if (!r.stdout) return;
  const out = JSON.parse(r.stdout);
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /browzer:generate-prd|browzer:generate-task/,
  );
});

test('user-prompt-browzer-search vocab match emits additionalContext (not plain text)', () => {
  const r = runGuard('user-prompt-browzer-search.mjs', {
    prompt: 'how do I configure fastify rate-limit in this repo?',
  });
  if (!r.stdout) return;
  const out = JSON.parse(r.stdout);
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /\[Browzer search guard\]/,
  );
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /browzer search.*--json --save/,
  );
});

test('trackEvent: RPC failure path appends to pending-events.jsonl + ensures daemon', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'browzer-trackEvent-'));
  const prevHome = process.env.HOME;
  const prevSocket = process.env.BROWZER_DAEMON_SOCKET;
  process.env.HOME = tmpHome;
  // Point the daemon socket at a path that does not exist so daemonCall
  // rejects → trackEvent falls into the catch branch.
  process.env.BROWZER_DAEMON_SOCKET = path.join(
    tmpHome,
    'definitely-missing.sock',
  );

  // Re-import the module fresh so it picks up the patched env.
  const url = new URL('./_util.mjs', import.meta.url);
  const mod = await import(`${url.href}?fresh=${Date.now()}`);

  const payload = {
    ts: new Date().toISOString(),
    source: 'unit-test',
    command: 'Read',
    savedTokens: 0,
  };
  await mod.trackEvent(payload);

  const pendingPath = path.join(tmpHome, '.browzer', 'pending-events.jsonl');
  assert.ok(
    existsSync(pendingPath),
    'pending-events.jsonl should exist after RPC failure',
  );
  const lines = readFileSync(pendingPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.source, 'unit-test');
  assert.equal(parsed.method, 'Track');

  process.env.HOME = prevHome;
  if (prevSocket === undefined) delete process.env.BROWZER_DAEMON_SOCKET;
  else process.env.BROWZER_DAEMON_SOCKET = prevSocket;
});

test('trackEvent: RPC success path bypasses pending-events queue', async () => {
  const net = await import('node:net');
  const { mkdtempSync, existsSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'browzer-trackEvent-ok-'));
  const sockPath = path.join(tmpHome, 'daemon.sock');

  // Stand up a stub Unix-socket server that responds with a JSON-RPC OK.
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) {
        sock.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`,
        );
        sock.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const prevHome = process.env.HOME;
  const prevSocket = process.env.BROWZER_DAEMON_SOCKET;
  process.env.HOME = tmpHome;
  process.env.BROWZER_DAEMON_SOCKET = sockPath;

  const url = new URL('./_util.mjs', import.meta.url);
  const mod = await import(`${url.href}?fresh=${Date.now()}`);

  await mod.trackEvent({
    ts: new Date().toISOString(),
    source: 'unit-test-ok',
    command: 'Read',
    savedTokens: 0,
  });

  const pendingPath = path.join(tmpHome, '.browzer', 'pending-events.jsonl');
  assert.equal(
    existsSync(pendingPath),
    false,
    'pending-events.jsonl must not be created on RPC success',
  );

  await new Promise((resolve) => server.close(resolve));
  process.env.HOME = prevHome;
  if (prevSocket === undefined) delete process.env.BROWZER_DAEMON_SOCKET;
  else process.env.BROWZER_DAEMON_SOCKET = prevSocket;
});

// Reference module export to silence unused-import warnings if the
// dynamic re-imports above ever get refactored away.
test('trackEvent is exported', () => {
  assert.equal(typeof utilModule.trackEvent, 'function');
});

test('user-prompt-browzer-search ignores prompts with no trigger', () => {
  const r = runGuard('user-prompt-browzer-search.mjs', {
    prompt: 'what is the best way to add two numbers in math',
  });
  // No vocab match → silent (no stdout).
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0);
});
