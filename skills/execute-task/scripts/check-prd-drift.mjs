#!/usr/bin/env node
/**
 * check-prd-drift.mjs — audit helper. Verifies that every TASK_NN.md (and
 * its `.completed.md` / `.failed.md` siblings) carries a `prdSha:` whose
 * value matches the current `git hash-object` of the feature's PRD.md.
 *
 * Usage:
 *   node check-prd-drift.mjs <featureId>
 *
 * Exit:
 *   0 — every task's prdSha matches PRD.md and EXPLORATION.md
 *   1 — at least one task drifted; details printed to stderr
 *   2 — usage error / missing files
 *
 * The skill body in `SKILL.md` runs the equivalent of this script
 * inline as a preflight; this standalone is for operator audits and
 * CI gates that want a single exit-code signal.
 *
 * Pure Node — no npm dependencies. Shells out to `git`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , featureId] = process.argv;
if (!featureId || !/^feat-[0-9]{8}-[a-z0-9-]+$/.test(featureId)) {
  console.error('Usage: check-prd-drift.mjs <featureId>');
  console.error('featureId must match ^feat-[0-9]{8}-[a-z0-9-]+$');
  process.exit(2);
}

const featDir = join('docs', 'browzer', featureId);
const prdPath = join(featDir, 'PRD.md');
const explPath = join(featDir, 'EXPLORATION.md');

if (!existsSync(prdPath)) {
  console.error(`check-prd-drift: PRD.md not found at ${prdPath}`);
  process.exit(2);
}

const prdSha = gitHashObject(prdPath);
const explSha = existsSync(explPath) ? extractPrdSha(explPath) : null;

const TASK_RE = /^TASK_[0-9]{2}(\.completed|\.failed)?\.md$/;
const taskFiles = readdirSync(featDir)
  .filter((n) => TASK_RE.test(n))
  .sort();

if (taskFiles.length === 0) {
  console.error(`check-prd-drift: no TASK_*.md files in ${featDir}`);
  process.exit(2);
}

const drifted = [];
for (const file of taskFiles) {
  const sha = extractPrdSha(join(featDir, file));
  if (sha !== prdSha) {
    drifted.push({ file, expected: prdSha, actual: sha || '(missing)' });
  }
}

const explDrift = explSha !== null && explSha !== prdSha;

if (drifted.length === 0 && !explDrift) {
  const explNote =
    explSha === null ? 'no EXPLORATION.md' : 'EXPLORATION.md match';
  console.log(
    `check-prd-drift: ok — ${taskFiles.length} task file(s) (${explNote}) match PRD.md (${prdSha}).`,
  );
  process.exit(0);
}

console.error(`check-prd-drift: drift detected against PRD.md=${prdSha}`);
if (explDrift) {
  console.error(`  EXPLORATION.md: prdSha=${explSha}`);
}
for (const d of drifted) {
  console.error(`  ${d.file}: prdSha=${d.actual} (expected ${d.expected})`);
}
console.error('');
console.error(
  'Re-run /scope-feature <featureId> followed by /generate-task <featureId> to refresh.',
);
process.exit(1);

// ───────────────────────────── helpers ────────────────────────────

function gitHashObject(path) {
  const r = spawnSync('git', ['hash-object', path], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`check-prd-drift: git hash-object ${path} failed`);
    process.exit(2);
  }
  return r.stdout.trim();
}

function extractPrdSha(path) {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/m);
  if (!m) return null;
  const fm = m[1];
  const sha = fm.match(/^prdSha:\s*([0-9a-f]{40})\s*$/m);
  return sha ? sha[1] : null;
}
