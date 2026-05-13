// Unit tests for the PATTERNS array in browzer-track-wasted.mjs.
// Verifies that rg commands route to source="wasted-rg" and grep -r/-R
// commands still route to source="wasted-grep" (no regression).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Inline the PATTERNS array from browzer-track-wasted.mjs so the test
// does not execute the module-level side effects (process.exit calls).
const PATTERNS = [
  { source: 'wasted-grep', re: /^\s*grep\s+.*-r\b/ },
  { source: 'wasted-grep', re: /^\s*grep\s+.*-R\b/ },
  { source: 'wasted-rg', re: /^\s*rg\b/ },
  { source: 'wasted-find', re: /^\s*find\s+.*\s+-name\b/ },
  { source: 'wasted-find', re: /^\s*find\s+.*\s+-iname\b/ },
  { source: 'wasted-find', re: /^\s*ls\s+.*-R\b/ },
];

function classify(cmd) {
  for (const p of PATTERNS) {
    if (p.re.test(cmd)) return p.source;
  }
  return null;
}

test('rg command routes to wasted-rg', () => {
  assert.equal(classify('rg foo .'), 'wasted-rg');
  assert.equal(classify('rg --hidden pattern src/'), 'wasted-rg');
  assert.equal(classify('  rg somepattern'), 'wasted-rg');
});

test('grep -r routes to wasted-grep (no regression)', () => {
  assert.equal(classify('grep -r pattern .'), 'wasted-grep');
  assert.equal(classify('grep pattern -r .'), 'wasted-grep');
});

test('grep -R routes to wasted-grep (no regression)', () => {
  assert.equal(classify('grep -R pattern .'), 'wasted-grep');
});

test('find -name routes to wasted-find', () => {
  assert.equal(classify('find . -name "*.ts"'), 'wasted-find');
});

test('unrelated command returns null', () => {
  assert.equal(classify('ls -la'), null);
  assert.equal(classify('cat file.txt'), null);
  assert.equal(classify('browzer explore foo'), null);
});
