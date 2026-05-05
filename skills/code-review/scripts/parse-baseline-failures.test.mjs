#!/usr/bin/env node
//
// parse-baseline-failures.test.mjs — unit tests for the baseline-failure parser.
//
// Run via: node --test packages/skills/skills/code-review/scripts/parse-baseline-failures.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, 'parse-baseline-failures.mjs');
const FIXTURES = join(__dirname, '__fixtures__');

function runJSON(args) {
  const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

describe('parse-baseline-failures', () => {
  it('parses vitest JSON-reporter output and ignores passed tests', () => {
    const failures = runJSON([
      '--tool',
      'vitest',
      '--log',
      join(FIXTURES, 'vitest-failures.json'),
    ]);
    assert.equal(failures.length, 2);
    const fooFail = failures.find((f) => f.name === 'foo > does the thing');
    assert.ok(fooFail, 'expected foo failure');
    assert.equal(fooFail.tool, 'vitest');
    assert.equal(fooFail.file, '/repo/src/__tests__/foo.test.ts');
    assert.match(fooFail.message, /AssertionError/);
    assert.match(fooFail.message, /to equal 2/);
    // newlines collapsed to single line for JSON-friendliness
    assert.ok(!fooFail.message.includes('\n'));
  });

  it('parses pytest --report-log NDJSON and skips non-call phases', () => {
    const failures = runJSON([
      '--tool',
      'pytest',
      '--log',
      join(FIXTURES, 'pytest-failures.jsonl'),
    ]);
    assert.equal(
      failures.length,
      1,
      'setup-phase failure must not double-count',
    );
    assert.equal(failures[0].name, 'tests/test_foo.py::test_thing');
    assert.equal(failures[0].file, 'tests/test_foo.py');
    assert.match(failures[0].message, /AssertionError/);
  });

  it('parses go test -json and groups output lines per failed test', () => {
    const failures = runJSON([
      '--tool',
      'go-test',
      '--log',
      join(FIXTURES, 'go-test-failures.jsonl'),
    ]);
    assert.equal(failures.length, 1, 'only TestThing failed');
    assert.equal(failures[0].name, 'TestThing');
    assert.equal(failures[0].package, 'github.com/example/foo');
    assert.match(failures[0].message, /FAIL: TestThing/);
    assert.match(failures[0].message, /expected 1 got 2/);
  });

  it('exits with 1 on unknown --tool', () => {
    let threw = false;
    try {
      execFileSync('node', [SCRIPT, '--tool', 'mocha', '--log', '/tmp/x'], {
        stdio: 'pipe',
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw);
  });

  it('exits with 1 when args missing', () => {
    let threw = false;
    try {
      execFileSync('node', [SCRIPT], { stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw);
  });

  it('exits with 2 when log file missing', () => {
    let threw = false;
    try {
      execFileSync(
        'node',
        [SCRIPT, '--tool', 'vitest', '--log', '/tmp/does-not-exist-xyz.json'],
        { stdio: 'pipe' },
      );
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
    }
    assert.ok(threw);
  });
});
