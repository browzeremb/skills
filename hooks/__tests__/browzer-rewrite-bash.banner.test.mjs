// Unit tests for R-13: banner suppression in browzer-rewrite-bash.mjs.
//
// AC-13: with BROWZER_LLM=1 already set in the hook's environment, the hook
// produces NO additionalContext. Without it (or with BROWZER_LLM=0), the
// banner still appears.
//
// Strategy: spawn the guard with controlled env, parse stdout JSON.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '..', 'guards', 'browzer-rewrite-bash.mjs');

// Temporary workspace — the guard reads .browzer/config.json to decide if
// it's in a Browzer workspace. We fake that here.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brz-banner-'));

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function freshWorkspace(label) {
  const ws = path.join(TMP_ROOT, label);
  fs.mkdirSync(path.join(ws, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.browzer', 'config.json'),
    JSON.stringify({ workspaceId: 'test', gateway: 'https://e' }),
  );
  const home = path.join(TMP_ROOT, `home-${label}`);
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(path.join(home, '.browzer', 'config.json'), '{}');
  return { ws, home };
}

function runGuard(payload, envOverrides = {}, cwdOverride) {
  return new Promise((resolve) => {
    const label = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ws, home } = freshWorkspace(label);
    const env = {
      ...process.env,
      HOME: home,
      // Unset BROWZER_LLM by default; caller can override.
      BROWZER_LLM: '',
      // R-10: assign a unique CLAUDE_SESSION_ID per invocation so sentinel
      // files don't bleed across test cases sharing the same process.ppid.
      // Also use the test's TMP_ROOT as TMPDIR so sentinels land in a
      // controlled, cleaned-up location.
      CLAUDE_SESSION_ID: label,
      TMPDIR: TMP_ROOT,
      // Clear CLAUDE_PROJECT_DIR so the sentinel key always uses CLAUDE_SESSION_ID.
      CLAUDE_PROJECT_DIR: '',
      ...envOverrides,
    };
    const child = spawn(process.execPath, [GUARD], {
      env,
      cwd: cwdOverride ?? ws,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function makeBrowzerPayload(command) {
  return {
    tool_name: 'Bash',
    tool_input: { command },
  };
}

// ================================================================
describe('browzer-rewrite-bash: BROWZER_LLM banner suppression (R-13)', () => {
  // --- 1. BROWZER_LLM unset → banner appears ---
  it('emits additionalContext banner when BROWZER_LLM is not set', async () => {
    const r = await runGuard(makeBrowzerPayload('browzer explore "foo"'), {
      BROWZER_LLM: '',
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx === 'string' && ctx.length > 0,
      'expected banner in additionalContext',
    );
    assert.match(ctx, /BROWZER_LLM=1/, 'banner should mention BROWZER_LLM=1');
  });

  // --- 2. BROWZER_LLM=0 → banner appears (falsy value, still show the banner) ---
  it('emits additionalContext banner when BROWZER_LLM=0 (falsy, not truthy)', async () => {
    const r = await runGuard(makeBrowzerPayload('browzer explore "foo"'), {
      BROWZER_LLM: '0',
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(
      typeof ctx === 'string' && ctx.length > 0,
      'expected banner when BROWZER_LLM=0',
    );
  });

  // --- 3. BROWZER_LLM=1 → NO banner (AC-13 core assertion) ---
  it('AC-13: emits NO additionalContext when BROWZER_LLM=1 already in env', async () => {
    const r = await runGuard(makeBrowzerPayload('browzer explore "foo"'), {
      BROWZER_LLM: '1',
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.equal(
      ctx,
      undefined,
      `expected no additionalContext when BROWZER_LLM=1, got: ${JSON.stringify(ctx)}`,
    );
  });

  // --- 4. BROWZER_LLM=1 → rewrite still happens (prefix is still injected) ---
  it('still injects BROWZER_LLM=1 prefix into the command even when env already set', async () => {
    const r = await runGuard(makeBrowzerPayload('browzer explore "test"'), {
      BROWZER_LLM: '1',
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const newCmd = parsed?.hookSpecificOutput?.updatedInput?.command;
    assert.ok(typeof newCmd === 'string', 'expected updatedInput.command');
    assert.match(
      newCmd,
      /^BROWZER_LLM=1\s/,
      'command must still be prefixed with BROWZER_LLM=1',
    );
  });

  // --- 5. BROWZER_LLM set to any truthy string → banner suppressed ---
  it('suppresses banner for any truthy BROWZER_LLM value (e.g. "true")', async () => {
    const r = await runGuard(makeBrowzerPayload('browzer search "query"'), {
      BROWZER_LLM: 'true',
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.equal(
      ctx,
      undefined,
      'expected no banner for truthy BROWZER_LLM=true',
    );
  });

  // --- 6. Mixed case: parent env BROWZER_LLM=1 + command-inline BROWZER_LLM=0 ---
  // The `alreadyHasEnv` branch fires (command already contains BROWZER_LLM=)
  // so the hook exits without rewriting — no banner and no re-prefix.
  it('mixed case: BROWZER_LLM=1 in env + BROWZER_LLM=0 inline → alreadyHasEnv branch, no banner, no re-prefix', async () => {
    const cmd = 'BROWZER_LLM=0 browzer explore "mixed"';
    const r = await runGuard(makeBrowzerPayload(cmd), { BROWZER_LLM: '1' });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    // alreadyHasEnv guard fires before banner logic → stdout is empty (silent exit 0)
    assert.equal(
      r.stdout.trim(),
      '',
      'expected no JSON output (silent exit) when command already contains BROWZER_LLM=',
    );
  });

  // --- FR-10 sticky-session: 3 sequential invocations with shared sessionId ---
  // The browzer-rewrite-bash.mjs banner suppression is environment-based (R-13):
  // it checks process.env.BROWZER_LLM, not a per-session file. Each hook
  // invocation is a new subprocess, so env does NOT persist across calls unless
  // the caller explicitly carries BROWZER_LLM=1 in subsequent invocations.
  // Simulating "same session" means: first call has BROWZER_LLM='', subsequent
  // calls have BROWZER_LLM='1' (as the agent would after seeing the banner).
  // There is NO file-based per-session emission tracking in the hook (FR-10 was
  // a "could" requirement — not implemented). The test documents actual behavior.
  it('FR-10 sticky-session: banner appears only on the first invocation (env-based dedup)', async () => {
    // Turn 1: BROWZER_LLM not set → banner must appear.
    const r1 = await runGuard(makeBrowzerPayload('browzer explore "q1"'), {
      BROWZER_LLM: '',
    });
    assert.equal(r1.code, 0, `turn1 stderr: ${r1.stderr}`);
    const ctx1 =
      JSON.parse(r1.stdout)?.hookSpecificOutput?.additionalContext ?? null;
    assert.ok(
      typeof ctx1 === 'string' && ctx1.length > 0,
      'turn 1: expected banner in additionalContext',
    );

    // Turn 2: BROWZER_LLM=1 now in env (as the agent carries it after turn 1) → no banner.
    const r2 = await runGuard(makeBrowzerPayload('browzer explore "q2"'), {
      BROWZER_LLM: '1',
    });
    assert.equal(r2.code, 0, `turn2 stderr: ${r2.stderr}`);
    const ctx2 =
      JSON.parse(r2.stdout)?.hookSpecificOutput?.additionalContext ?? null;
    assert.equal(
      ctx2,
      null,
      `turn 2: expected no banner when BROWZER_LLM=1, got: ${JSON.stringify(ctx2)}`,
    );

    // Turn 3: same env → banner still suppressed.
    const r3 = await runGuard(makeBrowzerPayload('browzer explore "q3"'), {
      BROWZER_LLM: '1',
    });
    assert.equal(r3.code, 0, `turn3 stderr: ${r3.stderr}`);
    const ctx3 =
      JSON.parse(r3.stdout)?.hookSpecificOutput?.additionalContext ?? null;
    assert.equal(
      ctx3,
      null,
      `turn 3: expected no banner when BROWZER_LLM=1, got: ${JSON.stringify(ctx3)}`,
    );
  });

  // --- 7. Non-browzer command → hook passes through, no banner ---
  it('passes through non-browzer commands without banner', async () => {
    const r = await runGuard(makeBrowzerPayload('echo hello'), {
      BROWZER_LLM: '',
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    // Non-browzer commands exit 0 silently (possibly with rewrite for large files,
    // but echo has no file arg, so stdout should be empty).
    // The key invariant: no banner for non-browzer commands.
    if (r.stdout) {
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        parsed = null;
      }
      if (parsed) {
        const ctx = parsed?.hookSpecificOutput?.additionalContext;
        if (ctx)
          assert.doesNotMatch(
            ctx,
            /BROWZER_LLM/,
            'no BROWZER_LLM banner on non-browzer cmd',
          );
      }
    }
  });
});
