// Tests for hooks/_browzer-cache.mjs — staging-directory-bound query cache.
//
// AC-01 / FR-01: getCached/setCached contract, SHA dispersion, staging-dir
// scoping.
// AC-02 / FR-02: cwd-walk fallback picks most-recently-modified feat staging/.
// AC-03 / FR-03: tmpdir fallback when no docs/browzer/feat-* staging/ exists.
//
// Mutation-resistant principles applied:
//   - Boolean: getCached returns {hit:false} on miss, {hit:true} on hit —
//     asserted with strict equality (kills boolean mutants on the hit flag)
//   - Return-value: value round-trips exactly (kills value-swap mutants)
//   - Boundary: empty-string query degrades gracefully (does not throw)
//   - Arithmetic: two distinct queries produce two distinct cache files (SHA
//     dispersion — kills index/address arithmetic mutants)

import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..', '_browzer-cache.mjs');

let getCached;
let setCached;
let stagingDir;

// We import the module fresh for each test group by setting BROWZER_STAGING_DIR
// to a per-test temp dir BEFORE import. Because ESM caches modules, we instead
// set the env var before the first import and rely on the module reading it at
// call time via resolveStagingDir() — which reads process.env each invocation.

beforeEach(async () => {
  stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browzer-cache-test-'));
  process.env.BROWZER_STAGING_DIR = stagingDir;
  // Import once; resolveStagingDir() re-reads process.env on every call.
  if (!getCached) {
    ({ getCached, setCached } = await import(MODULE));
  }
});

afterEach(() => {
  delete process.env.BROWZER_STAGING_DIR;
  // Clean up staging dir (best-effort).
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {}
});

