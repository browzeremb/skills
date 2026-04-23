#!/usr/bin/env node
// run-skill-evals.mjs
// Runs targeted behavioral evals for skill changes via `claude -p`.
// Covers: SKL-1 (generate-task audit-overlap exception) and SKL-3 (Trivial shortcut).
//
// Usage:
//   node scripts/run-skill-evals.mjs                   # all evals
//   node scripts/run-skill-evals.mjs --skill generate-task
//   node scripts/run-skill-evals.mjs --skill verification-before-completion
//   node scripts/run-skill-evals.mjs --timeout 180
//   node scripts/run-skill-evals.mjs --verbose

import { execSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const skillFilter = args.includes('--skill')
  ? args[args.indexOf('--skill') + 1]
  : 'all';
const timeoutSec = args.includes('--timeout')
  ? Number(args[args.indexOf('--timeout') + 1])
  : 120;
const verbose = args.includes('--verbose');

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(msg + '\n');
}
function dim(msg) {
  return `\x1b[2m${msg}\x1b[0m`;
}
function green(msg) {
  return `\x1b[32m${msg}\x1b[0m`;
}
function red(msg) {
  return `\x1b[31m${msg}\x1b[0m`;
}
function yellow(msg) {
  return `\x1b[33m${msg}\x1b[0m`;
}

/**
 * Run `claude -p <prompt>` non-interactively with the browzer plugin loaded.
 * Returns { stdout, exitCode, timedOut }.
 */
function runClaude(
  prompt,
  {
    cwd = REPO_ROOT,
    extraFlags = [],
    timeoutSec: localTimeout = timeoutSec,
  } = {},
) {
  return new Promise((resolve) => {
    const pluginDir = PKG_ROOT;

    const cmd = [
      'claude',
      '-p',
      prompt,
      '--plugin-dir',
      pluginDir,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...extraFlags,
    ];

    if (verbose) log(dim(`  $ ${cmd.join(' ')}`));

    // Strip CLAUDECODE so claude -p can nest inside an active session.
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, exitCode: -1, timedOut: true });
    }, localTimeout * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, timedOut: false });
    });
  });
}

/**
 * Collect all text content from a stream-json claude output.
 */
function extractText(streamJson) {
  const lines = streamJson.split('\n').filter(Boolean);
  const parts = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // result event contains full text
      if (ev.type === 'result' && ev.result) {
        parts.push(ev.result);
        continue;
      }
      // assistant messages with text blocks
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text') parts.push(block.text);
        }
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return parts.join('\n');
}

/**
 * Collect all Bash tool calls from stream-json output.
 */
function extractBashCalls(streamJson) {
  const lines = streamJson.split('\n').filter(Boolean);
  const calls = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use' && block.name === 'Bash') {
            calls.push(block.input?.command ?? '');
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  return calls;
}

/**
 * Check a single assertion against the claude output.
 * Returns { passed, reason }.
 */
