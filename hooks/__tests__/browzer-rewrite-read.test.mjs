// Tests for hooks/guards/browzer-rewrite-read.mjs — large-Read summary
// injection at the 40_960-byte boundary.
//
// Strategy: spawn the guard as a child process against tmp files of three
// sizes (small, exactly threshold, threshold+1) and assert exit code +
// stdout shape.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'guards', 'browzer-rewrite-read.mjs');

function makeWorkspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-read-home-'));
  fs.mkdirSync(path.join(home, '.browzer'), { recursive: true });
  fs.writeFileSync(path.join(home, '.browzer', 'credentials'), '{}');
  fs.writeFileSync(
    path.join(home, '.browzer', 'config.json'),
    JSON.stringify({ workspaceId: 'test', gateway: 'https://e' }),
  );

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-read-cwd-'));
  fs.mkdirSync(path.join(cwd, '.browzer'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.browzer', 'config.json'),
    JSON.stringify({ workspaceId: 'test', gateway: 'https://e' }),
  );
  return { home, cwd };
}

function writeFileOfSize(dir, name, bytes) {
  const filePath = path.join(dir, name);
  // Use 80-byte lines (79 'a' + newline) so the embedded head stays bounded
  // and total payload size still equals `bytes`.
  const line = `${'a'.repeat(79)}\n`;
  const full = line.repeat(Math.ceil(bytes / 80)).slice(0, bytes);
  fs.writeFileSync(filePath, full, 'utf8');
  return filePath;
}

function runHook(filePath, workspace) {
  const payload = {
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    session_id: 'test-session',
  };
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: workspace.cwd,
    env: { ...process.env, HOME: workspace.home },
    timeout: 10_000,
  });
}

describe('browzer-rewrite-read large-Read summary', () => {
  it('passes through silently for small files (< threshold)', () => {
    const ws = makeWorkspace();
    const small = writeFileOfSize(ws.cwd, 'tiny.ts', 1024);
    const res = runHook(small, ws);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(
      res.stdout.trim(),
      '',
      'small file should not emit hookSpecificOutput',
    );
  });

  it('passes through at the exact threshold (40_960 bytes)', () => {
    const ws = makeWorkspace();
    const boundary = writeFileOfSize(ws.cwd, 'boundary.ts', 40960);
    const res = runHook(boundary, ws);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(
      res.stdout.trim(),
      '',
      '40_960-byte file should be considered "not large"; advisory must not fire',
    );
  });

  it('emits advisory-only (no head) for files between LARGE and INJECTION threshold (40_961–163_840 bytes)', () => {
    // F-028: files between 40KB and 160KB get an advisory WITHOUT compressed
    // head injection — the head's token cost approaches the avoided full-read
    // for files in this band. Head injection lands only when size > 4 * LARGE_FILE_THRESHOLD (163840).
    const ws = makeWorkspace();
    const mid = writeFileOfSize(ws.cwd, 'mid.ts', 60000);
    const res = runHook(mid, ws);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.notEqual(
      res.stdout.trim(),
      '',
      'mid-range file must still emit an advisory',
    );
    const parsed = JSON.parse(res.stdout);
    const hso = parsed.hookSpecificOutput;
    assert.ok(hso, 'hookSpecificOutput missing');
    assert.equal(hso.permissionDecision, 'allow');
    // Mid-range advisory: summary carries path + byteCount but NOT head.
    const blockMatch = hso.additionalContext.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(blockMatch, 'summary block missing');
    const summary = JSON.parse(blockMatch[1]);
    assert.equal(summary.path, mid);
    assert.equal(summary.byteCount, 60000);
    assert.equal(
      summary.head,
      undefined,
      'head must be omitted in mid-range advisory',
    );
  });

  it('injects compressed head summary for files above injection threshold (163_841 bytes)', () => {
    // F-010/F-028: head uses a 5KB bounded read capped at 60 lines; head
    // injection lands only when size > 4 * LARGE_FILE_THRESHOLD (163840 bytes).
    const ws = makeWorkspace();
    const big = writeFileOfSize(ws.cwd, 'big.ts', 163841);
    const res = runHook(big, ws);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.notEqual(res.stdout.trim(), '');

    const parsed = JSON.parse(res.stdout);
    const hso = parsed.hookSpecificOutput;
    assert.ok(hso, 'hookSpecificOutput missing');
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'allow');
    // The summary block is embedded as a fenced JSON code block.
    const blockMatch = hso.additionalContext.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(blockMatch, 'summary JSON block missing from additionalContext');
    const summary = JSON.parse(blockMatch[1]);
    assert.equal(summary.path, big);
    assert.equal(summary.byteCount, 163841);
    assert.equal(typeof summary.head, 'string');
    assert.ok(summary.head.length > 0, 'head must be non-empty for large file');
  });
});
