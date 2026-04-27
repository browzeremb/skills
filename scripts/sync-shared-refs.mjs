#!/usr/bin/env node

/**
 * sync-shared-refs.mjs — keep per-skill mirrors of shared reference files in lock-step
 * with the canonical copies under packages/skills/references/.
 *
 * Why mirrors instead of cross-skill ../../ links?
 *   A skill installed standalone (without the rest of the plugin) must work without
 *   reaching outside its own folder. By co-locating the shared schema/preamble
 *   inside each consuming skill's references/ directory, every skill becomes a
 *   self-contained unit that can be vendored individually.
 *
 * Why mirrors instead of inlined copies authored by hand?
 *   One canonical file. The mirror is byte-for-byte identical and is generated
 *   from the canonical copy. validate-frontmatter.mjs asserts SHA256 matches; if
 *   a maintainer edits a mirror by hand, CI fails.
 *
 * Modes:
 *   sync-shared-refs.mjs            → write all mirrors (default)
 *   sync-shared-refs.mjs --check    → assert mirrors are in sync; exit 1 if any drift
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(here, '..');
const CANONICAL = join(PKG_ROOT, 'references');
const SKILLS_DIR = join(PKG_ROOT, 'skills');

/**
 * Each entry: which canonical file is mirrored into which skills' references/ dir.
 * Add a new row when a new skill starts depending on a shared ref.
 */
const MIRRORS = [
  {
    src: 'workflow-schema.md',
    consumers: [
      'brainstorming',
      'code-review',
      'execute-task',
      'feature-acceptance',
      'generate-prd',
      'generate-task',
      'orchestrate-task-delivery',
      'test-driven-development',
      'update-docs',
      'write-tests',
    ],
  },
  {
    src: 'subagent-preamble.md',
    consumers: [
      'code-review',
      'execute-task',
      'generate-task',
      'orchestrate-task-delivery',
      'update-docs',
      'write-tests',
    ],
  },
  {
    // Shared shell helpers for workflow.json mutations. Mirrored to
    // every skill that already mutates workflow.json so each skill
    // can `source references/jq-helpers.sh` without reaching outside
    // its own folder. Adding a new consumer? Append it here.
    src: 'jq-helpers.sh',
    consumers: [
      'brainstorming',
      'code-review',
      'commit',
      'execute-task',
      'feature-acceptance',
      'generate-prd',
      'generate-task',
      'orchestrate-task-delivery',
      'update-docs',
    ],
  },
  // Renderers — only mirrored to the skill that owns the matching review-mode flow.
  { src: 'renderers/brainstorm.jq', consumers: ['brainstorming'] },
  { src: 'renderers/prd.jq', consumers: ['generate-prd'] },
  { src: 'renderers/tasks-manifest.jq', consumers: ['generate-task'] },
  { src: 'renderers/task.jq', consumers: ['generate-task'] },
  { src: 'renderers/code-review.jq', consumers: ['code-review'] },
  {
    src: 'renderers/fix-findings.jq',
    consumers: ['orchestrate-task-delivery'],
  },
  { src: 'renderers/update-docs.jq', consumers: ['update-docs'] },
  { src: 'renderers/feature-acceptance.jq', consumers: ['feature-acceptance'] },
  { src: 'renderers/commit.jq', consumers: ['commit'] },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const checkMode = process.argv.includes('--check');
let drift = 0;
let synced = 0;

for (const { src, consumers } of MIRRORS) {
  const canonicalPath = join(CANONICAL, src);
  let canonicalBuf;
  try {
    canonicalBuf = readFileSync(canonicalPath);
  } catch (err) {
    console.error(`✗ canonical missing: ${canonicalPath}`);
    drift += 1;
    continue;
  }

  for (const skill of consumers) {
    const targetPath = join(SKILLS_DIR, skill, 'references', src);
    let mirrorBuf;
    try {
      mirrorBuf = readFileSync(targetPath);
    } catch {
      mirrorBuf = null;
    }

    if (mirrorBuf && sha(canonicalBuf) === sha(mirrorBuf)) {
      // Already in sync — no work required.
      continue;
    }

    if (checkMode) {
      console.error(`✗ drift: ${skill}/references/${src}`);
      drift += 1;
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, canonicalBuf);
    synced += 1;
    console.log(`  → ${skill}/references/${src}`);
  }
}

if (checkMode) {
  if (drift > 0) {
    console.error(
      `✗ ${drift} mirror(s) out of sync — run \`node packages/skills/scripts/sync-shared-refs.mjs\` to fix`,
    );
    process.exit(1);
  }
  console.log('✓ all shared-reference mirrors are in sync');
} else {
  console.log(`✓ synced ${synced} mirror(s)`);
}
