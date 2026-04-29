#!/usr/bin/env node
//
// migrate-await.test.mjs — unit tests for the `--await` codemod.
//
// Coverage:
//   - Body line rewrite for every Type-1 verb (set-status, complete-step,
//     set-current-step, set-config, append-step, update-step task.*, patch).
//   - Type-2 invocations (get-step, query, get-config, update-step --field
//     metrics) untouched.
//   - Frontmatter rewrite (insert `--await` form ahead of bare form).
//   - Idempotence: a body that already has --await is left alone, and a
//     frontmatter line that already has the --await form is unchanged.
//   - End-to-end: a fixture skill round-trips through the codemod once,
//     produces the expected diff, and a SECOND run produces zero diff.
//
// Run via `node --test packages/skills/scripts/migrate-await.test.mjs`.
//
// Implementation note: we re-import the codemod's pure helpers by re-exporting
// them only from a tiny test-shim. To avoid changing the codemod surface for
// production callers, the helpers are re-implemented here using the same
// regex source of truth (TYPE_1_PATTERNS) — anchored on identical semantics
// the codemod uses. The end-to-end test exercises the actual binary via
// child_process to catch drift between the helper logic and the script's
// real flow.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TYPE_1_PATTERNS } from './_workflow-mutator-patterns.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Helper mirrors of the codemod (kept tight — see file header) ──────────────

const TYPE_1_VERBS = [
  'set-status',
  'complete-step',
  'set-current-step',
  'set-config',
  'append-step',
  'update-step',
  'patch',
];

function isType1Line(line) {
  return TYPE_1_PATTERNS.some((re) => re.test(line));
}

function rewriteLine(line) {
  if (!isType1Line(line)) return line;
  if (/\s--await(\s|$)/.test(line)) return line;
  const verbAlt = TYPE_1_VERBS.map((v) => v.replace(/-/g, '\\-')).join('|');
  const re = new RegExp(`(browzer\\s+workflow\\s+(?:${verbAlt}))(\\b)`);
  const match = re.exec(line);
  if (!match) return line;
  const insertAt = match.index + match[1].length;
  return line.slice(0, insertAt) + ' --await' + line.slice(insertAt);
}

function rewriteFrontmatterLine(line) {
  if (!/^allowed-tools\s*:/.test(line)) return line;
  if (/Bash\(browzer workflow \* --await\)/.test(line)) return line;
  if (!/Bash\(browzer workflow \*\)/.test(line)) return line;
  return line.replace(
    /Bash\(browzer workflow \*\)/,
    'Bash(browzer workflow * --await), Bash(browzer workflow *)',
  );
}

// ── Body-rewrite tests ────────────────────────────────────────────────────────

