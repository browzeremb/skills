// Tests for expand-task-acs.mjs — slim vs legacy frontmatter detection and
// PRD.md resolution.
//
// Mutation-resistant principles applied:
//   - Boolean: assert acText is truthy/falsy explicitly (kills boolean mutants
//     on the `isLegacy` branch check)
//   - Boundary: test both acText="" (slim) and acText="..." (legacy) to kill
//     off-by-one on the trim().length > 0 check
//   - Return-value: assert output contains the expanded text verbatim (not
//     just "non-empty"), killing return-value swap mutants
//   - Conditional: missing-PRD exits 2 (not 0), killing conditional branch
//     on the prdPath falsy check

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'expand-task-acs.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'expand-task-acs-'));
}

function run(taskPath) {
  return spawnSync(process.execPath, [SCRIPT, taskPath], {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: path.dirname(taskPath),
  });
}

// Build a minimal valid PRD.md in the given directory.
function writePrd(dir, acEntries = [], frEntries = []) {
  const fm = {
    acceptanceCriteria: acEntries,
    functionalRequirements: frEntries,
  };
  const yaml = acEntries
    .map((a) => `  - id: ${a.id}\n    text: ${JSON.stringify(a.text)}`)
    .join('\n');
  const frYaml = frEntries
    .map((f) => `  - id: ${f.id}\n    text: ${JSON.stringify(f.text)}`)
    .join('\n');
  const content = [
    '---',
    'acceptanceCriteria:',
    yaml || '  []',
    'functionalRequirements:',
    frYaml || '  []',
    '---',
    '',
    '# PRD',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'PRD.md'), content, 'utf8');
}

// Build a TASK_NN.md with slim frontmatter (no acText on bindsTo).
function writeSlimTask(dir, name = 'TASK_01.md') {
  const content = [
    '---',
    'acceptanceCriteria:',
    '  - id: T-AC-01',
    '    bindsTo:',
    '      - acId: AC-01',
    '      - acId: AC-02',
    '---',
    '',
    '## Task body',
  ].join('\n');
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Build a TASK_NN.md with legacy frontmatter (acText already inlined).
function writeLegacyTask(dir, name = 'TASK_01.md') {
  const content = [
    '---',
    'acceptanceCriteria:',
    '  - id: T-AC-01',
    '    bindsTo:',
    '      - acId: AC-01',
    '        acText: "Inline legacy acceptance criteria text"',
    '---',
    '',
    '## Task body',
  ].join('\n');
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('expand-task-acs: slim frontmatter path', () => {
  it('resolves AC text from PRD.md and injects acText into output', () => {
    const dir = tmpDir();
    writePrd(dir, [
      { id: 'AC-01', text: 'System accepts JSON input' },
      { id: 'AC-02', text: 'System rejects invalid tokens' },
    ]);
    const taskPath = writeSlimTask(dir);
    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    // Return-value assertion: expanded text must appear verbatim, not just any output.
    assert.match(
      res.stdout,
      /System accepts JSON input/,
      'acText for AC-01 must appear in expanded output',
    );
    assert.match(
      res.stdout,
      /System rejects invalid tokens/,
      'acText for AC-02 must appear in expanded output',
    );

    // Boolean assertion: acText key must be present (truthy) in output.
    assert.match(
      res.stdout,
      /acText:/,
      'acText key must be in output frontmatter',
    );
  });

  it('handles exactly one AC with exactly one binding (boundary: index 0)', () => {
    const dir = tmpDir();
    writePrd(dir, [{ id: 'AC-01', text: 'Single criterion text' }]);
    const content = [
      '---',
      'acceptanceCriteria:',
      '  - id: T-AC-01',
      '    bindsTo:',
      '      - acId: AC-01',
      '---',
      '',
      '## Task',
    ].join('\n');
    const taskPath = path.join(dir, 'TASK_01.md');
    fs.writeFileSync(taskPath, content, 'utf8');

    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /Single criterion text/);
  });

  it('emits PRD_NOT_FOUND and exits non-zero when PRD.md is absent', () => {
    const dir = tmpDir();
    // No PRD.md written — only the slim task.
    const taskPath = writeSlimTask(dir);
    const res = run(taskPath);

    // Conditional mutant kill: must exit 2, not 0.
    assert.equal(res.status, 2, 'missing PRD.md must cause exit code 2, not 0');
    assert.match(
      res.stderr,
      /PRD_NOT_FOUND/,
      'stderr must contain PRD_NOT_FOUND sentinel',
    );
    // Return-value check: stdout must be empty on error path.
    assert.equal(
      res.stdout.trim(),
      '',
      'stdout must be empty on PRD_NOT_FOUND',
    );
  });
});

describe('expand-task-acs: legacy frontmatter path (pass-through)', () => {
  it('returns input unchanged when acText is already present', () => {
    const dir = tmpDir();
    // PRD is present but should NOT be consulted in legacy mode.
    writePrd(dir, [{ id: 'AC-01', text: 'Should not appear in output' }]);
    const taskPath = writeLegacyTask(dir);
    const originalContent = fs.readFileSync(taskPath, 'utf8');

    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    // Return-value assertion: output must be byte-identical to input (no expansion).
    assert.equal(
      res.stdout,
      originalContent,
      'legacy task must be echoed unchanged (byte-identity)',
    );

    // Negative boolean assertion: PRD AC text must NOT appear in output.
    assert.doesNotMatch(
      res.stdout,
      /Should not appear in output/,
      'PRD text must not appear when legacy acText is inline',
    );
  });

  it('treats empty-string acText as slim (boundary: trim().length === 0)', () => {
    const dir = tmpDir();
    writePrd(dir, [{ id: 'AC-01', text: 'Filled from PRD' }]);
    // acText is present but empty — should NOT trigger legacy path.
    const content = [
      '---',
      'acceptanceCriteria:',
      '  - id: T-AC-01',
      '    bindsTo:',
      '      - acId: AC-01',
      '        acText: ""',
      '---',
      '',
      '## Task',
    ].join('\n');
    const taskPath = path.join(dir, 'TASK_01.md');
    fs.writeFileSync(taskPath, content, 'utf8');

    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    // Empty acText is falsy after trim() — expand path must fire.
    assert.match(
      res.stdout,
      /Filled from PRD/,
      'empty acText must trigger expansion (not legacy pass-through)',
    );
  });
});

describe('expand-task-acs: F-012 — findPrdMd same-directory-only', () => {
  it('exits 2 with PRD_NOT_FOUND when PRD.md is absent from task dir (no upward walk)', () => {
    const root = tmpDir();
    const subdir = path.join(root, 'staging');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'PRD.md'),
      '---\nacceptanceCriteria: []\n---\n',
    );
    const taskPath = writeSlimTask(subdir);
    const res = run(taskPath);
    assert.equal(
      res.status,
      2,
      'must exit 2 when PRD.md is only in a parent dir, not sibling',
    );
    assert.match(
      res.stderr,
      /PRD_NOT_FOUND/,
      'stderr must contain PRD_NOT_FOUND sentinel',
    );
    assert.equal(res.stdout.trim(), '', 'stdout must be empty on error');
  });

  it('succeeds when PRD.md is in the same directory as the task file', () => {
    const dir = tmpDir();
    writePrd(dir, [{ id: 'AC-01', text: 'Sibling PRD criterion' }]);
    const taskPath = writeSlimTask(dir);
    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(
      res.stdout,
      /Sibling PRD criterion/,
      'sibling PRD.md must be found and expanded',
    );
  });
});

