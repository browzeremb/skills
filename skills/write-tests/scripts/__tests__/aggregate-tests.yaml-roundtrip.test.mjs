// Regression test for F-030: aggregate-tests.mjs frontmatter serialization via
// the `yaml` npm package (replacing the hand-rolled renderYaml/scalar helpers).
//
// Verifies that values containing `:` and quoted strings round-trip through
// yaml.parse without loss — the chief behavioral difference between the bespoke
// serializer and the yaml package's quoting heuristics.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'aggregate-tests.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agg-yaml-roundtrip-'));
}

function makeFeatureTree(root, featureId) {
  const stagingDir = path.join(root, 'docs', 'browzer', featureId, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  return stagingDir;
}

function writeReceipt(tmpRoot, featureId, data) {
  const file = path.join(tmpRoot, `write-tests-${featureId}-summary.json`);
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

function runScript(featureId, cwd, tmpRoot) {
  return spawnSync(process.execPath, [SCRIPT, featureId], {
    encoding: 'utf8',
    timeout: 15_000,
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      TMPDIR: tmpRoot,
      TEMP: tmpRoot,
      TMP: tmpRoot,
    },
  });
}

describe('aggregate-tests: yaml round-trip (F-030 regression)', () => {
  it('frontmatter containing colon-bearing values round-trips through yaml.parse', () => {
    const root = tmpDir();
    const featureId = 'feat-20260513-yaml-roundtrip';
    const stagingDir = makeFeatureTree(root, featureId);

    const receipt = {
      skipped: false,
      runner: 'vitest',
      mutationTool: null,
      testsAdded: [
        {
          testId: 'T-001',
          file: 'src/__tests__/foo.test.ts',
          symbolUnderTest: 'apps/api: some:colon:value',
          intent: 'green',
          killedMutants: 3,
          totalMutants: 4,
        },
      ],
      filesCreated: [{ path: 'src/__tests__/foo.test.ts', lineCount: 42 }],
      filesModified: [],
      mutationCategoriesCovered: ['boolean', 'conditional'],
      coverageGaps: [],
      survivingMutants: [],
    };
    writeReceipt(root, featureId, receipt);

    const res = runScript(featureId, root, root);

    assert.equal(res.status, 0, `script must exit 0; stderr: ${res.stderr}`);

    const testsmd = path.join(stagingDir, 'TESTS.md');
    assert.ok(fs.existsSync(testsmd), 'TESTS.md must be written');

    const content = fs.readFileSync(testsmd, 'utf8');

    // Extract the YAML frontmatter block between the first two `---` fences.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'TESTS.md must contain a YAML frontmatter block');

    let parsed;
    try {
      parsed = yamlParse(fmMatch[1]);
    } catch (e) {
      assert.fail(
        `frontmatter is not valid YAML: ${e.message}\n---\n${fmMatch[1]}\n---`,
      );
    }

    // featureId round-trips exactly.
    assert.strictEqual(parsed.featureId, featureId, 'featureId round-trips');

    // runner contains no colon but must survive serialization.
    assert.strictEqual(parsed.runner, 'vitest', 'runner round-trips');

    // symbolUnderTest contains colons — the key test for the yaml package's
    // quoting behaviour vs the bespoke scalar() helper.
    assert.strictEqual(
      parsed.testsAdded[0].symbolUnderTest,
      'apps/api: some:colon:value',
      'symbolUnderTest with colons round-trips without loss',
    );

    // Summary counts are numeric.
    assert.strictEqual(parsed.summary.totalTests, 1, 'totalTests');
    assert.strictEqual(parsed.summary.killedMutants, 3, 'killedMutants');
    assert.strictEqual(parsed.summary.totalMutants, 4, 'totalMutants');

    // mutationCategoriesCovered is an array.
    assert.deepEqual(
      parsed.mutationCategoriesCovered,
      ['boolean', 'conditional'],
      'mutationCategoriesCovered array round-trips',
    );
  });

  it('null mutationTool serializes as null (not string "null")', () => {
    const root = tmpDir();
    const featureId = 'feat-20260513-yaml-null';
    makeFeatureTree(root, featureId);

    const receipt = {
      skipped: false,
      runner: 'vitest',
      mutationTool: null,
      testsAdded: [
        {
          testId: 'T-001',
          file: 'src/__tests__/bar.test.ts',
          symbolUnderTest: 'bar',
          intent: 'green',
          killedMutants: 0,
          totalMutants: 0,
        },
      ],
      filesCreated: [{ path: 'src/__tests__/bar.test.ts', lineCount: 10 }],
      filesModified: [],
      mutationCategoriesCovered: [],
      coverageGaps: [],
      survivingMutants: [],
    };
    writeReceipt(root, featureId, receipt);

    const res = runScript(featureId, root, root);
    assert.equal(res.status, 0, `exit 0; stderr: ${res.stderr}`);

    const stagingDir = path.join(root, 'docs', 'browzer', featureId, 'staging');
    const content = fs.readFileSync(path.join(stagingDir, 'TESTS.md'), 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'must have frontmatter');

    const parsed = yamlParse(fmMatch[1]);
    // yaml.parse returns JS null for a YAML null literal.
    assert.strictEqual(
      parsed.mutationTool,
      null,
      'mutationTool must be null, not string "null"',
    );
  });
});
