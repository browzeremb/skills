#!/usr/bin/env node
//
// render-deps.test.mjs — unit tests for the Mermaid renderer.
//
// Run via: node --test packages/skills/skills/dependency-graph/scripts/render-deps.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, 'render-deps.mjs');
const FIXTURES = join(__dirname, '__fixtures__');

function run(args) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'render-deps-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('render-deps', () => {
  it('emits a graph LR with center node + forward and reverse edges', () => {
    const out = run(['--input', join(FIXTURES, 'full-deps.json')]);
    assert.match(out, /^graph LR$/m);
    // Center node uses bold label and the `center` class.
    assert.match(out, /\["\*\*src\/lib\/logger\.ts\*\*"\]:::center/);
    // Forward edge: center → import
    assert.match(out, /n\d+ --> n\d+/);
    // All paths appear as labels
    for (const path of [
      'src/lib/format.ts',
      'src/lib/sink.ts',
      'src/server.ts',
      'src/api/users.ts',
      'src/api/posts.ts',
    ]) {
      assert.ok(out.includes(`"${path}"`), `expected ${path} in output`);
    }
    // Style def line present
    assert.match(out, /classDef center/);
  });

  it('dedupes repeated paths into a single node and a single edge', () => {
    const out = run(['--input', join(FIXTURES, 'reverse-only-deps.json')]);
    // The fixture has src/routes/users.ts twice — must collapse to one node
    // line and one edge into the center, otherwise the diagram clutters with
    // parallel arrows for what is semantically a single import relationship.
    const usersNodeMatches = out.match(/\["src\/routes\/users\.ts"\]/g) || [];
    assert.equal(
      usersNodeMatches.length,
      1,
      'duplicate paths must collapse to one node',
    );
    const arrowsToCenter = (out.match(/--> n0/g) || []).length;
    assert.equal(
      arrowsToCenter,
      2,
      'two unique importers → two edges into center, not three',
    );
  });

  it('writes to --output and prints a summary line', () => {
    withTmp((dir) => {
      const target = join(dir, 'deps.mmd');
      const stdout = run([
        '--input',
        join(FIXTURES, 'full-deps.json'),
        '--output',
        target,
      ]);
      assert.match(stdout, /^render-deps: wrote .+ \(\d+ nodes, \d+ edges\)$/m);
      const content = readFileSync(target, 'utf8');
      assert.match(content, /^graph LR$/m);
    });
  });

  it('exits with 1 on missing --input', () => {
    let threw = false;
    try {
      execFileSync('node', [SCRIPT], { stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw);
  });

  it('exits with 2 when input is missing required "file" key', () => {
    withTmp((dir) => {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ imports: [], importedBy: [] }));
      let threw = false;
      try {
        execFileSync('node', [SCRIPT, '--input', bad], { stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 2);
      }
      assert.ok(threw);
    });
  });

  it('exits with 2 on malformed JSON', () => {
    withTmp((dir) => {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{not json');
      let threw = false;
      try {
        execFileSync('node', [SCRIPT, '--input', bad], { stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 2);
      }
      assert.ok(threw);
    });
  });
});
