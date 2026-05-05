#!/usr/bin/env node
//
// backfill-pending-sha.test.mjs — unit tests for the CHANGELOG SHA backfill.
//
// Run via: node --test packages/skills/skills/commit/scripts/backfill-pending-sha.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, 'backfill-pending-sha.mjs');
const FIXTURE = join(__dirname, '__fixtures__', 'changelog-with-pending.md');

function runScript(args, opts = {}) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', ...opts });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('backfill-pending-sha', () => {
  it('rewrites pending placeholder preserving trailing prose', () => {
    withTmp((dir) => {
      const target = join(dir, 'CHANGELOG.md');
      copyFileSync(FIXTURE, target);
      const out = runScript([
        '--file',
        target,
        '--sha',
        'abcd1234',
        '--mode',
        'apply',
      ]);
      assert.match(out, /2 edit\(s\) applied/);
      const content = readFileSync(target, 'utf8');
      // First placeholder: trailing prose "— implementing branch \`main\`." preserved.
      assert.match(
        content,
        /\*\*Commits\*\*: `abcd1234`\. — implementing branch `main`\./,
      );
      // Second placeholder: bare pending without period gets the period appended.
      assert.match(content, /\*\*Commits\*\*: `abcd1234`\.$/m);
      // Non-matching line ("see commit pending review") is left alone.
      assert.match(content, /see commit pending review/);
    });
  });

  it('dry-run reports counts without writing', () => {
    withTmp((dir) => {
      const target = join(dir, 'CHANGELOG.md');
      copyFileSync(FIXTURE, target);
      const before = readFileSync(target, 'utf8');
      const out = runScript([
        '--file',
        target,
        '--sha',
        'abcd1234',
        '--mode',
        'dry-run',
      ]);
      assert.match(out, /2 edit\(s\) staged/);
      const after = readFileSync(target, 'utf8');
      assert.equal(after, before, 'dry-run must not modify the file');
    });
  });

  it('is idempotent — second apply produces zero edits', () => {
    withTmp((dir) => {
      const target = join(dir, 'CHANGELOG.md');
      copyFileSync(FIXTURE, target);
      runScript(['--file', target, '--sha', 'abcd1234', '--mode', 'apply']);
      const out2 = runScript([
        '--file',
        target,
        '--sha',
        'abcd1234',
        '--mode',
        'apply',
      ]);
      assert.match(out2, /0 edit\(s\) applied/);
    });
  });

  it('exits with 1 on usage error', () => {
    let threw = false;
    try {
      execFileSync('node', [SCRIPT, '--file', '/tmp/x'], { stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw, 'missing --sha should exit non-zero');
  });

  it('exits with 1 on unknown --mode', () => {
    let threw = false;
    try {
      execFileSync(
        'node',
        [SCRIPT, '--file', '/tmp/x', '--sha', 'abcd', '--mode', 'wat'],
        {
          stdio: 'pipe',
        },
      );
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw);
  });

  it('exits with 2 when input file missing', () => {
    let threw = false;
    try {
      execFileSync(
        'node',
        [
          SCRIPT,
          '--file',
          '/tmp/does-not-exist-xyz',
          '--sha',
          'abcd',
          '--mode',
          'apply',
        ],
        { stdio: 'pipe' },
      );
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
    }
    assert.ok(threw);
  });

  it('preserves indentation and list markers', () => {
    withTmp((dir) => {
      const target = join(dir, 'a.md');
      writeFileSync(
        target,
        ['  - **Commits**: pending', '    * **Commits**: pending — extra'].join(
          '\n',
        ),
      );
      runScript(['--file', target, '--sha', 'deadbeef', '--mode', 'apply']);
      const out = readFileSync(target, 'utf8');
      assert.match(out, /^  - \*\*Commits\*\*: `deadbeef`\.$/m);
      assert.match(out, /^    \* \*\*Commits\*\*: `deadbeef`\. — extra$/m);
    });
  });
});
