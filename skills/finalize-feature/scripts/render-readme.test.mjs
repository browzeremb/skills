// Unit tests for the readers/helpers in render-readme.mjs.
//
// Focus is on the parsers that broke during the 2026-05-15 renderer
// extension — every assertion here is a regression guard for a specific bug
// the live `feat-20260514-hooks-shell-port` smoke surfaced.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  extractH3Bullets,
  extractYamlBlock,
  parseFm,
  readCodeReview,
  readDocPatches,
  readFixes,
  readTests,
} from './render-readme.mjs';

// Build a temp staging dir, write the files we need for one test, return the
// staging path. Caller is responsible for cleanup.
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'render-readme-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

test('extractYamlBlock: terminates at next top-level YAML key', () => {
  const fm = [
    'foo: 1',
    'findings:',
    '  - id: F-001',
    '  - id: F-002',
    '  - id: F-003',
    'totalFindings: 3',
    'next: x',
  ].join('\n');
  const body = extractYamlBlock(fm, 'findings');
  assert.ok(body.includes('F-001'));
  assert.ok(body.includes('F-003'));
  assert.ok(!body.includes('totalFindings'));
});

test('extractYamlBlock: terminates at end-of-string when no next key', () => {
  const fm = ['findings:', '  - id: F-001', '  - id: F-002'].join('\n');
  const body = extractYamlBlock(fm, 'findings');
  assert.ok(body.includes('F-001'));
  assert.ok(body.includes('F-002'));
});

test('extractYamlBlock: regression — does NOT terminate at literal `Z`', () => {
  // The pre-fix regex used `\Z` which JS treats as a literal Z, prematurely
  // stopping at any uppercase Z (e.g. ISO-8601 timestamps embedded in
  // descriptions). Guard against that family of bugs.
  const fm = [
    'findings:',
    '  - id: F-001',
    '    title: "fixed at 2026-01-01T00:00:00Z"',
    '  - id: F-002',
    '    title: "ZZZ marker"',
    '  - id: F-003',
  ].join('\n');
  const body = extractYamlBlock(fm, 'findings');
  assert.ok(body.includes('F-001'));
  assert.ok(body.includes('F-002'));
  assert.ok(body.includes('F-003'), 'must reach F-003 past the Z characters');
});

test('extractH3Bullets: handles blank line right after heading', () => {
  // The pre-fix regex used `(?=...|$)` which matched at the blank line and
  // captured nothing.
  const text = [
    '## Section',
    '',
    'prose',
    '',
    '### Files modified',
    '',
    '- `a.go`',
    '- `b.go`',
    '- `c.go`',
    '',
    '### Files created',
    '',
    '- (none)',
  ].join('\n');
  const files = extractH3Bullets(text, 'Files modified');
  assert.deepEqual(files, ['a.go', 'b.go', 'c.go']);
});

test('extractH3Bullets: stops at next H3 and at H2', () => {
  const text = [
    '### Files modified',
    '- `a.go`',
    '### Files created',
    '- `b.go`',
  ].join('\n');
  assert.deepEqual(extractH3Bullets(text, 'Files modified'), ['a.go']);
  assert.deepEqual(extractH3Bullets(text, 'Files created'), ['b.go']);
});

test('extractH3Bullets: filters `(none)` and `(none — <reason>)` sentinels', () => {
  const text = [
    '### Files modified',
    '',
    '- (none)',
    '- (none — verification-only outcome; F-001 already handled it)',
    '- `actual/file.go`',
  ].join('\n');
  assert.deepEqual(extractH3Bullets(text, 'Files modified'), [
    'actual/file.go',
  ]);
});

test('extractH3Bullets: missing heading returns empty list', () => {
  const text = '## Other section\n\n- `x.go`\n';
  assert.deepEqual(extractH3Bullets(text, 'Files modified'), []);
});

