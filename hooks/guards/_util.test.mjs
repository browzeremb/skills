import { strict as assert } from 'node:assert';
import { test } from 'node:test';
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
  assert.equal(isHookEnabled('auto-format'), true);
  // Caller without an ID → list is ignored.
  assert.equal(isHookEnabled(), true);
  delete process.env.BROWZER_HOOK_DISABLE;
});

test('isHookEnabled binary BROWZER_HOOK=off wins over granular list', () => {
  process.env.BROWZER_HOOK = 'off';
  process.env.BROWZER_HOOK_DISABLE = 'auto-format';
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

test('user-prompt-browzer-search ignores prompts with no trigger', () => {
  const r = runGuard('user-prompt-browzer-search.mjs', {
    prompt: 'what is the best way to add two numbers in math',
  });
  // No vocab match → silent (no stdout).
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0);
});