describe('expand-task-acs: F-013 — empty AC text warn + expand', () => {
  it('warns to stderr and includes empty acText in output when PRD AC text is empty string', () => {
    const dir = tmpDir();
    const prdContent = [
      '---',
      'acceptanceCriteria:',
      '  - id: AC-01',
      '    text: ""',
      'functionalRequirements: []',
      '---',
      '',
      '# PRD',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'PRD.md'), prdContent, 'utf8');
    const taskPath = writeSlimTask(dir);
    const res = run(taskPath);
    assert.equal(
      res.status,
      0,
      `must succeed even with empty AC text; stderr: ${res.stderr}`,
    );
    assert.match(
      res.stderr,
      /warning/,
      'must warn to stderr about empty AC text',
    );
    assert.match(res.stderr, /AC-01/, 'warning must name the offending AC id');
    assert.match(
      res.stdout,
      /acText:/,
      'acText key must appear in output even when empty',
    );
  });

  it('does not warn when PRD AC text is a non-empty string', () => {
    const dir = tmpDir();
    writePrd(dir, [{ id: 'AC-01', text: 'Non-empty text' }]);
    const taskPath = writeSlimTask(dir);
    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(
      res.stderr.trim(),
      '',
      'no warning should appear for non-empty AC text',
    );
    assert.match(res.stdout, /Non-empty text/);
  });
});

describe('expand-task-acs: no acceptanceCriteria (no-op path)', () => {
  it('echoes input unchanged when acceptanceCriteria is absent', () => {
    const dir = tmpDir();
    const content = [
      '---',
      'title: Some task',
      '---',
      '',
      '## No AC here',
    ].join('\n');
    const taskPath = path.join(dir, 'TASK_01.md');
    fs.writeFileSync(taskPath, content, 'utf8');

    const res = run(taskPath);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout, content, 'no-AC task must be echoed unchanged');
  });
});
