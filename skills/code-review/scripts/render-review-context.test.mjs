/**
 * render-review-context.test.mjs
 *
 * Covers the three diff modes:
 *   1. branch-with-commits   — HEAD ahead of merge-base; classic diff path.
 *   2. single-branch-untracked — HEAD == merge-base AND working tree has
 *      untracked files; working-tree mode + ls-files --others surface.
 *   3. single-branch-clean-tree — HEAD == merge-base AND no diff; should
 *      still succeed (logs are authoritative) and write REVIEW_CONTEXT.md
 *      with the workingTreeMode banner.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractSkillsFoundFromFrontmatter } from './render-review-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'render-review-context.mjs');
const FEAT_ID = 'feat-20260513-rrc-smoke';

function git(repo, args) {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'rrc-test-'));
  git(repo, ['init', '-q', '-b', 'main']);
  // Seed an initial commit so origin/HEAD resolution + merge-base have a base.
  writeFileSync(join(repo, 'README.md'), '# seed\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'seed']);
  // The script asks for `origin/HEAD` first; without an origin it falls back
  // to local `main`. That fallback is what we exercise.
  return repo;
}

function seedFeat(repo, taskBodies) {
  const featDir = join(repo, 'docs', 'browzer', FEAT_ID);
  const stagingDir = join(featDir, 'staging');
  // Six per-phase subfolders per the v6.0.0 staging layout.
  for (const sub of [
    'planning',
    'tasks',
    'review',
    'review-lanes',
    'fixes',
    'acceptance',
  ]) {
    mkdirSync(join(stagingDir, sub), { recursive: true });
  }
  // PRD lives at planning/PRD.md post-refactor. Track it so the script's
  // `git hash-object` drift check + merge-base machinery has something to
  // bite. (Real host repos gitignore staging/; this isolated test repo
  // deliberately tracks these files for assertion purposes.)
  writeFileSync(join(stagingDir, 'planning', 'PRD.md'), '# PRD\n', 'utf8');
  git(repo, ['add', `docs/browzer/${FEAT_ID}/staging/planning/PRD.md`]);
  git(repo, ['commit', '-q', '-m', 'add PRD']);
  // Caller-supplied bodies land in their per-phase subfolder. Naming
  // convention: keys starting with `TASK_` go to tasks/, EXPLORATION* to
  // planning/, everything else (CODE_REVIEW, REVIEW_CONTEXT, etc.) lands
  // in review/ unless the test passes a path-qualified key like
  // 'planning/USER_STORIES.md'.
  for (const [name, body] of Object.entries(taskBodies)) {
    const target = name.includes('/')
      ? join(stagingDir, name)
      : name.startsWith('TASK_')
        ? join(stagingDir, 'tasks', name)
        : name.startsWith('EXPLORATION')
          ? join(stagingDir, 'planning', name)
          : join(stagingDir, 'review', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
  }
  return { featDir, stagingDir };
}

function run(repo) {
  // The script's child `browzer deps` call will fail in CI without a workspace —
  // it's wrapped in `allowFail`, so we don't override it. The drift check
  // depends on `git hash-object PRD.md`; we keep PRD.md tracked above.
  const r = spawnSync(process.execPath, [SCRIPT, FEAT_ID], {
    cwd: repo,
    encoding: 'utf8',
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

const COMPLETED_TASK = (sha) => `---
taskId: TASK_01
prdSha: ${sha}
---
## Execution log

### Files modified

- src/foo.ts (+10/-2)

### Files created

- (none)

### Symbols changed

- (none)
`;

test('render-review-context: branch-with-commits mode resolves to merge-base diff', () => {
  const repo = initRepo();
  try {
    // Single-branch base: get current sha, then create feature commit
    git(repo, ['checkout', '-q', '-b', 'feat-branch']);
    const prdShaPlaceholder = git(repo, ['rev-parse', 'HEAD']); // tmp — overwritten below
    const { featDir, stagingDir } = seedFeat(repo, {});
    const prdPath = join(stagingDir, 'planning', 'PRD.md');
    const realPrdSha = spawnSync('git', ['hash-object', prdPath], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(stagingDir, 'tasks', 'TASK_01.completed.md'),
      COMPLETED_TASK(realPrdSha),
      'utf8',
    );
    // Now create a feature commit on src/foo.ts that diverges from main.
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'foo.ts'), 'export const a = 1;\n', 'utf8');
    git(repo, [
      'add',
      'src/foo.ts',
      `docs/browzer/${FEAT_ID}/staging/tasks/TASK_01.completed.md`,
    ]);
    git(repo, ['commit', '-q', '-m', 'feat: foo']);
    // Sanity: HEAD must be ahead of main.
    const headSha = git(repo, ['rev-parse', 'HEAD']);
    const mainSha = git(repo, ['rev-parse', 'main']);
    assert.notEqual(headSha, mainSha);

    const r = run(repo);
    assert.equal(r.exitCode, 0, `script failed: ${r.stderr}`);
    const out = readFileSync(
      join(stagingDir, 'review', 'REVIEW_CONTEXT.md'),
      'utf8',
    );
    assert.match(out, /Diff base: `[a-f0-9]+` \(merge-base with `main`\)/);
    assert.match(out, /src\/foo\.ts.*\+10\/-2/);
    // Should NOT be in workingTreeMode banner.
    assert.doesNotMatch(out, /single-branch mode/);
    void prdShaPlaceholder;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('render-review-context: single-branch-with-untracked surfaces ls-files --others', () => {
  const repo = initRepo();
  try {
    // Stay on main; HEAD == merge-base by definition.
    const { featDir, stagingDir } = seedFeat(repo, {});
    const prdPath = join(stagingDir, 'planning', 'PRD.md');
    const realPrdSha = spawnSync('git', ['hash-object', prdPath], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(stagingDir, 'tasks', 'TASK_01.completed.md'),
      COMPLETED_TASK(realPrdSha),
      'utf8',
    );
    // Drop an untracked file. This is the smoke-run scenario.
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'foo.ts'), 'export const a = 1;\n', 'utf8');
    // DO NOT git add — it stays untracked.

    const r = run(repo);
    assert.equal(r.exitCode, 0, `script failed: ${r.stderr}`);
    const out = readFileSync(
      join(stagingDir, 'review', 'REVIEW_CONTEXT.md'),
      'utf8',
    );
    assert.match(out, /single-branch mode/);
    // diffOnlyFiles must include the untracked file.
    assert.match(out, /diffOnlyFiles:[\s\S]*src\/foo\.ts/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('render-review-context: single-branch-clean-tree still produces REVIEW_CONTEXT.md', () => {
  const repo = initRepo();
  try {
    const { featDir, stagingDir } = seedFeat(repo, {});
    const prdPath = join(stagingDir, 'planning', 'PRD.md');
    const realPrdSha = spawnSync('git', ['hash-object', prdPath], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(stagingDir, 'tasks', 'TASK_01.completed.md'),
      COMPLETED_TASK(realPrdSha),
      'utf8',
    );
    // Commit the task so the working tree is genuinely clean — exercises the
    // HEAD == merge-base AND no untracked-files branch.
    git(repo, [
      'add',
      `docs/browzer/${FEAT_ID}/staging/tasks/TASK_01.completed.md`,
    ]);
    git(repo, ['commit', '-q', '-m', 'add task receipt']);

    const r = run(repo);
    assert.equal(r.exitCode, 0, `script failed: ${r.stderr}`);
    const out = readFileSync(
      join(stagingDir, 'review', 'REVIEW_CONTEXT.md'),
      'utf8',
    );
    assert.match(out, /single-branch mode/);
    // Execution logs remain authoritative — src/foo.ts is in changedFiles.
    assert.match(out, /src\/foo\.ts/);
    // Tree is clean → diffOnlyFiles must be empty.
    const fm = out.match(/^---\n([\s\S]*?)\n---/);
    assert(fm, 'frontmatter present');
    assert.match(fm[1], /diffOnlyFiles: \[\]/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('render-review-context: unions skillsFound[] from TASK_*.completed.md frontmatter (Lever C — replaces legacy EXPLORATION.md read)', () => {
  const repo = initRepo();
  try {
    const { featDir, stagingDir } = seedFeat(repo, {});
    const prdPath = join(stagingDir, 'planning', 'PRD.md');
    const realPrdSha = spawnSync('git', ['hash-object', prdPath], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    // TASK_01.completed.md carries skillsFound[] in its frontmatter
    // — `extractSkillsFoundFromTasks(stagingDir)` unions across every
    // tasks/TASK_*.completed.md (closure principle: EXPLORATION.md is no
    // longer consulted by code-review post-refactor).
    writeFileSync(
      join(stagingDir, 'tasks', 'TASK_01.completed.md'),
      `---
taskId: TASK_01
prdSha: ${realPrdSha}
skillsFound:
  - name: fastify-best-practices
    relevance: high
    installedAt: ~/.claude/skills/fastify-best-practices
  - name: grafana-dashboards
    relevance: medium
    installedAt: ~/.claude/skills/grafana-dashboards
---
## Execution log

### Files modified

- src/foo.ts (+10/-2)

### Files created

- (none)

### Symbols changed

- (none)
`,
      'utf8',
    );
    const r = run(repo);
    assert.equal(r.exitCode, 0, `script failed: ${r.stderr}`);
    const out = readFileSync(
      join(stagingDir, 'review', 'REVIEW_CONTEXT.md'),
      'utf8',
    );
    assert.match(out, /skillsFound:/);
    assert.match(out, /name: fastify-best-practices/);
    assert.match(out, /name: grafana-dashboards/);
    assert.match(out, /relevance: high/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('render-review-context: TASK_*.completed.md without skillsFound[] yields empty union', () => {
  const repo = initRepo();
  try {
    const { featDir, stagingDir } = seedFeat(repo, {});
    const prdPath = join(stagingDir, 'planning', 'PRD.md');
    const realPrdSha = spawnSync('git', ['hash-object', prdPath], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(stagingDir, 'tasks', 'TASK_01.completed.md'),
      COMPLETED_TASK(realPrdSha),
      'utf8',
    );
    // No skillsFound[] in TASK_01.completed.md frontmatter.
    const r = run(repo);
    assert.equal(r.exitCode, 0, `script failed: ${r.stderr}`);
    const out = readFileSync(
      join(stagingDir, 'review', 'REVIEW_CONTEXT.md'),
      'utf8',
    );
    assert.match(out, /skillsFound: \[\]/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Regression suite for RETRO §2.3 / JUDGMENT §3.13: skillsFound[] must
// propagate across every nesting shape. The previous regex-based parser
// silently dropped nested entries past the first domain.

test('skillsFound: extracts top-level single entry', () => {
  const fm = [
    'featureId: feat-20260513-x',
    'skillsFound:',
    '  - name: fastify-best-practices',
    '    relevance: high',
    '    installedAt: ~/.claude/skills/fastify-best-practices',
  ].join('\n');
  const out = extractSkillsFoundFromFrontmatter(fm);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'fastify-best-practices');
  assert.equal(out[0].relevance, 'high');
});

test('skillsFound: nested domains[].skillsFound[] — captures all entries across domains', () => {
  const fm = [
    'featureId: feat-20260513-x',
    'domains:',
    '  - name: backend',
    '    skillsFound:',
    '      - name: fastify-best-practices',
    '        relevance: high',
    '      - name: nodejs-backend-patterns',
    '        relevance: medium',
    '  - name: frontend',
    '    skillsFound:',
    '      - name: react-performance',
    '        relevance: high',
    '      - name: tailwind-design-system',
    '        relevance: low',
  ].join('\n');
  const out = extractSkillsFoundFromFrontmatter(fm);
  assert.equal(
    out.length,
    4,
    `expected 4 entries across 2 domains, got ${out.length}: ${JSON.stringify(out)}`,
  );
  const highRelevance = out
    .filter((e) => e.relevance === 'high')
    .map((e) => e.name)
    .sort();
  assert.deepEqual(
    highRelevance,
    ['fastify-best-practices', 'react-performance'],
    'both high-relevance domain skills must propagate',
  );
});

test('skillsFound: inline empty list yields zero entries', () => {
  const fm = ['featureId: feat-x', 'skillsFound: []'].join('\n');
  assert.deepEqual(extractSkillsFoundFromFrontmatter(fm), []);
});

test('skillsFound: absent skillsFound block yields zero entries', () => {
  const fm = ['featureId: feat-x', 'otherKey: value'].join('\n');
  assert.deepEqual(extractSkillsFoundFromFrontmatter(fm), []);
});

test('skillsFound: dedupes by name across mixed shapes — first occurrence wins', () => {
  const fm = [
    'featureId: feat-x',
    'skillsFound:',
    '  - name: shared-skill',
    '    relevance: high',
    'domains:',
    '  - name: cli',
    '    skillsFound:',
    '      - name: shared-skill',
    '        relevance: medium',
    '      - name: cli-only-skill',
    '        relevance: low',
  ].join('\n');
  const out = extractSkillsFoundFromFrontmatter(fm);
  assert.equal(out.length, 2);
  const shared = out.find((e) => e.name === 'shared-skill');
  assert.equal(
    shared.relevance,
    'high',
    'first declared block wins on duplicate names',
  );
});

test('skillsFound: unwraps double-quoted and single-quoted names', () => {
  const fm = [
    'featureId: feat-x',
    'skillsFound:',
    '  - name: "scoped-skill-name"',
    '    relevance: "high"',
    "  - name: 'another-skill'",
    "    relevance: 'medium'",
  ].join('\n');
  const out = extractSkillsFoundFromFrontmatter(fm);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'scoped-skill-name');
  assert.equal(out[0].relevance, 'high');
  assert.equal(out[1].name, 'another-skill');
  assert.equal(out[1].relevance, 'medium');
});

test('render-review-context: failed task halts before render', () => {
  const repo = initRepo();
  try {
    const { featDir, stagingDir } = seedFeat(repo, {});
    writeFileSync(
      join(stagingDir, 'tasks', 'TASK_01.failed.md'),
      '---\ntaskId: TASK_01\n---\n',
      'utf8',
    );
    const r = run(repo);
    assert.equal(r.exitCode, 3, 'should HALT with exit code 3');
    assert.doesNotMatch(r.stderr, /no TASK_\*.completed.md/);
    assert(!existsSync(join(stagingDir, 'review', 'REVIEW_CONTEXT.md')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