describe('_browzer-cache: getCached / setCached contract', () => {
  it('returns {hit:false} on first lookup (cache miss)', () => {
    const result = getCached('some query');
    // Boolean mutant kill: hit must be exactly false, not just falsy.
    assert.strictEqual(result.hit, false, 'first lookup must be a miss');
    assert.strictEqual(result.value, null, 'value must be null on miss');
  });

  it('returns {hit:true, value} on second lookup after setCached', () => {
    const query = 'browzer mentions packages/core/src/search';
    const payload = { entries: [{ path: 'a.ts', score: 0.9 }] };

    setCached(query, payload);
    const result = getCached(query);

    // Boolean mutant kill: hit must be exactly true.
    assert.strictEqual(result.hit, true, 'second lookup must be a hit');
    // Return-value mutant kill: value must round-trip exactly.
    assert.deepStrictEqual(
      result.value,
      payload,
      'cached value must match written payload',
    );
  });

  it('stores cache file under ${BROWZER_STAGING_DIR}/.cache/browzer-mentions-<sha>.json', () => {
    const query = 'find the scoring logic';
    setCached(query, { ok: true });

    const sha = crypto.createHash('sha256').update(query).digest('hex');
    const expectedFile = path.join(
      stagingDir,
      '.cache',
      `browzer-mentions-${sha}.json`,
    );
    assert.equal(
      fs.existsSync(expectedFile),
      true,
      `cache file must exist at ${expectedFile}`,
    );
  });

  it('two distinct queries produce two distinct cache files (SHA dispersion)', () => {
    const q1 = 'query alpha';
    const q2 = 'query beta';

    setCached(q1, { result: 1 });
    setCached(q2, { result: 2 });

    const sha1 = crypto.createHash('sha256').update(q1).digest('hex');
    const sha2 = crypto.createHash('sha256').update(q2).digest('hex');

    // Arithmetic mutant kill: hashes must differ.
    assert.notEqual(sha1, sha2, 'SHA-256 of distinct queries must differ');

    const cacheDir = path.join(stagingDir, '.cache');
    const files = fs.readdirSync(cacheDir);
    assert.ok(
      files.includes(`browzer-mentions-${sha1}.json`),
      'cache file for q1 must exist',
    );
    assert.ok(
      files.includes(`browzer-mentions-${sha2}.json`),
      'cache file for q2 must exist',
    );

    // Return-value isolation: each query returns its own value.
    assert.deepStrictEqual(getCached(q1).value, { result: 1 });
    assert.deepStrictEqual(getCached(q2).value, { result: 2 });
  });

  it('getCached for q1 does not return q2 value (no cross-key collision)', () => {
    setCached('key-one', { label: 'one' });
    setCached('key-two', { label: 'two' });

    const r1 = getCached('key-one');
    const r2 = getCached('key-two');

    assert.strictEqual(r1.value.label, 'one');
    assert.strictEqual(r2.value.label, 'two');
    // Mutation guard: values must not be swapped.
    assert.notEqual(r1.value.label, r2.value.label);
  });

  it('degrades gracefully on empty-string query (boundary: length === 0)', () => {
    // Empty query is the off-by-one boundary case (query.length === 0).
    const result = getCached('');
    assert.strictEqual(result.hit, false, 'empty query must not hit');
    assert.strictEqual(result.value, null);

    // setCached must return false (not throw) on empty query.
    const wrote = setCached('', { data: 1 });
    assert.strictEqual(
      wrote,
      false,
      'setCached must return false for empty query',
    );
  });

  it('cache is scoped to the staging directory (different dirs = different caches)', () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'browzer-cache-dir1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'browzer-cache-dir2-'));

    try {
      const query = 'shared query string';

      process.env.BROWZER_STAGING_DIR = dir1;
      setCached(query, { from: 'dir1' });

      process.env.BROWZER_STAGING_DIR = dir2;
      // Different staging dir — cache must be cold.
      const miss = getCached(query);
      assert.strictEqual(
        miss.hit,
        false,
        'cache in dir2 must not see entry written in dir1',
      );

      // Restore for afterEach cleanup.
      process.env.BROWZER_STAGING_DIR = stagingDir;
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('cwd-walk fallback: resolves to most-recently-modified feat staging/ when BROWZER_STAGING_DIR unset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browzer-cwdwalk-'));
    try {
      const browzerDir = path.join(root, 'docs', 'browzer');
      const feat1Staging = path.join(browzerDir, 'feat-older', 'staging');
      const feat2Staging = path.join(browzerDir, 'feat-newer', 'staging');
      fs.mkdirSync(feat1Staging, { recursive: true });
      fs.mkdirSync(feat2Staging, { recursive: true });

      // Touch feat2 to make it newer.
      const now = new Date();
      const older = new Date(now.getTime() - 60_000);
      fs.utimesSync(feat1Staging, older, older);
      fs.utimesSync(feat2Staging, now, now);

      // Unset env so cwd-walk fires.
      delete process.env.BROWZER_STAGING_DIR;

      // Set cwd to root so the walk finds docs/browzer/ immediately.
      const origCwd = process.cwd();
      process.chdir(root);
      try {
        const query = 'walk-test query';
        setCached(query, { from: 'cwd-walk' });
        const result = getCached(query);
        assert.strictEqual(
          result.hit,
          true,
          'cwd-walk must find the feat staging dir',
        );
        assert.deepStrictEqual(result.value, { from: 'cwd-walk' });

        // Verify the cache landed inside feat-newer/staging/.cache (most recent mtime).
        const sha = crypto.createHash('sha256').update(query).digest('hex');
        const expectedFile = path.join(
          feat2Staging,
          '.cache',
          `browzer-mentions-${sha}.json`,
        );
        assert.ok(
          fs.existsSync(expectedFile),
          'cache file must land in the most-recently-modified feat staging dir',
        );
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      // Restore for remaining tests.
      process.env.BROWZER_STAGING_DIR = stagingDir;
    }
  });

  it('tmpdir fallback: resolves to os.tmpdir() path when no feat staging/ exists and BROWZER_STAGING_DIR unset', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browzer-notmpdir-'));
    try {
      delete process.env.BROWZER_STAGING_DIR;

      const origCwd = process.cwd();
      // Change into a directory with no docs/browzer/ tree.
      process.chdir(root);
      try {
        const query = 'tmpdir-fallback query';
        // setCached must still succeed (writes under tmpdir fallback).
        const wrote = setCached(query, { from: 'tmpdir-fallback' });
        assert.strictEqual(
          wrote,
          true,
          'setCached must succeed under tmpdir fallback',
        );

        const result = getCached(query);
        assert.strictEqual(
          result.hit,
          true,
          'tmpdir fallback must be readable',
        );
        assert.deepStrictEqual(result.value, { from: 'tmpdir-fallback' });

        // Verify the cache landed under os.tmpdir(), NOT under cwd (the root).
        const sha = crypto.createHash('sha256').update(query).digest('hex');
        const cwdFile = path.join(
          root,
          '.browzer-cache-fallback',
          '.cache',
          `browzer-mentions-${sha}.json`,
        );
        assert.ok(
          !fs.existsSync(cwdFile),
          'cache must NOT land under cwd (old cwd-fallback bug must be closed)',
        );
      } finally {
        process.chdir(origCwd);
        // Clean up anything written to tmpdir fallback.
        const { tmpdir: osTmpdir } = await import('node:os');
        const fallbackDir = path.join(osTmpdir(), 'browzer-cache-fallback');
        try {
          fs.rmSync(fallbackDir, { recursive: true, force: true });
        } catch {}
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      process.env.BROWZER_STAGING_DIR = stagingDir;
    }
  });
});
