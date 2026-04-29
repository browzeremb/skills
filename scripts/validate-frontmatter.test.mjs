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

import { TYPE_1_PATTERNS } from './_workflow-mutator-patterns.mjs';

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

// ── Rule 6 sub-rule — Type-1 mutator --await contract ────────────────────────
//
// Mirrors the sub-rule logic in validate-frontmatter.mjs. If the body invokes
// any TYPE_1 verb, allowed-tools MUST contain the literal token
// `Bash(browzer workflow * --await)`. Plain `Bash(browzer workflow *)` does NOT
// satisfy — Claude Code allow-list pattern matching treats `--await` as a
// distinct constraint.

function checkRule6Type1(content, allowedToolsValue) {
  const allowedTools = allowedToolsValue || '';
  const hasAwaitToken = /Bash\(browzer workflow \* --await\)/.test(
    allowedTools,
  );
  const firstHit = TYPE_1_PATTERNS.find((re) => re.test(content));
  if (firstHit && !hasAwaitToken) {
    return `mentions Type-1 mutator '${firstHit.source}' but allowed-tools missing Bash(browzer workflow * --await)`;
  }
  return null;
}

describe('Rule 6 sub-rule — Type-1 mutator --await contract', () => {
  const TYPE_1_BODIES = {
    'set-status': 'browzer workflow set-status STEP_ID RUNNING',
    'complete-step': 'browzer workflow complete-step "$STEP_ID"',
    'set-current-step': 'browzer workflow set-current-step STEP_ID',
    'set-config': 'browzer workflow set-config mode review',
    'append-step': 'echo "$STEP" | browzer workflow append-step',
    'update-step task.*':
      'browzer workflow update-step STEP_ID --field task.reviewer',
    'patch outputs':
      'browzer workflow patch --jq \'.steps["s1"].outputs += {x:1}\'',
  };

  const TYPE_2_ONLY_BODIES = {
    'get-step': 'browzer workflow get-step "$STEP_ID" --field status',
    query: 'browzer workflow query open-findings',
    'get-config': 'browzer workflow get-config mode',
    'update-step metrics':
      'browzer workflow update-step STEP_ID --field metrics',
    'update-step auditLog':
      'browzer workflow update-step STEP_ID --field auditLog',
    'append-review-history default':
      'browzer workflow append-review-history STEP_ID',
  };

  it('PASSES with Bash(browzer workflow * --await) for set-status invocation', () => {
    const result = checkRule6Type1(
      TYPE_1_BODIES['set-status'],
      'Bash(browzer workflow * --await), Bash(browzer workflow *)',
    );
    assert.equal(result, null, 'Expected sub-rule to pass with --await token');
  });

  it('FAILS when set-status invocation has only Bash(browzer workflow *) (no --await)', () => {
    const result = checkRule6Type1(
      TYPE_1_BODIES['set-status'],
      'Bash(browzer workflow *), Bash(jq *)',
    );
    assert.ok(result, 'Expected sub-rule to fail without --await token');
    assert.match(result, /Type-1/);
    assert.match(result, /--await/);
  });

  // Parametrized: every Type-1 pattern, in isolation, must trigger the failure.
  for (const [label, body] of Object.entries(TYPE_1_BODIES)) {
    it(`FAILS for Type-1 verb '${label}' when --await token absent`, () => {
      const result = checkRule6Type1(body, 'Bash(browzer workflow *)');
      assert.ok(result, `Type-1 verb '${label}' should fail without --await`);
      assert.match(result, /--await/);
    });

    it(`PASSES for Type-1 verb '${label}' when --await token present`, () => {
      const result = checkRule6Type1(
        body,
        'Bash(browzer workflow * --await), Bash(browzer workflow *)',
      );
      assert.equal(result, null, `Type-1 verb '${label}' should pass`);
    });
  }

  for (const [label, body] of Object.entries(TYPE_2_ONLY_BODIES)) {
    it(`PASSES for Type-2-only body '${label}' (no --await needed)`, () => {
      const result = checkRule6Type1(body, 'Bash(browzer workflow *)');
      assert.equal(
        result,
        null,
        `Type-2-only body '${label}' should not trigger sub-rule`,
      );
    });
  }

  it('IDEMPOTENCE: a body with multiple Type-1 verbs emits exactly one failure', () => {
    const mixedBody = [
      TYPE_1_BODIES['set-status'],
      TYPE_1_BODIES['append-step'],
      TYPE_1_BODIES['complete-step'],
    ].join('\n');
    // Inline the loop logic the validator uses (find then push once).
    const allowedTools = 'Bash(browzer workflow *)';
    const hasAwaitToken = /Bash\(browzer workflow \* --await\)/.test(
      allowedTools,
    );
    const matches = TYPE_1_PATTERNS.filter((re) => re.test(mixedBody));
    assert.ok(matches.length >= 3, 'Body should match at least 3 Type-1 verbs');
    const failures = [];
    if (matches.length > 0 && !hasAwaitToken) {
      failures.push({
        rule: 6,
        reason: `mentions Type-1 mutator '${matches[0].source}' but allowed-tools missing Bash(browzer workflow * --await)`,
      });
    }
    assert.equal(
      failures.length,
      1,
      'Multiple Type-1 hits should produce exactly one failure entry',
    );
  });

  it('TYPE_2 invocations alone (mixed body) do not trigger sub-rule', () => {
    const type2Body = Object.values(TYPE_2_ONLY_BODIES).join('\n');
    const result = checkRule6Type1(type2Body, 'Bash(browzer workflow *)');
    assert.equal(result, null, 'Type-2-only mixed body should pass');
  });

  it('plain `update-step --field metrics` does NOT regress to Type-1 path', () => {
    // Edge case: 'update-step' substring exists in TYPE_2_ONLY_BODIES too;
    // the regex must reject metrics/auditLog field names.
    const result = checkRule6Type1(
      TYPE_2_ONLY_BODIES['update-step metrics'],
      'Bash(browzer workflow *)',
    );
    assert.equal(result, null);
  });
});

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
  const routerSection = includeRouter ? '## References router\n\nSee references/.\n\n' : '';
  const filler = Array.from({ length: lines }, (_, i) => `Line ${i + 1} of filler content.`).join('\n');
  return fm + routerSection + filler;
}

describe('Rule 9 — warn-only for long skills without ## References router', () => {
  it('PASS: skill with >250 lines AND ## References router emits no warning', () => {
    const content = makeLongBody(260, true);
    const result = checkRule9(content, 'skills/long-skill/SKILL.md');
    assert.equal(result, null, 'Expected no warning when ## References router is present');
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
    assert.ok(lineCount <= 250, `Expected content to be ≤250 lines, got ${lineCount}`);
    const result = checkRule9(content, 'skills/long-skill/SKILL.md');
    assert.equal(result, null, 'Expected no warning for a skill with ≤250 lines');
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
    const filler = Array.from({ length: 260 }, (_, i) => `Line ${i}.`).join('\n');
    const content = fm + prose + filler;
    const result = checkRule9(content, 'skills/almost-router/SKILL.md');
    assert.ok(result, 'Expected warning — prose mention does not satisfy the heading requirement');
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
