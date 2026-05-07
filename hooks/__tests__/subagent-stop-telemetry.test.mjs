// Tests for hooks/guards/subagent-stop-telemetry.mjs.
//
// Strategy: spawn the guard as a subprocess with CLAUDE_PLUGIN_DATA pointing
// at a tmp dir (so we can read back the produced JSONL), pipe a fake
// SubagentStop payload on stdin, and assert the resulting record schema.
//
// The contract under test (RETRO §15.1 option 2): when the harness payload
// omits durationMs / toolUseCount / inputTokens / outputTokens, the hook MUST
// drop those keys entirely — not emit them as JSON null.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const guardPath = path.join(
  import.meta.dirname,
  '..',
  'guards',
  'subagent-stop-telemetry.mjs',
);

function runGuard(payload, envOverrides = {}) {
  return new Promise((resolve) => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-stop-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-home-'));
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', guardPath],
      {
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_PLUGIN_DATA: dataRoot,
          BROWZER_HOOK: '',
          BROWZER_HOOK_DISABLE: '',
          ...envOverrides,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => {
      const today = new Date().toISOString().slice(0, 10);
      const jsonlPath = path.join(
        dataRoot,
        'telemetry',
        `subagent-${today}.jsonl`,
      );
      const exists = fs.existsSync(jsonlPath);
      const content = exists ? fs.readFileSync(jsonlPath, 'utf8') : '';
      resolve({ code, stderr, jsonlPath, exists, content });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('subagent-stop-telemetry', () => {
  it('drops absent optional fields rather than emitting them as null', async () => {
    const { code, content, exists } = await runGuard({
      session_id: 'sess-1',
      agent_id: 'a-1',
      agent_type: 'general-purpose',
      cwd: '/tmp/x',
      // No duration_ms / tool_use_count / input_tokens / output_tokens.
    });
    assert.equal(code, 0);
    assert.equal(exists, true);
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    // Always-available fields present.
    assert.equal(rec.sessionId, 'sess-1');
    assert.equal(rec.agentId, 'a-1');
    assert.equal(rec.agentType, 'general-purpose');
    assert.equal(rec.cwd, '/tmp/x');
    assert.ok(typeof rec.ts === 'string' && rec.ts.length > 0);
    // Optional numeric fields: keys MUST NOT exist (not null).
    for (const key of [
      'durationMs',
      'toolUseCount',
      'inputTokens',
      'outputTokens',
    ]) {
      assert.equal(
        Object.hasOwn(rec, key),
        false,
        `${key} must be absent when harness did not provide it (no null masking)`,
      );
    }
  });

  it('emits optional numeric fields when harness DOES provide them', async () => {
    const { code, content } = await runGuard({
      session_id: 'sess-2',
      agent_id: 'a-2',
      agent_type: 'specialist',
      cwd: '/tmp/y',
      duration_ms: 1234,
      tool_use_count: 7,
      input_tokens: 9001,
      output_tokens: 42,
    });
    assert.equal(code, 0);
    const rec = JSON.parse(content.trim().split('\n').filter(Boolean)[0]);
    assert.equal(rec.durationMs, 1234);
    assert.equal(rec.toolUseCount, 7);
    assert.equal(rec.inputTokens, 9001);
    assert.equal(rec.outputTokens, 42);
  });

  it('drops non-numeric values for optional fields (e.g. explicit null)', async () => {
    const { code, content } = await runGuard({
      session_id: 'sess-3',
      agent_id: 'a-3',
      agent_type: 'specialist',
      cwd: '/tmp/z',
      duration_ms: null,
      tool_use_count: 'NaN',
      input_tokens: undefined,
      output_tokens: false,
    });
    assert.equal(code, 0);
    const rec = JSON.parse(content.trim().split('\n').filter(Boolean)[0]);
    for (const key of [
      'durationMs',
      'toolUseCount',
      'inputTokens',
      'outputTokens',
    ]) {
      assert.equal(
        Object.hasOwn(rec, key),
        false,
        `${key} must be absent when not a finite number`,
      );
    }
  });

  it('handles partial payload — only durationMs provided (F-16)', async () => {
    // Most likely transitional state: harness starts emitting one of the
    // four optional numeric fields before the rest. The hook MUST keep the
    // single provided field and drop the absent siblings (not null-mask).
    const { code, content } = await runGuard({
      session_id: 'sess-4',
      agent_id: 'a-4',
      agent_type: 'specialist',
      cwd: '/tmp/p',
      duration_ms: 500,
      // tool_use_count / input_tokens / output_tokens absent.
    });
    assert.equal(code, 0);
    const rec = JSON.parse(content.trim().split('\n').filter(Boolean)[0]);
    assert.equal(rec.durationMs, 500);
    for (const key of ['toolUseCount', 'inputTokens', 'outputTokens']) {
      assert.equal(
        Object.hasOwn(rec, key),
        false,
        `${key} must be absent when harness did not provide it`,
      );
    }
  });

  it('produces a JSONL line that parses as a single JSON object', async () => {
    const { content } = await runGuard({
      session_id: 's',
      agent_id: 'a',
      agent_type: 't',
      cwd: '/c',
    });
    assert.ok(content.endsWith('\n'), 'must be newline-terminated');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed, 'object');
      assert.notEqual(parsed, null);
    }
  });
});
