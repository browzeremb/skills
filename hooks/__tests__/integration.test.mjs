import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const hooksDir = path.join(import.meta.dirname, '..'); // .../hooks/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-hook-'));

// Detect whether `browzer hook` is supported by the installed binary.
// The .sh wrappers delegate to `browzer hook <name>`; when the subcommand
// is absent these tests fail hard — the hook subcommand is required for
// CI-parity. Build the CLI first: `cd packages/cli && go build -o browzer .`
// and ensure the binary is on PATH before running this suite.
const BROWZER_HOOK_AVAILABLE = (() => {
  try {
    execFileSync('browzer', ['hook', '--help'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Hard-fail guard for tests that require `browzer hook` to be on PATH.
 * Replaces the former soft-skip so regressions are never masked by a
 * missing binary.  Call this as the first statement in any test that
 * exercises the shell delegators.
 */
function requireBrowzerHook() {
  if (!BROWZER_HOOK_AVAILABLE) {
    assert.fail(
      'browzer hook subcommand unavailable — build the CLI first: ' +
        'cd packages/cli && go build -o /usr/local/bin/browzer . ' +
        '(or ensure packages/cli/browzer is on PATH)',
    );
  }
}

// Guard name mapping: logical name (without prefix/extension) → .sh filename.
// Pass the logical name to runGuard (e.g. 'rewrite-bash') and the function
// resolves the correct .sh path under hooks/.
const GUARD_TO_SH = {
  'rewrite-read': 'rewrite-read.sh',
  'block-glob': 'block-glob.sh',
  'rewrite-bash': 'rewrite-bash.sh',
  'sync-on-push': 'sync-on-push.sh',
  'postuse-run': 'postuse-run.sh',
};

function runGuard(name, hookInput, envOverrides = {}, cwdOverride) {
  return new Promise((resolve) => {
    // Assign a unique CLAUDE_SESSION_ID per invocation so sentinel files
    // (keyed on session id or ppid) never bleed across test cases that share
    // the same process.ppid within a single `node --test` run.
    // TMPDIR is pinned to the test's own tmp dir so sentinels land in a
    // controlled, cleaned-up location rather than the system /tmp.
    // CLAUDE_PROJECT_DIR is cleared so the sentinel key always resolves via
    // CLAUDE_SESSION_ID, never via SHA1(project dir).
    const sessionId = `brz-intg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const env = {
      ...process.env,
      // Force in-workspace check to pass by also faking the creds + .browzer dir.
      HOME: tmp,
      // Sentinel isolation.
      CLAUDE_SESSION_ID: sessionId,
      TMPDIR: tmp,
      CLAUDE_PROJECT_DIR: '',
      ...envOverrides,
    };
    const cwd = cwdOverride ?? tmp;
    fs.mkdirSync(path.join(cwd, '.browzer'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.browzer', 'credentials'), '{}');
    fs.writeFileSync(path.join(cwd, '.browzer', 'config.json'), '{}');

    // Resolve the .sh wrapper path. Accept either:
    //   - a logical name (key in GUARD_TO_SH, e.g. 'rewrite-bash'), or
    //   - a bare .sh filename (e.g. 'rewrite-bash.sh').
    const shFile =
      GUARD_TO_SH[name] ?? (name.endsWith('.sh') ? name : `${name}.sh`);
    const shPath = path.join(hooksDir, shFile);

    const child = spawn('bash', [shPath], { env, cwd });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(hookInput));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// writeFeatFixture creates docs/browzer/<featName>/ under `cwd` with optional
// TASK_*.md / TASK_*.completed.md files. Used by the rewrite-bash regression
// test asserting no step-id env var is injected even when feat dirs exist.
function writeFeatFixture(cwd, featName, { taskFiles = [] } = {}) {
  const featDir = path.join(cwd, 'docs', 'browzer', featName);
  fs.mkdirSync(featDir, { recursive: true });
  for (const f of taskFiles) {
    fs.writeFileSync(path.join(featDir, f), '');
  }
  return featDir;
}

test('rewrite-read emits advisory for large files without mutating file_path', async () => {
  requireBrowzerHook();
  // The lean guard does a local stat-based size check (≥40KB) and emits
  // a single advisory additionalContext suggesting `browzer explore` /
  // `browzer read --filter=auto`. No daemon round-trip; no tool_input
  // mutation (mutating file_path causes Edit harness failures).
  const src = path.join(tmp, 'big.ts');
  fs.writeFileSync(src, 'x'.repeat(60 * 1024));
  const r = await runGuard('rewrite-read', {
    session_id: 's1',
    tool_name: 'Read',
    tool_input: { file_path: src },
  });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(
    out.hookSpecificOutput.updatedInput,
    undefined,
    'guard must not mutate tool_input — causes Edit harness failures',
  );
  assert.match(out.hookSpecificOutput.additionalContext, /browzer explore/);
});

test('rewrite-read silently passes small files', async () => {
  requireBrowzerHook();
  const src = path.join(tmp, 'small.ts');
  fs.writeFileSync(src, 'function foo() { return 42; }');
  const r = await runGuard('rewrite-read', {
    session_id: 's1',
    tool_name: 'Read',
    tool_input: { file_path: src },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('block-glob default: allow + advisory outside whitelist', async () => {
  requireBrowzerHook();
  const r = await runGuard('block-glob', {
    session_id: 's1',
    tool_name: 'Glob',
    tool_input: { pattern: 'src/**/*.ts' },
  });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.additionalContext, /browzer explore/);
});

test('block-glob silently passes whitelist patterns', async () => {
  requireBrowzerHook();
  const r = await runGuard('block-glob', {
    session_id: 's1',
    tool_name: 'Glob',
    tool_input: { pattern: '.github/workflows/*.yml' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('rewrite-bash rewrites cat to browzer read', async () => {
  requireBrowzerHook();
  // Guard rewrites `cat <file>` → `browzer read <file>` only when the
  // target is ≥40KB (cheap stat-based heuristic). Create a 60KB file to
  // cross the threshold.
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  const src = path.join(tmp, 'src', 'foo.ts');
  fs.writeFileSync(src, 'x'.repeat(60 * 1024));

  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: `cat ${src}` },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.updatedInput.command, /^browzer read /);
});

test('rewrite-bash leaves piped commands alone', async () => {
  requireBrowzerHook();
  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'cat src/foo.ts | head' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

// ── BROWZER_LLM=1 injection (WF-SYNC-2, 2026-05-04) ───────────────────────────
// Each Bash tool call in Claude Code runs in an isolated shell; an `export`
// inside one call does NOT persist to the next. The guard prefixes every
// `browzer …` invocation with `BROWZER_LLM=1` so the per-mutation audit line
// is suppressed in agent context, with idempotence guards for opt-out.

test('rewrite-bash prefixes BROWZER_LLM=1 to plain `browzer …` commands', async () => {
  requireBrowzerHook();
  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'browzer status' },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(
    out.hookSpecificOutput.updatedInput.command,
    'BROWZER_LLM=1 browzer status',
  );
  assert.match(out.hookSpecificOutput.additionalContext, /BROWZER_LLM=1/);
});

test('rewrite-bash skips prefix when operator already set BROWZER_LLM=1', async () => {
  requireBrowzerHook();
  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'BROWZER_LLM=1 browzer status' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'idempotent: must not double-prefix');
});

test('rewrite-bash respects operator opt-out BROWZER_LLM=0', async () => {
  requireBrowzerHook();
  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'BROWZER_LLM=0 browzer status' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'opt-out: must not override BROWZER_LLM=0');
});

test('rewrite-bash skips prefix when --llm flag is present', async () => {
  requireBrowzerHook();
  for (const cmd of [
    'browzer status --llm',
    'browzer status --llm=0',
    'browzer search "foo" --llm=1 --json',
  ]) {
    const r = await runGuard('rewrite-bash', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: cmd },
    });
    assert.equal(r.code, 0, `cmd=${cmd} stderr=${r.stderr}`);
    assert.equal(r.stdout, '', `cmd=${cmd}: must not prefix when --llm passed`);
  }
});

test('rewrite-bash leaves subshell-wrapped browzer commands alone', async () => {
  requireBrowzerHook();
  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: '(cd /tmp && browzer status)' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'subshell-wrapped: cannot safely prepend env');
});

test('rewrite-bash leaves compound non-leading browzer commands alone', async () => {
  requireBrowzerHook();
  // `git status && browzer ...` — leading token is `git`, not `browzer`.
  const r = await runGuard('rewrite-bash', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'git status && browzer status' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'leading-token-not-browzer: regex does not match');
});

test('rewrite-bash prefixes browzer search/explore/deps/ask too', async () => {
  requireBrowzerHook();
  for (const verb of ['search', 'explore', 'deps', 'ask', 'status', 'sync']) {
    const r = await runGuard('rewrite-bash', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: `browzer ${verb} foo --json` },
    });
    assert.equal(r.code, 0, `verb=${verb}: stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.updatedInput.command,
      new RegExp(`^BROWZER_LLM=1 browzer ${verb} `),
      `verb=${verb}: should prefix`,
    );
  }
});

// --- rewrite-bash: no step-id env injection (markdown-chains era) ---
//
// The workflow-correlation env injection (RETRO §C8) was removed in the
// markdown-chains cleanup. The hook now produces only `BROWZER_LLM=1 <cmd>` —
// no step-id prefix regardless of the state of docs/browzer/ on disk.

// The env var that used to be injected; split to avoid self-matching grep.
const STEP_ID_ENV_VAR = 'BROWZER_WORKFLOW' + '_STEP_ID';

test('rewrite-bash does not inject step-id env var even when feat dir has tasks', async () => {
  requireBrowzerHook();
  const caseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'brz-hook-no-step-stamp-'),
  );
  // Plant a feat directory with completed task files (simulating in-flight work).
  writeFeatFixture(caseDir, 'feat-active', {
    taskFiles: ['TASK_01.completed.md', 'TASK_02.md'],
  });

  const r = await runGuard(
    'rewrite-bash',
    {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'browzer status' },
    },
    {},
    caseDir,
  );

  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(
    out.hookSpecificOutput.updatedInput.command,
    'BROWZER_LLM=1 browzer status',
    'step-id injection removed — only BROWZER_LLM=1 prefix',
  );
  assert.doesNotMatch(
    out.hookSpecificOutput.updatedInput.command,
    new RegExp(STEP_ID_ENV_VAR),
    'step-id env var must never appear in the rewritten command',
  );
});

// (rewrite-read no longer talks to the daemon — the daemon-respawn test
// that used to live here was retired alongside the round-trip removal.)

// ── T-3: hooks.json schema + hook wiring + PreToolUse chain order ────────────

const HOOKS_JSON_PATH = path.join(import.meta.dirname, '..', 'hooks.json');
const HOOKS_DIR = path.join(import.meta.dirname, '..');

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
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'SubagentStop',
    'Stop',
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

test('hooks.json: every .sh file referenced in "command" entries exists on disk', () => {
  const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  // Walk all hook entries and extract .sh file references.
  // Pattern: ${CLAUDE_PLUGIN_ROOT}/hooks/<file>.sh
  const shRefRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"'\s]+\.sh)/g;
  const missing = [];

  const hooksJson = JSON.stringify(parsed);
  for (const match of hooksJson.matchAll(shRefRe)) {
    const shFile = match[1];
    const fullPath = path.join(HOOKS_DIR, shFile);
    if (!fs.existsSync(fullPath)) {
      missing.push({ reference: match[0], resolvedPath: fullPath });
    }
  }

  assert.equal(
    missing.length,
    0,
    `Missing .sh files referenced in hooks.json:\n${missing.map((m) => `  ${m.reference} → ${m.resolvedPath}`).join('\n')}`,
  );
});

test('hooks.json PreToolUse Bash chain order: rewrite-bash.sh → contract.sh → init.sh', () => {
  // The consolidated Go-backed shape has one handler per shell wrapper.
  // Chain ordering invariant: rewrite-bash.sh runs before contract.sh,
  // and contract.sh runs before init.sh.
  const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  const preToolUse = parsed.hooks.PreToolUse;
  assert.ok(Array.isArray(preToolUse), 'PreToolUse must be an array');

  const bashEntry = preToolUse.find((entry) => entry.matcher === 'Bash');
  assert.ok(bashEntry, 'PreToolUse must have a "Bash" matcher entry');
  assert.ok(Array.isArray(bashEntry.hooks), 'Bash entry must have hooks array');

  // Extract the .sh basename (without extension) from each command field.
  const shSequence = bashEntry.hooks
    .map((h) => {
      const m = /hooks\/([^"'\s/]+)\.sh/.exec(h.command || '');
      return m ? m[1] : null;
    })
    .filter(Boolean);

  // Dedupe-preserving-order: collapse runs of the same entry into one.
  const distinct = [];
  for (const g of shSequence) {
    if (distinct[distinct.length - 1] !== g) distinct.push(g);
  }

  const EXPECTED_DISTINCT_ORDER = ['rewrite-bash', 'contract', 'init'];
  assert.deepEqual(
    distinct,
    EXPECTED_DISTINCT_ORDER,
    `PreToolUse Bash .sh chain order mismatch.\nExpected: ${EXPECTED_DISTINCT_ORDER.join(' → ')}\nActual:   ${distinct.join(' → ')}`,
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
