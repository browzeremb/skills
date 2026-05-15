/**
 * cluster-findings.test.mjs — self-test for cluster-findings.mjs
 *
 * Run with: node --test cluster-findings.test.mjs
 *
 * Cases:
 *   1. Shared pinsFiles → one cluster
 *   2. Shared non-general ruleId → one cluster
 *   3. Operator-declared clusterId → one cluster
 *   4. No signal → singleton baseline (each finding in its own cluster)
 *   5. Transitive cluster (A↔B by pinsFiles, B↔C by ruleId) — F-007
 *   6. Id-less input does not crash; gets cluster-orphan-N default — F-014
 *   7. Pipe-in-id clusters correctly without hash collision — F-008
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  fileURLToPath(import.meta.url),
  '../cluster-findings.mjs',
);

/**
 * Write a fixture to a temp dir and run cluster-findings.mjs against it.
 * Returns the parsed JSON manifest from stdout.
 */
function runCli(findings) {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-findings-test-'));
  const inputPath = join(dir, 'findings.json');
  writeFileSync(inputPath, JSON.stringify(findings), 'utf8');

  const result = spawnSync(process.execPath, [SCRIPT, inputPath], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `cluster-findings exited ${result.status}: ${result.stderr}`,
    );
  }

  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// Case 1 — shared pinsFiles
// ---------------------------------------------------------------------------