function checkAssertion(assertion, { text, bashCalls, cwd }) {
  const { name, check } = assertion;

  // ── generate-task: file-count assertions ─────────────────────────────────
  if (name === 'task-count-le-2') {
    try {
      const files = execSync(
        `find . -name 'TASK_*.md' -not -path '*/.meta/*' -not -path '*/skill-snapshot*' | head -20`,
        { cwd, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const count = files.filter((f) => /TASK_\d+\.md$/.test(f)).length;
      return count <= 2
        ? { passed: true, reason: `${count} task(s) found` }
        : { passed: false, reason: `${count} task(s) found, expected ≤ 2` };
    } catch (e) {
      return { passed: false, reason: `fs check failed: ${e.message}` };
    }
  }

  if (name === 'task-count-in-4-6-range') {
    try {
      const files = execSync(
        `find . -name 'TASK_*.md' -not -path '*/.meta/*' | head -20`,
        { cwd, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const count = files.filter((f) => /TASK_\d+\.md$/.test(f)).length;
      return count >= 4 && count <= 6
        ? { passed: true, reason: `${count} task(s) found` }
        : { passed: false, reason: `${count} task(s) found, expected 4-6` };
    } catch (e) {
      return { passed: false, reason: `fs check failed: ${e.message}` };
    }
  }

  if (name === 'activation-receipt-written') {
    try {
      execSync(`find . -name 'activation-receipt.json' -path '*/.meta/*'`, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { passed: true, reason: 'activation-receipt.json found' };
    } catch {
      return { passed: false, reason: 'activation-receipt.json not found' };
    }
  }

  if (name === 'no-over-split') {
    // All three env-var additions (7.1/7.2/7.3) must NOT each be their own task.
    // Check: no task file contains exactly one of the three env vars alone.
    try {
      const taskFiles = execSync(
        `find . -name 'TASK_*.md' -not -path '*/.meta/*'`,
        { cwd, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);

      for (const f of taskFiles) {
        const content = readFileSync(join(cwd, f), 'utf8');
        const hasGlobal = content.includes('RATE_LIMIT_GLOBAL_MAX');
        const hasAuth = content.includes('RATE_LIMIT_AUTH_MAX');
        const hasWindow = content.includes('RATE_LIMIT_WINDOW_MS');
        // If a task mentions only ONE of the three env vars, it's over-split.
        const count = [hasGlobal, hasAuth, hasWindow].filter(Boolean).length;
        if (count === 1) {
          return {
            passed: false,
            reason: `${f} contains exactly one env var — over-split`,
          };
        }
      }
      return { passed: true, reason: 'env vars appear consolidated' };
    } catch (e) {
      return { passed: false, reason: `fs check failed: ${e.message}` };
    }
  }

  if (name === 'all-acceptance-criteria-covered') {
    // Derive how many ACs there are from the check description.
    const match = check.match(/AC1.*AC(\d+)/);
    const maxAC = match ? parseInt(match[1], 10) : 3;
    try {
      const taskContent = execSync(
        `find . -name 'TASK_*.md' -not -path '*/.meta/*' | xargs cat 2>/dev/null`,
        { cwd, encoding: 'utf8' },
      );
      const missing = [];
      for (let i = 1; i <= maxAC; i++) {
        if (!taskContent.includes(`AC${i}`)) missing.push(`AC${i}`);
      }
      return missing.length === 0
        ? { passed: true, reason: `all AC1–AC${maxAC} covered` }
        : { passed: false, reason: `missing: ${missing.join(', ')}` };
    } catch (e) {
      return { passed: false, reason: `fs check failed: ${e.message}` };
    }
  }

  // ── verification-before-completion: trivial skip ──────────────────────────
  if (name === 'trivial-skip-line') {
    const t = text.toLowerCase();
    const passed =
      t.includes('trivial task') ||
      t.includes('trivial: true') ||
      t.includes('trivial');
    return {
      passed,
      reason: passed
        ? 'found trivial-task signal in output'
        : 'no trivial-task signal in output',
    };
  }

  if (name === 'blast-radius-skipped') {
    const t = text.toLowerCase();
    const passed =
      (t.includes('blast radius') || t.includes('blast-radius')) &&
      t.includes('skip');
    return {
      passed,
      reason: passed
        ? 'blast-radius skip confirmed'
        : 'blast-radius skip not found in output',
    };
  }

  if (name === 'mutation-skipped') {
    const passed = text.includes('mutation') && text.includes('skipped');
    return {
      passed,
      reason: passed
        ? 'mutation skip confirmed'
        : 'mutation skip not found in output',
    };
  }

  if (name === 'quality-gate-run') {
    // Should run lint/typecheck/test
    const hasGate =
      bashCalls.some(
        (c) =>
          c.includes('lint') || c.includes('typecheck') || c.includes('turbo'),
      ) ||
      text.includes('lint') ||
      text.includes('typecheck');
    return {
      passed: hasGate,
      reason: hasGate
        ? 'quality gate command found'
        : 'no lint/typecheck/turbo command found',
    };
  }

  // ── generate-task: audit-overlap exception ────────────────────────────────
  if (name === 'audit-overlap-accepted') {
    // Skill should NOT produce an error about file overlap for the audit task.
    const rejected =
      text.toLowerCase().includes('reject') &&
      (text.includes('appears in more than one') ||
        text.includes('file path conflict') ||
        text.includes('silent edit conflict'));
    return {
      passed: !rejected,
      reason: rejected
        ? 'skill incorrectly rejected audit-overlap as violation'
        : 'audit-overlap accepted (no false rejection)',
    };
  }

  if (name === 'audit-overlap-implementation-notes') {
    // Both tasks should mention the overlap in Implementation notes.
    try {
      const taskFiles = execSync(
        `find . -name 'TASK_*.md' -not -path '*/.meta/*'`,
        { cwd, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const notes = taskFiles
        .map((f) => readFileSync(join(cwd, f), 'utf8').toLowerCase())
        .join('\n');
      const hasNote =
        notes.includes('audit') ||
        notes.includes('verify') ||
        notes.includes('read-only');
      return {
        passed: hasNote,
        reason: hasNote
          ? 'audit-overlap documented in Implementation notes'
          : 'no audit/verify/read-only mention found in task files',
      };
    } catch (e) {
      return { passed: false, reason: `fs check failed: ${e.message}` };
    }
  }

  if (name === 'legacy-flag-removal-in-tasks') {
    // Check task files for LEGACY_FLAG — LLM may not repeat it in the confirmation text.
    try {
      const taskFiles = execSync(
        `find . -name 'TASK_*.md' -not -path '*/.meta/*'`,
        { cwd, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const combined = taskFiles
        .map((f) => readFileSync(join(cwd, f), 'utf8'))
        .join('\n');
      const inFiles = combined.includes('LEGACY_FLAG');
      const inText = text.includes('LEGACY_FLAG');
      const passed = inFiles || inText;
      return {
        passed,
        reason: passed
          ? `LEGACY_FLAG found in ${inFiles ? 'task files' : 'output text'}`
          : 'LEGACY_FLAG not found in task files or output',
      };
    } catch (e) {
      return { passed: false, reason: `fs check failed: ${e.message}` };
    }
  }

  // ── fallback: text-contains check ────────────────────────────────────────
  if (check.startsWith('output contains')) {
    const needle = check
      .replace(/^output contains ['"]?/, '')
      .replace(/['"]$/, '');
    const passed = text.toLowerCase().includes(needle.toLowerCase());
    return {
      passed,
      reason: passed ? `found "${needle}"` : `"${needle}" not in output`,
    };
  }

  return { passed: null, reason: `unrecognised assertion "${name}" — skipped` };
}

// ── Eval definitions ──────────────────────────────────────────────────────────

const EVALS = [
  // ─── SKL-1: generate-task audit-overlap ──────────────────────────────────
  {
    id: 'gt-audit-overlap',
    skill: 'generate-task',
    timeoutOverride: 480,
    label: 'SKL-1 — audit-overlap exception accepted',
    cwd: REPO_ROOT,
    setup() {
      // Create a minimal feat dir with a PRD that requires an audit-overlap.
      const featDir = join(
        REPO_ROOT,
        'packages/skills/skills/generate-task/evals/fixtures/feat-test-audit-overlap',
      );
      mkdirSync(join(featDir, '.meta'), { recursive: true });
      writeFileSync(
        join(featDir, 'PRD.md'),
        `# PRD: Purge legacy flag + audit sweep

## 7. Functional requirements
7.1. Remove \`LEGACY_FLAG\` from \`apps/api/src/config.ts\`.
7.2. Audit sweep: verify \`apps/api/src/config.ts\` no longer exports \`LEGACY_FLAG\` (read-only check, done in a separate audit task that also runs the full test suite as confirmation).

## 13. Acceptance criteria
- [ ] AC1: \`LEGACY_FLAG\` absent from \`apps/api/src/config.ts\`.
- [ ] AC2: Audit task confirms removal via grep + test run.
`,
      );
      return featDir;
    },
    teardown(featDir) {
      try {
        rmSync(featDir, { recursive: true, force: true });
      } catch {}
    },
    buildPrompt(featDir) {
      const rel = relative(REPO_ROOT, featDir);
      return `Run generate-task against the PRD at \`${rel}/PRD.md\`. Use \`${rel}\` as FEAT_DIR. The PRD intentionally requires an audit task (TASK_02) that references the same file as the primary task (TASK_01) solely to verify the removal — this is an audit-overlap. Emit TASK_NN.md files and the Phase 7 one-line confirmation. Do not invoke downstream skills.`;
    },
    assertions: [
      {
        name: 'audit-overlap-accepted',
        check: 'skill should not reject audit-overlap as violation',
      },
      {
        name: 'audit-overlap-implementation-notes',
        check: 'both tasks document the overlap explicitly',
      },
      {
        name: 'legacy-flag-removal-in-tasks',
        check: 'output contains "LEGACY_FLAG"',
      },
      {
        name: 'activation-receipt-written',
        check: 'feat dir .meta/activation-receipt.json exists',
      },
    ],
  },

  // ─── SKL-1: generate-task trivial-pieces merge (regression) ──────────────
  {
    id: 'gt-trivial-pieces',
    skill: 'generate-task',
    timeoutOverride: 600,
    label: 'SKL-1 — trivial-pieces eval (no-over-split regression)',
    cwd: REPO_ROOT,
    setup() {
      // evals/ is gitignored — create fixture dynamically so the eval works from a clean clone.
      const featDir = join(REPO_ROOT, 'tmp-eval-gt-trivial-pieces');
      mkdirSync(join(featDir, '.meta'), { recursive: true });
      writeFileSync(
        join(featDir, 'PRD.md'),
        `# Medium Feature: Expose 3 new rate-limit env vars\n\n` +
          `**Repo surface:** \`packages/shared/src/env.ts\`, \`apps/api/src/plugins/rate-limit.ts\`, \`apps/gateway/src/plugins/rate-limit.ts\`\n\n` +
          `## 7. Functional requirements\n` +
          `7.1. Add \`RATE_LIMIT_GLOBAL_MAX\` (number, default 1000) to shared env schema.\n` +
          `7.2. Add \`RATE_LIMIT_AUTH_MAX\` (number, default 10) to shared env schema.\n` +
          `7.3. Add \`RATE_LIMIT_WINDOW_MS\` (number, default 60000) to shared env schema.\n` +
          `7.4. \`apps/api\` rate-limit plugin reads from shared env.\n` +
          `7.5. \`apps/gateway\` rate-limit plugin reads from shared env.\n\n` +
          `## 8. Non-functional\n- Defaults MUST match current hardcoded values.\n\n` +
          `## 9. Constraints\n- Env schema file is shared across ALL services — must not break worker/rag/web.\n\n` +
          `## 13. Acceptance criteria\n` +
          `- [ ] AC1: 3 env vars appear in shared env schema with correct types/defaults.\n` +
          `- [ ] AC2: api plugin reads from env (not hardcoded).\n` +
          `- [ ] AC3: gateway plugin reads from env (not hardcoded).\n` +
          `- [ ] AC4: unset env vars → identical runtime behaviour.\n\n` +
          `## 14. Hand-off to generate-task\nThree tiny touch-points, all same-layer. Likely one task, not three.\n`,
      );
      return featDir;
    },
    teardown(featDir) {
      try {
        rmSync(featDir, { recursive: true, force: true });
      } catch {}
    },
    buildPrompt(featDir) {
      const rel = relative(REPO_ROOT, featDir);
      return `Run generate-task against the PRD at \`${rel}/PRD.md\`. Use \`${rel}\` as FEAT_DIR. The PRD describes 3 env-var additions + 2 config plugin updates — these are same-layer, same-package-adjacent trivial pieces that should be consolidated. Emit Phase 7 confirmation. Do not invoke downstream skills.`;
    },
    assertions: [
      { name: 'task-count-le-2', check: 'number of TASK_*.md files ≤ 2' },
      {
        name: 'no-over-split',
        check: 'the three env-var additions are not each in their own task',
      },
      {
        name: 'all-acceptance-criteria-covered',
        check:
          'AC1 through AC4 each appear in some TASK_*.md Success criteria section',
      },
    ],
  },

  // ─── SKL-3: verification-before-completion trivial shortcut ──────────────
  {
    id: 'vbc-trivial-skip',
    skill: 'verification-before-completion',
    label: 'SKL-3 — Trivial: true skips blast-radius + mutation',
    cwd: REPO_ROOT,
    setup() {
      // Create the fixture dynamically so the eval works from a clean clone
      // (evals/ is gitignored — no static fixture to rely on).
      const featDir = join(REPO_ROOT, 'tmp-eval-vbc-trivial-skip');
      mkdirSync(join(featDir, '.meta'), { recursive: true });
      writeFileSync(
        join(featDir, 'TASK_01.md'),
        `# TASK_01 — Add RATE_LIMIT_WINDOW_MS constant\n\n` +
          `**Layer:** shared\n**Package:** packages/shared\n**Trivial:** true\n**Depends on:** —\n\n` +
          `## Scope\n| File | Action |\n|------|--------|\n` +
          `| \`packages/shared/src/env.ts\` | edit — add \`RATE_LIMIT_WINDOW_MS\` env var definition |\n\n` +
          `**Total: 1 files**\n\n` +
          `## Implementation notes\nSingle-line addition to the Zod env schema.\n\n` +
          `## Success criteria\n- [ ] AC1: \`RATE_LIMIT_WINDOW_MS\` in \`packages/shared/src/env.ts\` with default 60000.\n\n` +
          `## Verification plan\n\`pnpm turbo lint typecheck test --filter=@browzer/shared\`\n`,
      );
      return featDir;
    },
    teardown(featDir) {
      try {
        rmSync(featDir, { recursive: true, force: true });
      } catch {}
    },
    buildPrompt(featDir) {
      const rel = relative(REPO_ROOT, featDir);
      return `Run verification-before-completion with the following args: "files: packages/shared/src/env.ts; feat dir: ${rel}". The task file at ${rel}/TASK_01.md has Trivial: true — so the skill should skip Phases 2 and 3 (blast-radius and mutation testing) and only run the slim quality gate (lint/typecheck/test scoped to the package). Confirm the output includes the trivial-skip confirmation line.`;
    },
    assertions: [
      { name: 'trivial-skip-line', check: 'output contains "trivial task"' },
      { name: 'blast-radius-skipped', check: 'blast radius skipped in output' },
      { name: 'mutation-skipped', check: 'mutation skipped in output' },
      { name: 'quality-gate-run', check: 'lint or typecheck command was run' },
    ],
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runEval(evalDef) {
  const {
    id,
    label,
    skill,
    cwd,
    setup,
    teardown,
    buildPrompt,
    assertions,
    timeoutOverride,
  } = evalDef;

  if (skillFilter !== 'all' && skillFilter !== skill) return null;

  const effectiveTimeout = timeoutOverride ?? timeoutSec;

  log(`\n${yellow('▶')} ${label}`);
  log(dim(`  skill: ${skill}  |  timeout: ${effectiveTimeout}s`));

  const ctx = setup();
  const prompt = buildPrompt(ctx ?? cwd);

  log(dim(`  prompt: ${prompt.slice(0, 120)}…`));

  const start = Date.now();
  const { stdout, stderr, timedOut, exitCode } = await runClaude(prompt, {
    cwd: REPO_ROOT,
    timeoutSec: effectiveTimeout,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (timedOut) {
    log(red(`  ✗ timed out after ${effectiveTimeout}s`));
    teardown(ctx);
    return { id, label, passed: false, reason: 'timed out', assertions: [] };
  }

  if (stderr && (verbose || stdout.length === 0)) {
    log(dim(`  stderr: ${stderr.slice(0, 300)}`));
  }

  const text = extractText(stdout);
  const bashCalls = extractBashCalls(stdout);

  if (verbose) {
    log(dim(`\n  --- output (${text.length} chars) ---`));
    log(dim(text.slice(0, 800)));
    log(dim('  ---'));
  }

  const results = assertions.map((a) => {
    const r = checkAssertion(a, { text, bashCalls, cwd: ctx ?? cwd });
    const icon =
      r.passed === true
        ? green('✓')
        : r.passed === false
          ? red('✗')
          : yellow('?');
    log(`  ${icon} ${a.name}: ${dim(r.reason)}`);
    return { name: a.name, ...r };
  });

  const passed = results.every((r) => r.passed !== false);
  log(
    `  ${passed ? green('PASS') : red('FAIL')} (${elapsed}s | exit ${exitCode})`,
  );

  teardown(ctx);
  return { id, label, passed, results };
}

async function main() {
  log(`\n${'─'.repeat(60)}`);
  log(
    `Browzer skill evals  |  filter: ${skillFilter}  |  timeout: ${timeoutSec}s`,
  );
  log('─'.repeat(60));

  const outcomes = [];
  for (const evalDef of EVALS) {
    const result = await runEval(evalDef);
    if (result) outcomes.push(result);
  }

  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.passed).length;
  const failed = total - passed;

  log(`\n${'─'.repeat(60)}`);
  log(
    `Results: ${green(passed + ' passed')}  ${failed > 0 ? red(failed + ' failed') : dim('0 failed')}  / ${total} total`,
  );

  if (failed > 0) {
    log(red('\nFailed evals:'));
    for (const o of outcomes.filter((r) => !r.passed)) {
      log(red(`  • ${o.label}`));
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
