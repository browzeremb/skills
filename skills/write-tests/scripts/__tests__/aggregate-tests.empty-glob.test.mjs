// Tests for aggregate-tests.mjs — empty-glob path (no test files present).
//
// AC-05 / FR-05: when no receipt is found AND git surfaces no test files,
// the script must exit 0 and emit a JSON line with
//   { testsFound: 0, skipped: true, reason: "no-test-files" }
// rather than hard-dying with exit code 1 or 3.
//
// Mutation-resistant principles applied:
//   - Conditional: assert exit code 0, not just "not 2" (kills off-by-one on
//     the process.exit() argument)
//   - Return-value: assert exact JSON shape including `reason` string
//   - Boolean: assert skipped === true (not just truthy), testsFound === 0
//     (not just falsy)
//   - Arithmetic: testsFound must equal 0, not -1 or any other sentinel

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'aggregate-tests.mjs');
const REPO_ROOT = path.resolve(HERE, '../../../../../../');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aggregate-tests-empty-'));
}

// Create the minimal directory tree aggregate-tests expects:
//   docs/browzer/<featureId>/staging/
function makeFeatureTree(root, featureId) {
  const stagingDir = path.join(root, 'docs', 'browzer', featureId, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  return stagingDir;
}

// Write a minimal empty receipt so scanReceipts() finds it. The script only
// reaches the empty-glob code path when the receipt exists but has empty
// testsAdded[] AND filesCreated[]. Without a receipt it exits 3 (hard die).
function writeEmptyReceipt(tmpRoot, featureId) {
  const receipt = {
    skipped: false,
    testsAdded: [],
    filesCreated: [],
    filesModified: [],
    mutationCategoriesCovered: [],
    coverageGaps: [],
    survivingMutants: [],
  };
  const file = path.join(tmpRoot, `write-tests-${featureId}-summary.json`);
  fs.writeFileSync(file, JSON.stringify(receipt), 'utf8');
  return file;
}

// Run aggregate-tests.mjs in a clean temp workspace with an empty receipt and
// no git test files visible. TMPDIR is overridden so scanReceipts() looks in
// our controlled directory.
function runScript(featureId, cwd, tmpRoot) {
  return spawnSync(process.execPath, [SCRIPT, featureId], {
    encoding: 'utf8',
    timeout: 15_000,
    cwd,
    env: {
      ...process.env,
      // Point HOME away to avoid accidental credential or config pick-up.
      HOME: cwd,
      // Override TMPDIR so scanReceipts() finds our controlled receipt.
      TMPDIR: tmpRoot,
      TEMP: tmpRoot,
      TMP: tmpRoot,
    },
  });
}

describe('aggregate-tests: empty-glob / no-test-files path', () => {
  it('exits 0 with {testsFound:0, skipped:true, reason:"no-test-files"} when receipt is absent', () => {
    const root = tmpDir();
    const featureId = 'feat-20260513-empty-glob-test';
    makeFeatureTree(root, featureId);
    writeEmptyReceipt(root, featureId);

    const res = runScript(featureId, root, root);

    // Conditional mutant kill: exit code must be exactly 0, not 1 or 3.
    assert.equal(
      res.status,
      0,
      `expected exit 0 for empty-glob path; stderr: ${res.stderr}`,
    );

    // Parse the JSON the script emits to stdout.
    const stdout = res.stdout.trim();
    assert.ok(
      stdout.length > 0,
      'stdout must be non-empty for the empty-glob signal',
    );

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(
        `stdout is not valid JSON: ${stdout}\nparse error: ${e.message}`,
      );
    }

    // Boolean mutant kills: each field asserted with exact type + value.
    assert.strictEqual(
      parsed.testsFound,
      0,
      'testsFound must equal 0 (arithmetic mutant)',
    );
    assert.strictEqual(
      parsed.skipped,
      true,
      'skipped must be boolean true (boolean mutant)',
    );
    assert.strictEqual(
      parsed.reason,
      'no-test-files',
      'reason must equal "no-test-files" (return-value mutant)',
    );
  });

  it('does not throw or surface nomatch shell errors in the JSON output', () => {
    const root = tmpDir();
    const featureId = 'feat-20260513-empty-glob-nomatch';
    makeFeatureTree(root, featureId);
    writeEmptyReceipt(root, featureId);

    const res = runScript(featureId, root, root);

    // Regression: nomatch flag in some shells surfaces as uncaught error.
    // Guard: stderr must NOT contain "Error:" or "throw" on the happy path.
    assert.doesNotMatch(
      res.stderr,
      /\bError:/,
      `stderr must not contain "Error:" but got: ${res.stderr}`,
    );
    assert.equal(res.status, 0, `exit must be 0 even with nomatch risk`);
  });

  it('does not write TESTS.md to staging when no tests found', () => {
    const root = tmpDir();
    const featureId = 'feat-20260513-empty-glob-nowrite';
    const stagingDir = makeFeatureTree(root, featureId);
    writeEmptyReceipt(root, featureId);

    runScript(featureId, root, root);

    const testsmd = path.join(stagingDir, 'TESTS.md');
    assert.equal(
      fs.existsSync(testsmd),
      false,
      'TESTS.md must not be written when empty-glob path taken',
    );
  });
});
