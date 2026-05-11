// Tests for hooks/guards/user-prompt-browzer-search.mjs — AC-3 coverage.
//
// Strategy: spawn the guard as a child process with stdin JSON, assert stdout.
// A temporary workspace CWD is used for each test so exclude-file reads are
// predictable. No network or daemon calls are required.
//
// Three cases:
//   (a) is_assistant_turn=true  + 'react' keyword + action verb
//       → stdout EMPTY (FR-3 unconditional suppression)
//   (b) is_assistant_turn=false + 'react' keyword + action verb
//       → guard fires (search suggestion emitted to stdout)
//   (c) is_assistant_turn absent + 'react' keyword + action verb
//       → guard fires (R-2 fail-open: treat absent as falsey)

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

const guardPath = path.join(
  import.meta.dirname,
  '..',
  'guards',
  'user-prompt-browzer-search.mjs',
);

// A prompt that reliably triggers the guard: contains a DEFAULT_VOCAB term
// ('react') plus an action verb ('implement') so both checks pass.
const TRIGGER_PROMPT =
  'implement the new react component with the dark theme toggle';

/**
 * Spawn the guard with the given hook input, using `cwd` as the working
 * directory (controls which .browzer/search-triggers.exclude.json is read).
 * Returns { code, stdout, stderr }.
 */
function runGuard(hookInput, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [guardPath], {
      cwd,
      env: {
        ...process.env,
        // Disable session-level dedup so tests never suppress each other.
        // Each test uses a unique session_id, but belt-and-suspenders.
        BROWZER_HOOK: 'on',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(hookInput));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Create a minimal temp workspace. The guard only needs `cwd` to be a
 * directory so the exclude-file read path is deterministic. No .browzer dir
 * is created, so the exclude file falls through to the `catch` branch
 * (file is optional) and does not interfere.
 */
function makeTmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'search-guard-test-'));
}

describe('user-prompt-browzer-search guard — AC-3 is_assistant_turn', () => {
  it('(a) is_assistant_turn=true + react prompt → stdout empty (suppression active)', async () => {
    const cwd = makeTmpWorkspace();
    const sessionId = `ac3-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await runGuard(
      {
        prompt: TRIGGER_PROMPT,
        is_assistant_turn: true,
        session_id: sessionId,
        cwd,
      },
      cwd,
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(
      result.stdout,
      '',
      `Expected empty stdout when is_assistant_turn=true, got: ${result.stdout}`,
    );
  });

  it('(b) is_assistant_turn=false + react prompt → guard fires (search suggestion emitted)', async () => {
    const cwd = makeTmpWorkspace();
    const sessionId = `ac3-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await runGuard(
      {
        prompt: TRIGGER_PROMPT,
        is_assistant_turn: false,
        session_id: sessionId,
        cwd,
      },
      cwd,
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.length > 0,
      `Expected non-empty stdout when is_assistant_turn=false, got empty`,
    );
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed?.hookSpecificOutput?.additionalContext?.includes('browzer search'),
      `Expected search suggestion in additionalContext, got: ${JSON.stringify(parsed)}`,
    );
  });

  it('(c) is_assistant_turn absent → guard fires (R-2 fail-open: absent treated as falsey)', async () => {
    const cwd = makeTmpWorkspace();
    const sessionId = `ac3-c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Omit is_assistant_turn entirely — should behave like false.
    const result = await runGuard(
      {
        prompt: TRIGGER_PROMPT,
        session_id: sessionId,
        cwd,
      },
      cwd,
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.length > 0,
      `Expected non-empty stdout when is_assistant_turn is absent, got empty`,
    );
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed?.hookSpecificOutput?.additionalContext?.includes('browzer search'),
      `Expected search suggestion in additionalContext, got: ${JSON.stringify(parsed)}`,
    );
  });
});