describe('Case 1: shared pinsFiles', () => {
  it('two findings with overlapping pinsFiles end up in one cluster', () => {
    const findings = [
      {
        id: 'F-001',
        ruleId: 'general',
        pinsFiles: ['src/api/x.ts', 'src/api/y.ts'],
      },
      { id: 'F-002', ruleId: 'general', pinsFiles: ['src/api/x.ts'] },
    ];

    const manifest = runCli(findings);

    assert.equal(
      manifest.clusters.length,
      1,
      'should produce exactly one cluster',
    );
    const cluster = manifest.clusters[0];
    assert.deepEqual(cluster.members.sort(), ['F-001', 'F-002']);
    assert.equal(cluster.reason, 'pinsFiles');
    assert.deepEqual(cluster.reasonChain, ['pinsFiles']);
    assert.match(
      cluster.clusterId,
      /^[0-9a-f]{12}$/,
      'clusterId must be 12 hex chars',
    );
  });

  it('clusterId is deterministic across runs', () => {
    const findings = [
      { id: 'F-001', ruleId: 'general', pinsFiles: ['src/api/x.ts'] },
      { id: 'F-002', ruleId: 'general', pinsFiles: ['src/api/x.ts'] },
    ];

    const r1 = runCli(findings);
    const r2 = runCli(findings);
    assert.equal(
      r1.clusters[0].clusterId,
      r2.clusters[0].clusterId,
      'clusterId must be stable',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 2 — shared non-general ruleId
// ---------------------------------------------------------------------------

describe('Case 2: shared non-general ruleId', () => {
  it('two findings sharing a non-general ruleId end up in one cluster', () => {
    const findings = [
      { id: 'F-003', ruleId: 'no-stash', pinsFiles: ['src/a.ts'] },
      { id: 'F-004', ruleId: 'no-stash', pinsFiles: ['src/b.ts'] },
    ];

    const manifest = runCli(findings);

    assert.equal(
      manifest.clusters.length,
      1,
      'should produce exactly one cluster',
    );
    const cluster = manifest.clusters[0];
    assert.deepEqual(cluster.members.sort(), ['F-003', 'F-004']);
    assert.equal(cluster.reason, 'ruleId');
    assert.deepEqual(cluster.reasonChain, ['ruleId']);
  });

  it('two findings sharing the ruleId "general" stay in separate clusters', () => {
    const findings = [
      { id: 'F-005', ruleId: 'general', pinsFiles: ['src/c.ts'] },
      { id: 'F-006', ruleId: 'general', pinsFiles: ['src/d.ts'] },
    ];

    const manifest = runCli(findings);

    assert.equal(
      manifest.clusters.length,
      2,
      'general ruleId must NOT trigger merging',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 3 — operator-declared clusterId
// ---------------------------------------------------------------------------

describe('Case 3: operator-declared clusterId', () => {
  it('two findings with matching clusterId end up in one cluster with reason clusterId', () => {
    const findings = [
      {
        id: 'F-007',
        ruleId: 'general',
        pinsFiles: ['src/e.ts'],
        clusterId: 'extract-hook',
      },
      {
        id: 'F-008',
        ruleId: 'general',
        pinsFiles: ['src/f.ts'],
        clusterId: 'extract-hook',
      },
    ];

    const manifest = runCli(findings);

    assert.equal(manifest.clusters.length, 1);
    const cluster = manifest.clusters[0];
    assert.deepEqual(cluster.members.sort(), ['F-007', 'F-008']);
    assert.equal(cluster.reason, 'clusterId');
    assert.deepEqual(cluster.reasonChain, ['clusterId']);
  });

  it('clusterId takes priority over pinsFiles', () => {
    const findings = [
      // These two share pinsFiles AND clusterId — clusterId must win as dominant
      {
        id: 'F-009',
        ruleId: 'general',
        pinsFiles: ['src/shared.ts'],
        clusterId: 'grp-a',
      },
      {
        id: 'F-010',
        ruleId: 'general',
        pinsFiles: ['src/shared.ts'],
        clusterId: 'grp-a',
      },
    ];

    const manifest = runCli(findings);

    assert.equal(manifest.clusters.length, 1);
    assert.equal(manifest.clusters[0].reason, 'clusterId');
    // reasonChain captures BOTH predicates that fired
    assert.deepEqual(manifest.clusters[0].reasonChain, [
      'clusterId',
      'pinsFiles',
    ]);
  });

  it('different operator clusterIds produce separate clusters', () => {
    const findings = [
      { id: 'F-011', ruleId: 'general', pinsFiles: [], clusterId: 'grp-x' },
      { id: 'F-012', ruleId: 'general', pinsFiles: [], clusterId: 'grp-y' },
    ];

    const manifest = runCli(findings);

    assert.equal(
      manifest.clusters.length,
      2,
      'different clusterIds must not merge',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 4 — singleton baseline
// ---------------------------------------------------------------------------

describe('Case 4: singleton baseline', () => {
  it('findings with no shared signal each become their own cluster', () => {
    const findings = [
      { id: 'F-013', ruleId: 'general', pinsFiles: ['src/g.ts'] },
      { id: 'F-014', ruleId: 'general', pinsFiles: ['src/h.ts'] },
      { id: 'F-015', ruleId: 'general', pinsFiles: ['src/i.ts'] },
    ];

    const manifest = runCli(findings);

    assert.equal(
      manifest.clusters.length,
      3,
      'each disjoint finding must be its own cluster',
    );
    for (const cluster of manifest.clusters) {
      assert.equal(
        cluster.members.length,
        1,
        'singleton cluster must have exactly one member',
      );
      assert.equal(cluster.reason, 'singleton');
      assert.deepEqual(cluster.reasonChain, ['singleton']);
      assert.match(cluster.clusterId, /^[0-9a-f]{12}$/);
    }
  });

  it('empty input produces empty clusters array', () => {
    const manifest = runCli([]);
    assert.deepEqual(manifest, { clusters: [] });
  });
});

// ---------------------------------------------------------------------------
// Case 5 — transitive cluster (F-007)
// ---------------------------------------------------------------------------

describe('Case 5: transitive cluster (A↔B by pinsFiles, B↔C by ruleId)', () => {
  it('three findings merge transitively and reasonChain lists both predicates', () => {
    const findings = [
      // A and B overlap by pinsFiles
      { id: 'F-A', ruleId: 'general', pinsFiles: ['src/shared.ts'] },
      {
        id: 'F-B',
        ruleId: 'no-stash',
        pinsFiles: ['src/shared.ts', 'src/other.ts'],
      },
      // B and C share a non-general ruleId
      { id: 'F-C', ruleId: 'no-stash', pinsFiles: ['src/lone.ts'] },
    ];

    const manifest = runCli(findings);

    assert.equal(
      manifest.clusters.length,
      1,
      'A, B, C must all land in one cluster',
    );
    const cluster = manifest.clusters[0];
    assert.deepEqual(cluster.members.sort(), ['F-A', 'F-B', 'F-C']);
    // Dominant predicate is pinsFiles (higher priority than ruleId)
    assert.equal(cluster.reason, 'pinsFiles');
    // reasonChain reflects BOTH edge predicates, ordered by priority
    assert.deepEqual(cluster.reasonChain, ['pinsFiles', 'ruleId']);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — id-less input (F-014)
// ---------------------------------------------------------------------------

describe('Case 6: id-less input does not crash', () => {
  it('findings missing id get cluster-orphan-N defaults and cluster as usual', () => {
    const findings = [
      // No id — should get cluster-orphan-1
      { ruleId: 'no-stash', pinsFiles: ['src/a.ts'] },
      // No id — should get cluster-orphan-2; same ruleId merges with #1
      { ruleId: 'no-stash', pinsFiles: ['src/b.ts'] },
      // Empty-string id — should be replaced with cluster-orphan-3
      { id: '', ruleId: 'general', pinsFiles: ['src/c.ts'] },
    ];

    const manifest = runCli(findings);

    // The first two merge (shared non-general ruleId), the third is singleton
    assert.equal(manifest.clusters.length, 2);

    const merged = manifest.clusters.find((c) => c.members.length === 2);
    assert.ok(merged, 'expected a 2-member cluster from the shared ruleId');
    assert.deepEqual(merged.members.sort(), [
      'cluster-orphan-1',
      'cluster-orphan-2',
    ]);
    assert.equal(merged.reason, 'ruleId');

    const singleton = manifest.clusters.find((c) => c.members.length === 1);
    assert.ok(
      singleton,
      'expected a singleton cluster from the empty-id finding',
    );
    assert.deepEqual(singleton.members, ['cluster-orphan-3']);
    assert.equal(singleton.reason, 'singleton');
  });

  it('non-string id (number) is replaced with cluster-orphan-N', () => {
    const findings = [{ id: 42, ruleId: 'general', pinsFiles: ['src/x.ts'] }];

    const manifest = runCli(findings);

    assert.equal(manifest.clusters.length, 1);
    assert.deepEqual(manifest.clusters[0].members, ['cluster-orphan-1']);
  });
});

// ---------------------------------------------------------------------------
// Case 7 — pipe-in-id no longer collides (F-008)
// ---------------------------------------------------------------------------

describe('Case 7: pipe-in-id does not cause clusterId collisions', () => {
  it('a finding whose id contains "|" clusters correctly with a distinct hash', () => {
    // Old hash join used members.sort().join('|'), so { 'A|B', 'C' } and
    // { 'A', 'B|C' } would both hash the string 'A|B|C'. We assert the new
    // JSON.stringify joiner gives them DIFFERENT clusterIds.
    const setOne = [
      { id: 'A|B', ruleId: 'general', pinsFiles: ['src/p.ts'] },
      { id: 'C', ruleId: 'general', pinsFiles: ['src/p.ts'] },
    ];
    const setTwo = [
      { id: 'A', ruleId: 'general', pinsFiles: ['src/q.ts'] },
      { id: 'B|C', ruleId: 'general', pinsFiles: ['src/q.ts'] },
    ];

    const m1 = runCli(setOne);
    const m2 = runCli(setTwo);

    assert.equal(m1.clusters.length, 1);
    assert.equal(m2.clusters.length, 1);
    assert.notEqual(
      m1.clusters[0].clusterId,
      m2.clusters[0].clusterId,
      'pipe-in-id must not collide with naturally-pipe-joined member arrays',
    );
    // Both clusters still cluster the pair correctly
    assert.deepEqual(m1.clusters[0].members.sort(), ['A|B', 'C']);
    assert.deepEqual(m2.clusters[0].members.sort(), ['A', 'B|C']);
  });

  it('clusterId remains deterministic for inputs containing pipe characters', () => {
    const findings = [
      { id: 'F|piped', ruleId: 'no-stash', pinsFiles: ['src/x.ts'] },
      { id: 'F-normal', ruleId: 'no-stash', pinsFiles: ['src/y.ts'] },
    ];

    const r1 = runCli(findings);
    const r2 = runCli(findings);
    assert.equal(r1.clusters[0].clusterId, r2.clusters[0].clusterId);
  });
});
