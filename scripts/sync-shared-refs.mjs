#!/usr/bin/env node

/**
 * sync-shared-refs.mjs — keep per-skill mirrors of shared reference files in lock-step
 * with their canonical copies. Markdown reference content lives under
 * packages/skills/references/; executable assets (bash helpers, jq programs)
 * live under packages/skills/scripts/ per the Claude Code skills convention
 * (the runtime variable ${CLAUDE_SKILL_DIR} resolves to the skill directory,
 * and scripts/ is where Claude Code expects executable-style assets).
 *
 * Why mirrors instead of cross-skill ../../ links?
 *   A skill installed standalone (without the rest of the plugin) must work
 *   without reaching outside its own folder. By co-locating shared assets
 *   inside each consuming skill (scripts/ for executable, references/ for
 *   markdown), every skill becomes a self-contained unit that can be
 *   vendored individually.
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
const CANONICAL_REFERENCES = join(PKG_ROOT, 'references');
const CANONICAL_SCRIPTS = join(PKG_ROOT, 'scripts');
const SKILLS_DIR = join(PKG_ROOT, 'skills');

/**
 * Each entry: which canonical file is mirrored into which skills' subdir.
 *
 *   - `kind: 'reference'` (default) — markdown reference content; canonical
 *     source is packages/skills/references/, mirrored into <skill>/references/.
 *   - `kind: 'script'` — executable asset (bash, jq, mjs); canonical source
 *     is packages/skills/scripts/, mirrored into <skill>/scripts/. Honours
 *     Claude Code's `${CLAUDE_SKILL_DIR}/scripts/...` convention.
 *
 * Add a new row when a new skill starts depending on a shared asset.
 */
const MIRRORS = [
  {
    kind: 'reference',
    src: 'workflow-schema.md',
    consumers: [
      'brainstorming',
      'code-review',
      'execute-task',
      'feature-acceptance',
      'generate-prd',
      'generate-task',
      'orchestrate-task-delivery',
      'receiving-code-review',
      'update-docs',
      'write-tests',
      // 'test-driven-development' deleted in the receiving-code-review redesign
    ],
  },
  {
    kind: 'reference',
    src: 'subagent-preamble.md',
    consumers: [
      'code-review',
      'execute-task',
      'generate-task',
      'orchestrate-task-delivery',
      'receiving-code-review',
      'update-docs',
      'write-tests',
    ],
  },
  {
    kind: 'script',
    // Shared shell helpers for workflow.json mutations. Mirrored to every
    // skill that mutates workflow.json so each skill can `source
    // ${CLAUDE_SKILL_DIR}/scripts/jq-helpers.sh` without reaching outside its
    // own folder. Adding a new consumer? Append it here.
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
      'receiving-code-review',
      'update-docs',
      'write-tests',
    ],
  },
  // Renderers — only mirrored to the skill that owns the matching
  // review-mode flow. Each .jq is invoked via `jq -f scripts/renderers/<name>.jq`.
  {
    kind: 'script',
    src: 'renderers/brainstorm.jq',
    consumers: ['brainstorming'],
  },
  { kind: 'script', src: 'renderers/prd.jq', consumers: ['generate-prd'] },
  {
    kind: 'script',
    src: 'renderers/tasks-manifest.jq',
    consumers: ['generate-task'],
  },
  { kind: 'script', src: 'renderers/task.jq', consumers: ['generate-task'] },
  {
    kind: 'script',
    src: 'renderers/code-review.jq',
    consumers: ['code-review'],
  },
  {
    kind: 'script',
    src: 'renderers/receiving-code-review.jq',
    consumers: ['receiving-code-review'],
  },
  {
    kind: 'script',
    src: 'renderers/update-docs.jq',
    consumers: ['update-docs'],
  },
  {
    kind: 'script',
    src: 'renderers/feature-acceptance.jq',
    consumers: ['feature-acceptance'],
  },
  { kind: 'script', src: 'renderers/commit.jq', consumers: ['commit'] },
];

function rootFor(kind) {
  return kind === 'script' ? CANONICAL_SCRIPTS : CANONICAL_REFERENCES;
}
function subdirFor(kind) {
  return kind === 'script' ? 'scripts' : 'references';
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const checkMode = process.argv.includes('--check');
let drift = 0;
let synced = 0;

for (const { kind = 'reference', src, consumers } of MIRRORS) {
  const canonicalPath = join(rootFor(kind), src);
  const subdir = subdirFor(kind);
  let canonicalBuf;
  try {
    canonicalBuf = readFileSync(canonicalPath);
  } catch (err) {
    console.error(`✗ canonical missing: ${canonicalPath}`);
    drift += 1;
    continue;
  }

  for (const skill of consumers) {
    const targetPath = join(SKILLS_DIR, skill, subdir, src);
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
      console.error(`✗ drift: ${skill}/${subdir}/${src}`);
      drift += 1;
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, canonicalBuf);
    synced += 1;
    console.log(`  → ${skill}/${subdir}/${src}`);
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
