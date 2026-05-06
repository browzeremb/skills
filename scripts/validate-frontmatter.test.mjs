#!/usr/bin/env node

/**
 * validate-frontmatter.test.mjs
 *
 * Unit tests for the surviving validator rules (Rules 9, 10, 11, 12). Rules 5
 * and 6 — and the per-skill `Bash(browzer workflow *)` declaration assertion
 * under AC T4-T-3 — were retired together with the `allowed-tools` frontmatter
 * field on 2026-05-06; this file no longer covers them.
 *
 * Run: node --test packages/skills/scripts/validate-frontmatter.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Rules 5 + 6 (allowed-tools presence + workflow.json mutator declaration +
// Type-1 `--await` token) were retired 2026-05-06 along with the
// `allowed-tools` frontmatter field itself; the inline rule logic and its
// describe blocks (formerly here, ~240 LOC) were deleted in the same change.

// ── Rule 9: warn-only when SKILL.md > 250 lines without ## References router ──
//
// Rule 9 does NOT push to failures[] — it writes to stderr only. So both
// branches (warn + no-warn) exit 0. We test by:
//   - Checking stderr for the warning pattern (warn case).
//   - Checking stderr is absent (pass case).
// We inline the rule logic to avoid subprocess complexity with PKG_ROOT.

function checkRule9(content, filePath) {
  const lineCount = content.split('\n').length;
  const hasReferencesRouter = /^## References router/m.test(content);
  if (lineCount > 250 && !hasReferencesRouter) {
    return `${filePath} exceeds 250 lines (${lineCount}) without ## References router — consider router conversion`;
  }
  return null; // no warning
}

function makeLongBody(lines, includeRouter) {
  // Build a body with exactly `lines` total lines (including frontmatter header).
  const fm = `---\nname: long-skill\ndescription: "A long skill for testing Rule 9."\nallowed-tools: Bash(browzer *)\n---\n\n`;
  const routerSection = includeRouter
    ? '## References router\n\nSee references/.\n\n'
    : '';
  const filler = Array.from(
    { length: lines },
    (_, i) => `Line ${i + 1} of filler content.`,
  ).join('\n');
  return fm + routerSection + filler;
}

describe('Rule 9 — warn-only for long skills without ## References router', () => {
  it('PASS: skill with >250 lines AND ## References router emits no warning', () => {
    const content = makeLongBody(260, true);
    const result = checkRule9(content, 'skills/long-skill/SKILL.md');
    assert.equal(
      result,
      null,
      'Expected no warning when ## References router is present',
    );
  });

  it('WARN: skill with >250 lines WITHOUT ## References router emits warning', () => {
    const content = makeLongBody(260, false);
    const result = checkRule9(content, 'skills/long-skill/SKILL.md');
    assert.ok(result, 'Expected a warning to be emitted');
    assert.match(result, /exceeds 250 lines/);
    assert.match(result, /References router/);
    assert.match(result, /consider router conversion/);
  });

  it('PASS: skill body that keeps total lines at or below 250 emits no warning', () => {
    // makeLongBody adds frontmatter overhead (~7 lines); use 0 filler lines to get a short file.
    const content = makeLongBody(0, false);
    const lineCount = content.split('\n').length;
    assert.ok(
      lineCount <= 250,
      `Expected content to be ≤250 lines, got ${lineCount}`,
    );
    const result = checkRule9(content, 'skills/long-skill/SKILL.md');
    assert.equal(
      result,
      null,
      'Expected no warning for a skill with ≤250 lines',
    );
  });

  it('PASS: skill with <250 lines without router emits no warning', () => {
    const content = makeLongBody(100, false);
    const result = checkRule9(content, 'skills/long-skill/SKILL.md');
    assert.equal(result, null, 'Expected no warning for short skill');
  });

  it('WARN: only fires on ## References router heading, not other occurrences of the phrase', () => {
    // Body mentions "References router" in prose but not as a heading
    const fm = `---\nname: almost-router\ndescription: "Almost."\nallowed-tools: Bash(browzer *)\n---\n\n`;
    const prose = `This skill uses a references router pattern internally.\n`;
    const filler = Array.from({ length: 260 }, (_, i) => `Line ${i}.`).join(
      '\n',
    );
    const content = fm + prose + filler;
    const result = checkRule9(content, 'skills/almost-router/SKILL.md');
    assert.ok(
      result,
      'Expected warning — prose mention does not satisfy the heading requirement',
    );
  });

  it('Rule 9 does not add to failures[] — validate-frontmatter exits 0 even when rule fires', () => {
    // Run the real validator against the actual packages/skills directory.
    // Rule 9 may emit warnings to stderr but must NOT change exit code.
    let exitCode = 0;
    let stdout = '';
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
      `validate-frontmatter.mjs must exit 0 even when Rule 9 warnings fire.\nOutput:\n${stdout}`,
    );
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

  // The per-skill `Bash(browzer workflow *)` declaration loop was retired
  // 2026-05-06 along with the `allowed-tools` frontmatter field; only the
  // exit-0 assertion above survives.
});

// ── Rule 10: mutates: cross-check vs workflow-v1.schema.json ─────────────────
//
// Tests:
//   test_rule10_invalid_path_rejected      — bad path → non-zero + rule10 error
//   test_rule10_missing_required_field_rejected — valid path, bad field → rule10 error
//   test_rule10_all_skills_pass            — real skills/ → exit 0
//   test_self_test_rule10                  — --self-test-rule-10 → exit 0

describe('Rule 10 — mutates: cross-check vs workflow-v1.schema.json', () => {
  /**
   * Helper: run the validator with SKILLS_ROOT_OVERRIDE pointing to a tmp tree
   * that contains a single skill with the given content.
   */
  function runValidatorWithSkill(name, frontmatterBody, body = '') {
    const root = join(
      tmpdir(),
      `rule10-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const skillDir = join(root, 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(root, 'agents'), { recursive: true });
    const content = `---\n${frontmatterBody}\n---\n\n${body}`;
    writeFileSync(join(skillDir, 'SKILL.md'), content);

    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, SKILLS_ROOT_OVERRIDE: root },
        },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { exitCode, output };
  }

  it('test_rule10_invalid_path_rejected: path not in schema → non-zero + rule10 error', () => {
    const fm = [
      'name: rule10-bad-path',
      'description: "test fixture"',
      'allowed-tools: Bash(browzer workflow *)',
      'mutates:',
      '  - path: steps[].does.not.exist',
      '    requires: []',
    ].join('\n');
    const { exitCode, output } = runValidatorWithSkill('rule10-bad-path', fm);
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.ok(
      output.includes('rule 10') || output.includes('rule10'),
      `Expected rule10 in output.\nGot: ${output}`,
    );
  });

  it('test_rule10_missing_required_field_rejected: valid path, unknown required field → rule10 error', () => {
    const fm = [
      'name: rule10-bad-field',
      'description: "test fixture"',
      'allowed-tools: Bash(browzer workflow *)',
      'mutates:',
      '  - path: steps[].prd',
      '    requires: [thisIsNotInSchema]',
    ].join('\n');
    const { exitCode, output } = runValidatorWithSkill('rule10-bad-field', fm);
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.ok(
      output.includes('rule 10') || output.includes('rule10'),
      `Expected rule10 in output.\nGot: ${output}`,
    );
  });

  it('test_rule10_all_skills_pass: real packages/skills/skills/ passes Rule 10 (exit 0)', () => {
    // The AC T4-T-3 suite already checks exit 0, but this test is explicit about
    // Rule 10 specifically — it runs the full validator and asserts no rule10 errors.
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    // Rule 10 must produce zero errors even if rule 7 (mirrors) fires.
    const rule10Errors = output
      .split('\n')
      .filter((l) => l.includes('rule 10') || l.includes('rule10'));
    assert.equal(
      rule10Errors.length,
      0,
      `Expected no rule10 errors.\nErrors found:\n${rule10Errors.join('\n')}\nFull output:\n${output}`,
    );
  });

  it('test_self_test_rule10: --self-test-rule-10 exits 0 (bad fixture correctly rejected + cleanup)', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs'), '--self-test-rule-10'],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    assert.equal(
      exitCode,
      0,
      `Expected --self-test-rule-10 to exit 0.\nOutput:\n${output}`,
    );
    assert.match(
      output,
      /self-test-rule-10 passed/,
      'Expected self-test success message in output',
    );
  });
});

// ── Rule 11: Bash-invocation hygiene ─────────────────────────────────────────
//
// Tests:
//   test_rule11_inline_comment_rejected  — inline # → non-zero + rule11 error
//   test_rule11_multi_step_rejected      — foo && bar && baz → non-zero
//   test_rule11_jq_capture_rejected      — $(jq … "$WORKFLOW") capture → non-zero + hint
//   test_rule11_all_skills_pass          — real skills/ → zero rule11 errors
//   test_self_test_rule11                — --self-test-rule-11 → exit 0

describe('Rule 11 — Bash-invocation hygiene in fenced bash blocks', () => {
  /**
   * Helper: run the validator with SKILLS_ROOT_OVERRIDE pointing to a tmp tree
   * containing a single skill with the given content.
   */
  function runValidatorWithSkill11(name, frontmatterBody, body = '') {
    const root = join(
      tmpdir(),
      `rule11-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const skillDir = join(root, 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(root, 'agents'), { recursive: true });
    const content = `---\n${frontmatterBody}\n---\n\n${body}`;
    writeFileSync(join(skillDir, 'SKILL.md'), content);

    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, SKILLS_ROOT_OVERRIDE: root },
        },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { exitCode, output };
  }

  it('test_rule11_inline_comment_rejected: inline # comment after command → non-zero + rule11 error', () => {
    const fm = [
      'name: rule11-inline-comment',
      'description: "test fixture for Rule 11a"',
      'allowed-tools: Bash(echo *)',
    ].join('\n');
    const body = ['```bash', 'echo foo # inline comment here', '```'].join(
      '\n',
    );
    const { exitCode, output } = runValidatorWithSkill11(
      'rule11-inline-comment',
      fm,
      body,
    );
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.ok(
      output.includes('rule11') || output.includes('rule 11'),
      `Expected rule11 in output.\nGot: ${output}`,
    );
    assert.ok(
      output.includes('inline'),
      `Expected "inline" in output.\nGot: ${output}`,
    );
  });

  it('test_rule11_multi_step_rejected: foo && bar && baz chain → non-zero exit', () => {
    const fm = [
      'name: rule11-multi-step',
      'description: "test fixture for Rule 11b"',
      'allowed-tools: Bash(foo *)',
    ].join('\n');
    const body = ['```bash', 'foo && bar && baz', '```'].join('\n');
    const { exitCode, output } = runValidatorWithSkill11(
      'rule11-multi-step',
      fm,
      body,
    );
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.ok(
      output.includes('rule11') || output.includes('rule 11'),
      `Expected rule11 in output.\nGot: ${output}`,
    );
  });

  it('test_rule11_jq_capture_rejected: $(jq … "$WORKFLOW") with downstream jq usage → non-zero + hint', () => {
    const fm = [
      'name: rule11-jq-capture',
      'description: "test fixture for Rule 11c"',
      'allowed-tools: Bash(jq *)',
    ].join('\n');
    const body = [
      '```bash',
      'STEPS=$(jq -r \'.steps[]\' "$WORKFLOW")',
      'echo "$STEPS" | jq \'.taskId\'',
      '```',
    ].join('\n');
    const { exitCode, output } = runValidatorWithSkill11(
      'rule11-jq-capture',
      fm,
      body,
    );
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.ok(
      output.includes('rule11') || output.includes('rule 11'),
      `Expected rule11 in output.\nGot: ${output}`,
    );
    assert.ok(
      output.includes('browzer workflow get-step'),
      `Expected hint citing browzer workflow get-step.\nGot: ${output}`,
    );
  });

  it('test_rule11_all_skills_pass: real packages/skills/skills/ produces zero rule11 errors', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    // Filter for only Rule 11 errors — pre-existing Rule 7 mirror drift is excluded.
    const rule11Errors = (output + '')
      .split('\n')
      .filter((l) => l.includes('rule 11') || l.includes('rule11'));
    assert.equal(
      rule11Errors.length,
      0,
      `Expected no rule11 errors.\nErrors found:\n${rule11Errors.join('\n')}\nFull output:\n${output}`,
    );
  });

  it('test_self_test_rule11: --self-test-rule-11 exits 0 (bad fixture correctly rejected + cleanup)', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs'), '--self-test-rule-11'],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    assert.equal(
      exitCode,
      0,
      `Expected --self-test-rule-11 to exit 0.\nOutput:\n${output}`,
    );
    assert.match(
      output,
      /self-test-rule-11 passed/,
      'Expected self-test success message in output',
    );
  });
});