test('readCodeReview: parses all 3 findings from a synthetic CODE_REVIEW.md', () => {
  const dir = fixture({
    'CODE_REVIEW.md': [
      '---',
      'featureId: feat-test',
      'totalFindings: 3',
      'severityCounts:',
      '  high: 2',
      '  medium: 1',
      '  low: 0',
      'findings:',
      '  - id: F-001',
      '    severity: high',
      '    lane: qa',
      '    file: foo.go',
      '    title: "first finding @ 2026-01-01T00:00:00Z"',
      '    description: |',
      '      long description line one',
      '      long description line two',
      '    fix: "do the thing"',
      '  - id: F-002',
      '    severity: high',
      '    lane: qa',
      '    file: bar.go',
      '    title: "second finding"',
      '    fix: "do the other thing"',
      '  - id: F-003',
      '    severity: medium',
      '    lane: qa',
      '    file: baz.go',
      '    title: "third finding"',
      '    fix: "do the last thing"',
      '---',
      '',
      '# CODE_REVIEW body',
    ].join('\n'),
  });
  try {
    const cr = readCodeReview(dir);
    assert.equal(cr.totalFindings, 3);
    assert.equal(cr.findings.length, 3);
    assert.equal(cr.findings[0].id, 'F-001');
    assert.equal(cr.findings[2].id, 'F-003');
    assert.equal(cr.sev.high, 2);
    assert.equal(cr.sev.medium, 1);
    assert.ok(cr.byId.has('F-002'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFixes: extracts findingId + filesModified from FIX_*.completed.md', () => {
  const dir = fixture({
    'FIX_F-001.completed.md': [
      '---',
      'findingId: F-001',
      'outcome: completed',
      'modelAtSuccess: sonnet',
      'stepsUsed: 1',
      '---',
      '',
      '## Fix log',
      '',
      '### Files modified',
      '',
      '- `a/b/c.go`',
      '- `d/e/f.go`',
      '',
      '### Files created',
      '',
      '- (none)',
    ].join('\n'),
    'FIX_F-002.completed.md': [
      '---',
      'findingId: F-002',
      'outcome: completed',
      'modelAtSuccess: sonnet',
      'stepsUsed: 0',
      '---',
      '',
      '### Files modified',
      '',
      '- (none — F-001 already covered this)',
    ].join('\n'),
  });
  try {
    const fixes = readFixes(dir);
    assert.equal(fixes.length, 2);
    assert.equal(fixes[0].findingId, 'F-001');
    assert.deepEqual(fixes[0].filesModified, ['a/b/c.go', 'd/e/f.go']);
    assert.equal(fixes[1].findingId, 'F-002');
    assert.deepEqual(fixes[1].filesModified, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTests: parses summary + testsAdded count', () => {
  const dir = fixture({
    'TESTS.md': [
      '---',
      'runner: go-test',
      'skipped: false',
      'summary:',
      '  totalTests: 35',
      '  killedMutants: 95',
      '  totalMutants: 136',
      '  killRate: 0.7',
      '  coverageGaps: 3',
      'testsAdded:',
      '  - testId: T-1',
      '    file: a_test.go',
      '  - testId: T-2',
      '    file: b_test.go',
      '---',
    ].join('\n'),
  });
  try {
    const t = readTests(dir);
    assert.equal(t.skipped, false);
    assert.equal(t.totalTests, 35);
    assert.equal(t.killedMutants, 95);
    assert.equal(t.killRate, 0.7);
    assert.equal(t.testsAddedCount, 2);
    assert.equal(t.runner, 'go-test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTests: surfaces skip reason when skipped: true', () => {
  const dir = fixture({
    'TESTS.md': [
      '---',
      'skipped: true',
      'skipReason: "host has no test runner"',
      '---',
    ].join('\n'),
  });
  try {
    const t = readTests(dir);
    assert.equal(t.skipped, true);
    assert.equal(t.skipReason, 'host has no test runner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDocPatches: extracts docsPatched[] with summaries', () => {
  const dir = fixture({
    'DOC_PATCHES.md': [
      '---',
      'phase: B',
      'skipped: false',
      'docsPatched:',
      '  - docPath: "docs/a.md"',
      '    summary: "rewrote section X"',
      '  - docPath: "docs/b.md"',
      '    summary: "updated import path"',
      'summary:',
      '  patchesApplied: 2',
      '---',
    ].join('\n'),
  });
  try {
    const dp = readDocPatches(dir);
    assert.equal(dp.skipped, false);
    assert.equal(dp.patches.length, 2);
    assert.equal(dp.patches[0].docPath, 'docs/a.md');
    assert.equal(dp.patches[0].summary, 'rewrote section X');
    assert.equal(dp.patches[1].summary, 'updated import path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDocPatches: honors skipped: true', () => {
  const dir = fixture({
    'DOC_PATCHES.md': [
      '---',
      'phase: B',
      'skipped: true',
      'skipReason: "no public surface drift"',
      '---',
    ].join('\n'),
  });
  try {
    const dp = readDocPatches(dir);
    assert.equal(dp.skipped, true);
    assert.equal(dp.skipReason, 'no public surface drift');
    assert.deepEqual(dp.patches, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseFm: returns empty string when no frontmatter delimiter', () => {
  assert.equal(parseFm('# plain markdown body\n\nno fm here'), '');
});

test('parseFm: captures content between --- delimiters', () => {
  const text = '---\nfoo: 1\nbar: 2\n---\n\nbody';
  assert.equal(parseFm(text), 'foo: 1\nbar: 2');
});
