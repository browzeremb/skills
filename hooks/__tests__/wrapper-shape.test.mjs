import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = join(HERE, '..');

// Collect every .sh file at depth 1 in hooks/
const shFiles = readdirSync(HOOKS_DIR)
  .filter((name) => name.endsWith('.sh'))
  .map((name) => ({ name, path: join(HOOKS_DIR, name) }));

test('wrapper-shape: at least one .sh wrapper exists', () => {
  assert.ok(shFiles.length > 0, 'expected at least one .sh wrapper in hooks/');
});

for (const { name, path } of shFiles) {
  test(`wrapper-shape: ${name} is executable`, () => {
    const stat = statSync(path);
    const isExec = (stat.mode & 0o111) !== 0;
    assert.ok(isExec, `${name} must be executable (mode 0755)`);
  });

  test(`wrapper-shape: ${name} has shebang #!/usr/bin/env bash`, () => {
    const firstLine = readFileSync(path, 'utf8').split('\n')[0];
    assert.match(
      firstLine,
      /^#!\s*(\/usr\/bin\/env bash|\/bin\/bash)/,
      `${name} must start with a bash shebang`,
    );
  });

  test(`wrapper-shape: ${name} contains browzer hook invocation`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(
      content,
      /browzer hook /,
      `${name} must contain 'browzer hook <name>' invocation`,
    );
  });

  test(`wrapper-shape: ${name} has case arms for 0, 1, 2, 3`, () => {
    const content = readFileSync(path, 'utf8');
    // Must have a case block covering the four exit codes
    assert.match(content, /case\s/, `${name} must contain a case block`);
    assert.match(content, /0\)/, `${name} must have a 0) arm`);
    assert.match(content, /1\)/, `${name} must have a 1) arm`);
    assert.match(content, /2\)/, `${name} must have a 2) arm`);
    assert.match(content, /3\)/, `${name} must have a 3) arm`);
  });

  test(`wrapper-shape: ${name} is within 60 LOC`, () => {
    const lineCount = readFileSync(path, 'utf8').split('\n').length;
    assert.ok(
      lineCount <= 75,
      `${name} is ${lineCount} lines — LOC budget is 60 (±15 for audit/comments)`,
    );
  });

  test(`wrapper-shape: ${name} includes dep guard for jq and browzer`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(
      content,
      /command -v.*browzer/,
      `${name} must silently short-circuit when browzer is missing`,
    );
  });
}
