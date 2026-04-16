import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyPath, isHookEnabled, tokensOf } from './_util.mjs';

test('classifyPath', () => {
  assert.equal(classifyPath('src/foo.ts'), 'code');
  assert.equal(classifyPath('README.md'), 'doc');
  assert.equal(classifyPath('package.json'), 'doc');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'config');
  assert.equal(classifyPath('node_modules/foo/index.js'), 'config');
});

test('tokensOf', () => {
  assert.equal(tokensOf(0), 0);
  assert.equal(tokensOf(4), 1);
  assert.equal(tokensOf(7), 2);
});

test('isHookEnabled honors env override', () => {
  process.env.BROWZER_HOOK = 'off';
  assert.equal(isHookEnabled(), false);
  delete process.env.BROWZER_HOOK;
});