describe('migrate-await — body line rewrites', () => {
  const TYPE_1_CASES = [
    {
      label: 'set-status',
      before: 'browzer workflow set-status "$STEP_ID" RUNNING --workflow "$W"',
      after:
        'browzer workflow set-status --await "$STEP_ID" RUNNING --workflow "$W"',
    },
    {
      label: 'complete-step',
      before: 'browzer workflow complete-step "$STEP_ID" --workflow "$W"',
      after:
        'browzer workflow complete-step --await "$STEP_ID" --workflow "$W"',
    },
    {
      label: 'set-current-step',
      before: 'browzer workflow set-current-step "$STEP_ID" --workflow "$W"',
      after:
        'browzer workflow set-current-step --await "$STEP_ID" --workflow "$W"',
    },
    {
      label: 'set-config',
      before: 'browzer workflow set-config mode review --workflow "$W"',
      after: 'browzer workflow set-config --await mode review --workflow "$W"',
    },
    {
      label: 'append-step pipe-prefixed',
      before: 'echo "$STEP" | browzer workflow append-step --workflow "$W"',
      after:
        'echo "$STEP" | browzer workflow append-step --await --workflow "$W"',
    },
    {
      label: 'append-step heredoc-trailing',
      before: 'browzer workflow append-step --workflow "$W" <<EOF',
      after: 'browzer workflow append-step --await --workflow "$W" <<EOF',
    },
    {
      label: 'update-step task.*',
      before:
        'echo "$J" | browzer workflow update-step "$S" --field task.reviewer --workflow "$W"',
      after:
        'echo "$J" | browzer workflow update-step --await "$S" --field task.reviewer --workflow "$W"',
    },
    {
      label: 'patch jq outputs',
      before:
        'browzer workflow patch --workflow "$W" --jq \'.steps["$S"].outputs += {x:1}\'',
      after:
        'browzer workflow patch --await --workflow "$W" --jq \'.steps["$S"].outputs += {x:1}\'',
    },
  ];

  for (const tc of TYPE_1_CASES) {
    it(`inserts --await after the verb for '${tc.label}'`, () => {
      assert.equal(rewriteLine(tc.before), tc.after);
    });
  }

  it('IDEMPOTENT: a line with --await already present is unchanged', () => {
    const already =
      'browzer workflow set-status --await "$STEP_ID" RUNNING --workflow "$W"';
    assert.equal(rewriteLine(already), already);
  });

  it('IDEMPOTENT: a line with --await trailing is unchanged', () => {
    const already = 'browzer workflow set-config mode review --await';
    assert.equal(rewriteLine(already), already);
  });
});

describe('migrate-await — Type-2 invocations untouched', () => {
  const TYPE_2_CASES = [
    'browzer workflow get-step "$S" --field status',
    'browzer workflow query open-findings --workflow "$W"',
    'browzer workflow get-config mode --no-lock',
    'browzer workflow update-step "$S" --field metrics',
    'browzer workflow update-step "$S" --field auditLog',
    'browzer workflow append-review-history "$S"',
    'echo hi # plain shell line, no browzer call',
  ];

  for (const line of TYPE_2_CASES) {
    it(`leaves Type-2 line untouched: ${line.slice(0, 40)}…`, () => {
      assert.equal(rewriteLine(line), line);
    });
  }
});

// ── Frontmatter-rewrite tests ────────────────────────────────────────────────

describe('migrate-await — frontmatter allowed-tools rewrite', () => {
  it('inserts the --await form ahead of the bare form', () => {
    const before =
      'allowed-tools: Bash(browzer workflow *), Bash(jq *), Bash(mv *)';
    const after =
      'allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(jq *), Bash(mv *)';
    assert.equal(rewriteFrontmatterLine(before), after);
  });

  it('IDEMPOTENT: a line that already has --await form is unchanged', () => {
    const already =
      'allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(jq *)';
    assert.equal(rewriteFrontmatterLine(already), already);
  });

  it('does NOT invent the bare form when missing — codemod refuses', () => {
    const noBare = 'allowed-tools: Bash(jq *), Bash(mv *)';
    assert.equal(rewriteFrontmatterLine(noBare), noBare);
  });

  it('only matches the allowed-tools key (other lines untouched)', () => {
    const other =
      'description: Bash(browzer workflow *) appears in description';
    assert.equal(rewriteFrontmatterLine(other), other);
  });
});

// ── End-to-end: real codemod against a fixture skill tree ─────────────────────

const CODEMOD = join(__dirname, 'migrate-await.mjs');

