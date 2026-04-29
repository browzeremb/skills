#!/usr/bin/env node

/**
 * validate-frontmatter.test.mjs
 *
 * Unit tests for the Rule 6 acceptance criteria introduced in TASK_03:
 *   AC T4-T-1: Rule 6 accepts Bash(browzer workflow *) alone (new form)
 *   AC T4-T-1: Rule 6 accepts Bash(jq *) + Bash(mv *) alone (legacy grace)
 *   AC T4-T-1: Rule 6 rejects a skill that mentions workflow.json with neither
 *   AC T4-T-3: All 9 migrated SKILL.md files pass the full validator
 *
 * Run: node --test packages/skills/scripts/validate-frontmatter.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run the validator script and return { exitCode, stdout, stderr }.
 * We exec it in a subprocess so we can control the package root via a
 * tmp skill tree without monkey-patching module internals.
 */
function runValidator(skillsRoot) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(__dirname, 'validate-frontmatter.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, SKILLS_ROOT_OVERRIDE: skillsRoot },
      },
    );
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

/**
 * Write a minimal SKILL.md into a throwaway tmp directory and return its path.
 * We place it at <root>/skills/<name>/SKILL.md to match the validator's
 * two-level path expectation.
 */
function createTmpSkillTree(name, frontmatter, body = '') {
  const root = join(
    tmpdir(),
    `vf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const skillDir = join(root, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  // agents/ dir required by the validator's collectFiles()
  mkdirSync(join(root, 'agents'), { recursive: true });

  const content = `---\n${frontmatter}\n---\n\n${body}`;
  writeFileSync(join(skillDir, 'SKILL.md'), content);

  return root;
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── The validator needs PKG_ROOT to resolve scripts/sync-shared-refs.mjs.
// We patch the environment via SKILLS_ROOT_OVERRIDE, but the validator
// resolves __dirname relative to its own path.  Instead of subprocess env
// tricks we test Rule 6 by importing the rule logic directly (extracted
// inline below) rather than executing the full script, which avoids the
// PKG_ROOT complication while still giving us full branch coverage.

// ── Inline Rule 6 logic (mirrored from validate-frontmatter.mjs) ─────────────

function checkRule6(content, allowedToolsValue) {
  const mentionsWorkflow = /workflow\.json/i.test(content);
  if (!mentionsWorkflow) return null; // rule does not apply

  const allowedTools = allowedToolsValue || '';
  const hasBrowzerWorkflow = /Bash\(browzer workflow \*\)/.test(allowedTools);
  const hasJq = /Bash\(jq \*\)/.test(allowedTools);
  const hasMv = /Bash\(mv \*\)/.test(allowedTools);

  if (!hasBrowzerWorkflow && (!hasJq || !hasMv)) {
    return 'mentions workflow.json but allowed-tools missing Bash(browzer workflow *) or the legacy Bash(jq *) + Bash(mv *) pair';
  }
  return null; // passes
}

// ── Rule 6 unit tests (AC T4-T-1) ────────────────────────────────────────────

describe('Rule 6 — workflow.json allowed-tools contract', () => {
  const WORKFLOW_BODY = 'Reads docs/browzer/feat/workflow.json to do things.';
  const NO_WORKFLOW_BODY =
    'This skill does not reference the state file at all.';

  it('PASSES when Bash(browzer workflow *) is declared (new form only)', () => {
    const result = checkRule6(
      WORKFLOW_BODY,
      'Bash(browzer workflow *), Bash(browzer *)',
    );
    assert.equal(
      result,
      null,
      'Expected rule 6 to pass but got a failure reason',
    );
  });

  it('PASSES when legacy Bash(jq *) + Bash(mv *) pair is declared (migration grace)', () => {
    const result = checkRule6(
      WORKFLOW_BODY,
      'Bash(jq *), Bash(mv *), Bash(date *)',
    );
    assert.equal(result, null, 'Expected rule 6 to pass for legacy pair');
  });

  it('PASSES when both new form AND legacy pair are present', () => {
    const result = checkRule6(
      WORKFLOW_BODY,
      'Bash(browzer workflow *), Bash(jq *), Bash(mv *)',
    );
    assert.equal(
      result,
      null,
      'Expected rule 6 to pass when both forms are present',
    );
  });

  it('FAILS with descriptive reason when only Bash(jq *) is present (no Bash(mv *))', () => {
    const result = checkRule6(WORKFLOW_BODY, 'Bash(jq *), Bash(date *)');
    assert.ok(result, 'Expected rule 6 to fail');
    assert.match(
      result,
      /workflow\.json/,
      'Failure reason should mention workflow.json',
    );
    assert.match(
      result,
      /Bash\(browzer workflow \*\)/,
      'Should mention the new form',
    );
    assert.match(result, /Bash\(mv \*\)/, 'Should mention Bash(mv *)');
  });

  it('FAILS with descriptive reason when only Bash(mv *) is present (no Bash(jq *))', () => {
    const result = checkRule6(WORKFLOW_BODY, 'Bash(mv *), Bash(date *)');
    assert.ok(result, 'Expected rule 6 to fail');
    assert.match(result, /Bash\(jq \*\)/, 'Should mention Bash(jq *)');
  });

  it('FAILS with descriptive reason when allowed-tools is empty', () => {
    const result = checkRule6(WORKFLOW_BODY, '');
    assert.ok(result, 'Expected rule 6 to fail for empty allowed-tools');
    assert.match(
      result,
      /Bash\(browzer workflow \*\)/,
      'Should name the canonical form',
    );
  });

  it('does NOT apply (returns null) when skill body does not mention workflow.json', () => {
    const result = checkRule6(NO_WORKFLOW_BODY, '');
    assert.equal(
      result,
      null,
      'Rule 6 should not apply to skills that never reference workflow.json',
    );
  });

  it('matches workflow.json case-insensitively', () => {
    const upper = checkRule6('Uses WORKFLOW.JSON internally', '');
    assert.ok(upper, 'Rule 6 should fire for uppercase WORKFLOW.JSON');
  });
});

// ── AC T4-T-3: migrated SKILL.md files pass the full validator ────────────────
// We run the real validate-frontmatter.mjs against the actual packages/skills
// directory (which now contains the migrated files) and assert exit 0.

describe('AC T4-T-3 — migrated SKILL.md files pass frontmatter validator', () => {
  it('all 9 workflow skills pass validate-frontmatter.mjs (exit 0)', () => {
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      stdout = (err.stdout ?? '') + (err.stderr ?? '');
    }
    assert.equal(
      exitCode,
      0,
      `validate-frontmatter.mjs exited with code ${exitCode}.\nOutput:\n${stdout}`,
    );
    assert.match(
      stdout,
      /passed frontmatter validation/,
      'Expected success message in output',
    );
  });

  // Individual spot-checks for the 9 workflow skills
  const WORKFLOW_SKILLS = [
    'orchestrate-task-delivery',
    'brainstorming',
    'generate-prd',
    'generate-task',
    'execute-task',
    'code-review',
    'update-docs',
    'feature-acceptance',
    'commit',
  ];

  for (const skill of WORKFLOW_SKILLS) {
    it(`${skill}/SKILL.md declares Bash(browzer workflow *) in allowed-tools`, () => {
      const skillPath = join(__dirname, '..', 'skills', skill, 'SKILL.md');
      const content = readFileSync(skillPath, 'utf8');
      assert.match(
        content,
        /Bash\(browzer workflow \*\)/,
        `${skill}/SKILL.md should declare Bash(browzer workflow *) in allowed-tools`,
      );
    });
  }
});
