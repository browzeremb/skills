// Unit tests for browzer-session-summary.mjs Stop hook behaviour.
//
// T-1: stop_hook_active=false + real-shape gain JSON → output contains
//      "[browzer] Session" and reflects savedTotal/topWasted from the CLI.
// T-2: stop_hook_active=true → no additionalContext, exit 0.
// T-3: test seam is gated by NODE_ENV=test — without it, BROWZER_GAIN_OUTPUT
//      MUST NOT override telemetry.
// T-4: production-shaped invocation without seam + browzer not on PATH →
//      exits 0 silently (no output) — proves the prod fallback path.
// T-5: malformed JSON via the test seam → safe fallback string emitted.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const HOOK = new URL('./browzer-session-summary.mjs', import.meta.url).pathname;

// Run the hook with a given stdin payload and optional env overrides.
// Returns { stdout, exitCode }.
function runHook(stdinPayload, extraEnv = {}) {
  const input = JSON.stringify(stdinPayload);
  // Default to an empty PATH so the hook cannot accidentally locate a real
  // `browzer` binary installed on the developer machine. Tests that need
  // the binary must override PATH explicitly.
  const baseEnv = {
    ...process.env,
    PATH: '',
    BROWZER_GAIN_OUTPUT: undefined,
    NODE_ENV: undefined,
  };
  // Drop undefined keys so the child inherits a clean env slice.
  for (const k of Object.keys(baseEnv)) {
    if (baseEnv[k] === undefined) delete baseEnv[k];
  }
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...baseEnv, ...extraEnv },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

// T-1: non-active stop + BROWZER_GAIN_OUTPUT seam (under NODE_ENV=test)
// with the real CLI JSON shape — output must contain "[browzer] Session"
// and reflect the savedTotal + topWasted fields the Go renderer emits.
test('T-1: emits [browzer] Session context for real CLI JSON shape', () => {
  const gainPayload = JSON.stringify({
    since: '1h',
    adoption: 3.5,
    savedTotal: 42000,
    wastedTotal: 12000,
    topWasted: {
      source: 'wasted-rg',
      command: 'wasted-rg',
      // The CLI emits SavedTokens as a negative magnitude for wasted-* buckets.
      savedTokens: -8000,
      suggestion: 'browzer explore "<query>" --json --save /tmp/explore.json',
    },
    byPattern: {
      savedFromCli: 30000,
      savedFromHooks: 12000,
      wasted: 12000,
      other: 0,
    },
  });

  const { stdout, exitCode } = runHook(
    { stop_hook_active: false, session_id: 'test-t1' },
    { NODE_ENV: 'test', BROWZER_GAIN_OUTPUT: gainPayload },
  );

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.ok(stdout.trim().length > 0, 'hook must produce output');

  const parsed = JSON.parse(stdout.trim());
  assert.ok(
    typeof parsed.additionalContext === 'string',
    'output must have additionalContext string',
  );
  assert.match(
    parsed.additionalContext,
    /\[browzer\] Session/,
    'additionalContext must contain "[browzer] Session"',
  );
  assert.match(
    parsed.additionalContext,
    /42k tokens/,
    'saved tokens should appear rounded to k',
  );
  assert.match(
    parsed.additionalContext,
    /adoption 3\.5x/,
    'adoption ratio should appear',
  );
  assert.match(
    parsed.additionalContext,
    /wasted-rg/,
    'top wasted source should appear',
  );
  assert.match(
    parsed.additionalContext,
    /8k/,
    'top wasted magnitude should appear (absolute value)',
  );
});

// T-2: stop_hook_active=true → hook exits 0 and emits no additionalContext.
test('T-2: exits 0 silently when stop_hook_active is true', () => {
  const { stdout, exitCode } = runHook({
    stop_hook_active: true,
    session_id: 'test-t2',
  });

  assert.equal(exitCode, 0, 'hook must exit 0');
  // No additionalContext should be emitted.
  if (stdout.trim().length > 0) {
    const parsed = JSON.parse(stdout.trim());
    assert.ok(
      !('additionalContext' in parsed),
      'must not emit additionalContext when stop_hook_active=true',
    );
  }
});

// T-3: WITHOUT NODE_ENV=test, BROWZER_GAIN_OUTPUT must be ignored — the test
// seam is production-safe. With PATH stripped the hook cannot spawn browzer,
// so it must exit 0 silently rather than honor the env-var payload.
test('T-3: BROWZER_GAIN_OUTPUT is ignored outside NODE_ENV=test', () => {
  const gainPayload = JSON.stringify({
    savedTotal: 99999,
    wastedTotal: 0,
    adoption: null,
    topWasted: null,
  });

  const { stdout, exitCode } = runHook(
    { stop_hook_active: false, session_id: 'test-t3' },
    { BROWZER_GAIN_OUTPUT: gainPayload }, // no NODE_ENV=test
  );

  assert.equal(exitCode, 0, 'hook must exit 0');
  // The hook must not have used the env-var payload. Output is either empty
  // (browzer spawn failed under empty PATH) or, if some other future codepath
  // emits, it MUST NOT contain the seam's 99999 marker.
  assert.ok(
    !stdout.includes('99k tokens') && !stdout.includes('99999'),
    `BROWZER_GAIN_OUTPUT leaked into production output: ${stdout}`,
  );
});

// T-4: production codepath — no test seam, no browzer on PATH → exit 0
// silently, NO output. Proves the hook degrades gracefully when the CLI
// cannot be located.
test('T-4: silent exit when browzer is not on PATH and no test seam set', () => {
  const { stdout, exitCode } = runHook({
    stop_hook_active: false,
    session_id: 'test-t4',
  });

  assert.equal(exitCode, 0, 'hook must exit 0 even when browzer is absent');
  assert.equal(
    stdout.trim().length,
    0,
    `hook must produce no output on spawn failure, got: ${stdout}`,
  );
});

// T-5: malformed JSON via the test seam → safe fallback string emitted.
test('T-5: emits fallback context when gain JSON is malformed', () => {
  const { stdout, exitCode } = runHook(
    { stop_hook_active: false, session_id: 'test-t5' },
    { NODE_ENV: 'test', BROWZER_GAIN_OUTPUT: 'not-valid-json{' },
  );

  assert.equal(exitCode, 0, 'hook must exit 0');
  const parsed = JSON.parse(stdout.trim());
  assert.match(
    parsed.additionalContext,
    /Session summary unavailable/,
    'fallback string must be emitted for non-JSON gain output',
  );
});