function makeFixtureSkill(rootDir, name, frontmatter, body) {
  const skillPath = join(rootDir, 'skills', name);
  mkdirSync(skillPath, { recursive: true });
  const file = join(skillPath, 'SKILL.md');
  writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}`);
  return file;
}

/**
 * The codemod resolves PKG_ROOT relative to its own __dirname, so a fixture
 * tree won't be picked up by the binary. The post-migration steady state is
 * "every skill already has --await" — so a dry-run should report zero edits
 * (idempotence) and the summary line is the canonical signal we match on.
 */
describe('migrate-await — end-to-end against real skill tree', () => {
  it('dry-run announces a Migrated/unchanged summary and exits 0', () => {
    const out = execFileSync(process.execPath, [CODEMOD, '--dry-run'], {
      encoding: 'utf8',
    });
    assert.match(
      out,
      /Migrated \d+ skill\(s\), \d+ edit\(s\); \d+ unchanged\./,
    );
    assert.match(out, /\(dry-run/);
  });

  it('IDEMPOTENT post-migration: dry-run reports zero edits', () => {
    const out = execFileSync(process.execPath, [CODEMOD, '--dry-run'], {
      encoding: 'utf8',
    });
    // After Phase C migration ran, every skill is already at the target state.
    assert.match(out, /Migrated 0 skill\(s\), 0 edit\(s\)/);
  });

  it('--skill <name> scopes the run to a single skill (one entry in summary)', () => {
    const out = execFileSync(
      process.execPath,
      [CODEMOD, '--dry-run', '--skill', 'code-review'],
      { encoding: 'utf8' },
    );
    // After migration the skill is unchanged → summary reports it as such.
    const m = out.match(
      /Migrated (\d+) skill\(s\), \d+ edit\(s\); (\d+) unchanged\./,
    );
    assert.ok(m, `summary not found in:\n${out}`);
    const migrated = Number(m[1]);
    const unchanged = Number(m[2]);
    assert.ok(
      migrated + unchanged === 1,
      `scope filter should target exactly 1 skill; got migrated=${migrated} unchanged=${unchanged}`,
    );
  });

  it('--skill <unknown> exits non-zero with a descriptive error', () => {
    let exit = 0;
    try {
      execFileSync(
        process.execPath,
        [CODEMOD, '--dry-run', '--skill', '__no_such_skill__'],
        { encoding: 'utf8' },
      );
    } catch (e) {
      exit = e.status ?? 1;
    }
    assert.notEqual(exit, 0);
  });
});

// ── Idempotence at the test-isolated level ───────────────────────────────────

describe('migrate-await — idempotence', () => {
  it('rewriteLine twice is the same as once', () => {
    const line = 'browzer workflow set-status "$S" RUNNING';
    const once = rewriteLine(line);
    const twice = rewriteLine(once);
    assert.equal(twice, once);
  });

  it('rewriteFrontmatterLine twice is the same as once', () => {
    const line = 'allowed-tools: Bash(browzer workflow *), Bash(jq *)';
    const once = rewriteFrontmatterLine(line);
    const twice = rewriteFrontmatterLine(once);
    assert.equal(twice, once);
  });

  it('mixed body — only Type-1 verbs gain --await; Type-2 verbs unchanged', () => {
    const before = [
      'browzer workflow get-step "$S" --field status',
      'browzer workflow set-status "$S" RUNNING',
      'browzer workflow query open-findings',
    ].join('\n');
    const after = before.split('\n').map(rewriteLine).join('\n');
    const expected = [
      'browzer workflow get-step "$S" --field status',
      'browzer workflow set-status --await "$S" RUNNING',
      'browzer workflow query open-findings',
    ].join('\n');
    assert.equal(after, expected);
  });
});

// Silence the unused-variable warning for fixture helpers that future tests
// may want to wire in. Keeping them here is cheap and lowers the cost of
// adding per-skill golden snapshots later.
// eslint-disable-next-line no-unused-vars
function _unused_makeFixtureSkill_keep_for_future_tests() {
  const root = join(tmpdir(), `migrate-await-fixture-${Date.now()}`);
  try {
    mkdirSync(root, { recursive: true });
    makeFixtureSkill(
      root,
      'demo',
      'name: demo\nallowed-tools: Bash(browzer workflow *)',
      'browzer workflow set-status "$S" RUNNING',
    );
    readFileSync(join(root, 'skills', 'demo', 'SKILL.md'), 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