// ── Rule 12: Persist/Append/Emit phase recipe + banned-diagnostics ──────────
//
// Tests:
//   test_rule12_missing_both_signals_rejected   — Persist heading, no recipe, no banned → non-zero + 2 rule12 errors
//   test_rule12_missing_recipe_only_rejected    — Persist heading, banned only → non-zero + 1 rule12 error
//   test_rule12_missing_banned_only_rejected    — Persist heading, recipe only → non-zero + 1 rule12 error
//   test_rule12_passes_with_both_signals        — Persist heading + recipe + banned → exit 0
//   test_rule12_skipped_without_persist_heading — no Persist heading → rule12 silent
//   test_rule12_accepts_each_mutator_recipe     — append-step | update-step | complete-step | patch each satisfy
//   test_rule12_all_skills_pass                 — real packages/skills/skills/ produces zero rule12 errors
//   test_self_test_rule12                       — --self-test-rule-12 → exit 0
//   test_self_test_alias                        — --self-test (no suffix) → exit 0

describe('Rule 12 — Persist/Append/Emit phase recipe + banned-diagnostics', () => {
  /**
   * Helper: run the validator with SKILLS_ROOT_OVERRIDE pointing to a tmp tree
   * containing a single skill with the given content.
   */
  function runValidatorWithSkill12(name, frontmatterBody, body = '') {
    const root = join(
      tmpdir(),
      `rule12-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const skillDir = join(root, 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(root, 'agents'), { recursive: true });
    const content = `---\n${frontmatterBody}\n---\n\n${body}`;
    writeFileSync(join(skillDir, 'SKILL.md'), content);

    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, SKILLS_ROOT_OVERRIDE: root },
        },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { exitCode, output };
  }

  const FM = [
    'name: rule12-skill',
    'description: "test fixture for Rule 12"',
    'allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *)',
  ].join('\n');

  const RECIPE_APPEND =
    '```bash\necho "$STEP_JSON" | browzer workflow append-step --await --workflow "$WORKFLOW"\n```';
  const BANNED_HEADING =
    '### Banned diagnostic patterns\n\nForbidden in production: `browzer workflow ... --help` and `browzer workflow describe-step-type`.';

  it('test_rule12_missing_both_signals_rejected: Persist heading, neither recipe nor banned → 2 rule12 errors', () => {
    const body = '## Phase 4 — Persist STEP_X\n\nWe persist somehow.';
    const { exitCode, output } = runValidatorWithSkill12(
      'rule12-skill',
      FM,
      body,
    );
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.match(
      output,
      /rule 12/,
      `Expected rule 12 in output.\nGot: ${output}`,
    );
    assert.match(output, /canonical mutator recipe/);
    assert.match(output, /Banned diagnostic patterns/);
  });

  it('test_rule12_missing_recipe_only_rejected: Persist heading, banned only → 1 rule12 error', () => {
    const body = `## Phase 4 — Persist STEP_X\n\n${BANNED_HEADING}`;
    const { exitCode, output } = runValidatorWithSkill12(
      'rule12-skill',
      FM,
      body,
    );
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.match(output, /canonical mutator recipe/);
  });

  it('test_rule12_missing_banned_only_rejected: Persist heading, recipe only → 1 rule12 error', () => {
    const body = `## Phase 4 — Persist STEP_X\n\n${RECIPE_APPEND}`;
    const { exitCode, output } = runValidatorWithSkill12(
      'rule12-skill',
      FM,
      body,
    );
    assert.ok(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    assert.match(output, /Banned diagnostic patterns/);
  });

  it('test_rule12_passes_with_both_signals: Persist heading + recipe + banned → exit 0', () => {
    const body = `## Phase 4 — Persist STEP_X\n\n${RECIPE_APPEND}\n\n${BANNED_HEADING}`;
    const { exitCode, output } = runValidatorWithSkill12(
      'rule12-skill',
      FM,
      body,
    );
    assert.equal(exitCode, 0, `Expected exit 0.\nOutput:\n${output}`);
  });

  it('test_rule12_skipped_without_persist_heading: no Persist heading → rule12 silent', () => {
    const body =
      '## Phase 4 — Aggregate and report\n\nNothing to persist here. No banned-diagnostics needed.';
    const { exitCode, output } = runValidatorWithSkill12(
      'rule12-skill',
      FM,
      body,
    );
    assert.equal(
      exitCode,
      0,
      `Expected exit 0 when no Persist heading present.\nOutput:\n${output}`,
    );
    assert.doesNotMatch(output, /rule 12/);
  });

  for (const [label, recipe] of [
    [
      'append-step',
      '```bash\necho "$STEP_JSON" | browzer workflow append-step --await --workflow "$WORKFLOW"\n```',
    ],
    [
      'update-step',
      '```bash\nbrowzer workflow update-step --await --workflow "$WORKFLOW" "$STEP_ID" --field foo\n```',
    ],
    [
      'complete-step',
      '```bash\nbrowzer workflow complete-step --await --workflow "$WORKFLOW" "$STEP_ID"\n```',
    ],
    [
      'patch',
      '```bash\nbrowzer workflow patch --await --workflow "$WORKFLOW" --jq \'.foo = 1\'\n```',
    ],
    [
      'patch (workflow before await)',
      '```bash\nbrowzer workflow patch --workflow "$WORKFLOW" --await --jq \'.foo = 1\'\n```',
    ],
  ]) {
    it(`test_rule12_accepts_each_mutator_recipe: ${label} satisfies the recipe signal`, () => {
      const body = `## Phase 4 — Persist STEP_X\n\n${recipe}\n\n${BANNED_HEADING}`;
      const { exitCode, output } = runValidatorWithSkill12(
        'rule12-skill',
        FM,
        body,
      );
      assert.equal(
        exitCode,
        0,
        `Expected exit 0 for ${label} recipe.\nOutput:\n${output}`,
      );
    });
  }

  it('test_rule12_all_skills_pass: real packages/skills/skills/ produces zero rule12 errors', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    const rule12Errors = (output + '')
      .split('\n')
      .filter((l) => l.includes('rule 12') || l.includes('rule12'));
    assert.equal(
      rule12Errors.length,
      0,
      `Expected no rule12 errors.\nErrors found:\n${rule12Errors.join('\n')}\nFull output:\n${output}`,
    );
  });

  it('test_self_test_rule12: --self-test-rule-12 exits 0 (bad fixture correctly rejected + cleanup)', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs'), '--self-test-rule-12'],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    assert.equal(
      exitCode,
      0,
      `Expected --self-test-rule-12 to exit 0.\nOutput:\n${output}`,
    );
    assert.match(
      output,
      /self-test-rule-12 passed/,
      'Expected self-test success message in output',
    );
  });

  it('test_self_test_alias: --self-test (alias) exits 0 (bad fixture correctly rejected + cleanup)', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs'), '--self-test'],
        { encoding: 'utf8' },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    assert.equal(
      exitCode,
      0,
      `Expected --self-test alias to exit 0.\nOutput:\n${output}`,
    );
    assert.match(
      output,
      /self-test-rule-12 passed/,
      'Expected self-test success message in output',
    );
  });
});
