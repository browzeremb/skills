#!/usr/bin/env node
/**
 * test-skill-samples.mjs — C1 schema-roundtrip eval.
 *
 * Walks `packages/skills/skills/<skill>/SKILL.md` and
 * `packages/skills/skills/<skill>/references/**.md`, extracts every fenced
 * `bash` block whose body contains a `browzer workflow {init|append-step|patch|
 * complete-step|set-status|set-config|append-dispatch|reapply-additional-context|
 * set-finding-status|set-finding-statuses|append-dispatches|update-step}`
 * invocation, materialises a deterministic version of the invocation against a
 * fresh seeded workflow.json fixture, runs it, and reports the CUE-validation
 * pass rate.
 *
 * Why: skill examples that the agent copy-pastes MUST round-trip the CUE
 * validator. A sample that the agent's own toolchain rejects burns budget
 * with no progress (the relevant friction §2.1 in the
 * `feat-20260505-conversion-balance-liquidation` retro). This eval is the
 * regression net for that class of bug.
 *
 * Invocation:
 *   node packages/skills/scripts/test-skill-samples.mjs
 *   node packages/skills/scripts/test-skill-samples.mjs --update-baseline
 *
 * Wired in:
 *   - packages/skills/package.json scripts → `pnpm --filter @browzer/skills test:skill-samples`
 *   - .github/workflows/ci.yml `quality` job
 *
 * Skip directives:
 *   `# samples-eval: skip` on the line BEFORE the opening fence excludes the
 *   whole block — for `<json>` placeholder examples the agent reads visually
 *   but never runs verbatim.
 *
 * Baseline policy:
 *   The eval runs a CUE-roundtrip against every tracked invocation. Pre-existing
 *   skill bugs (real but out-of-scope to fix now per the C-phase plan) are
 *   pinned in `__fixtures__/skill-samples-baseline.json`. The eval fails CI
 *   when the failure SET drifts (new file:verb appearing) — not when overall
 *   count changes. To accept a new failing sample, run with `--update-baseline`
 *   and commit the diff. To remove a baselined entry, fix the sample and the
 *   eval will auto-shrink the allowlist on next run.
 *
 * Exit code:
 *   0 — pass rate >= TARGET_PASS_RATE OR all failures are in the baseline
 *   1 — new failures appeared (drift) OR pre-flight error (CLI/fixture missing)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_PKG = resolve(__dirname, '..');
const REPO_ROOT = resolve(SKILLS_PKG, '..', '..');
const SKILLS_ROOT = join(SKILLS_PKG, 'skills');
const BASELINE = join(__dirname, '__fixtures__', 'workflow-baseline.json');
const FAILURE_BASELINE = join(
  __dirname,
  '__fixtures__',
  'skill-samples-baseline.json',
);
const TARGET_PASS_RATE = 0.99;

// Verbs we care about. The CLI verb is lowercase-with-dashes (matches `browzer
// workflow <verb>`); `update-step` and the bulk verbs are listed for forward
// compatibility — when those are not yet registered, an `unknown command`
// failure trips the same FAIL bucket and the operator sees both gaps.
const TRACKED_VERBS = new Set([
  'init',
  'append-step',
  'patch',
  'complete-step',
  'set-status',
  'set-config',
  'append-dispatch',
  'reapply-additional-context',
  'set-finding-status',
  'set-finding-statuses',
  'append-dispatches',
  'update-step',
]);

// Deterministic placeholders. The goal is "does the CLI accept the shape", not
// "does this sample do something semantically meaningful". Anything we can't
// pin to a schema-valid value collapses to VAR_FALLBACK.
const VAR_TABLE = {
  WORKFLOW: '__WORKFLOW_PATH__', // patched per-invocation
  STEP_ID: 'STEP_99_TEST',
  STEP: 'STEP_99_TEST',
  PARENT_STEP_ID: 'STEP_99_TEST',
  TASK_STEP_ID: 'STEP_99_TEST',
  CR_STEP_ID: 'STEP_99_TEST',
  RCR_STEP_ID: 'STEP_99_TEST',
  STATUS: 'COMPLETED',
  MODE: 'autonomous',
  STRATEGY: 'serial',
  DEPTH: 'scoped-execute',
  TASK_ELAPSED: '0.5',
  STEP_JSON: '{}',
  CODE_REVIEW_PAYLOAD: '{}',
  PAYLOAD: '{}',
  FINDING_ID: 'F-1',
  CHANGES_JSON_ARRAY: '[]',
  BROWZER_SKILLS_REF: SKILLS_PKG,
  // Bash-side $JSON_VAR names that appear in --argjson / --arg payloads.
  // These materialise as the JSON value the example would otherwise build at
  // runtime. Added 2026-05-05 (A4 sweep) — closes the "--argjson X=PLACEHOLDER:
  // invalid JSON" class of false-failures.
  EXECUTION_JSON: '{}',
  REVIEWER_JSON: '{}',
  // MANIFEST_STEP would normally be a TASKS_MANIFEST-flavour #Step. Embedding
  // such a JSON literal here is impossible because the test harness's
  // tokeniser re-parses double quotes inside the substituted bash command —
  // the inner key/value `"`s collide with `--argjson "step=…"` boundaries
  // and shred the cmdline. The single example that consumes MANIFEST_STEP
  // (`generate-task/SKILL.md::patch`) is `# samples-eval: skip`-tagged.
  MANIFEST_STEP: '{}',
  AGENT_EXECUTION_JSON: '{}',
  RESULT_JSON: '{}',
  TASK_ELAPSED_JSON: '0',
  TOTAL_ELAPSED: '0',
  KEY: '"STEP_99_TEST"',
  NUM: '0',
  NOW: '2026-05-05T00:00:00Z',
  // jq-side bind-var names that appear unquoted inside single-quoted jq
  // expressions in real skill examples. The materialiser cannot tell the
  // difference between bash $VAR and jq $var (the regex is context-free), so
  // we map common jq-bind names here to safe values that keep jq compiling.
  // Added 2026-05-05 (A4 sweep) — closes the "jq compile: function not
  // defined: PLACEHOLDER/0" class of false-failures on patch examples.
  id: '"STEP_99_TEST"',
  now: '"2026-05-05T00:00:00Z"',
  step: '{}',
  reviewer: '{}',
  execution: '{}',
  result: '{}',
  patch: '{}',
  changes: '[]',
  owner: '"worktree-1"',
  e: '0',
  s: '"COMPLETED"',
  v: '"completed"',
  ref: '"STEP_99_TEST"',
  t: '0',
};
const VAR_FALLBACK = 'PLACEHOLDER';

const SKIP_TAG = /#\s*samples-eval:\s*skip/i;

// Pre-seeded step the eval drops into the fixture for verbs that operate on an
// existing step (set-status, complete-step, append-dispatch, patch, etc).
// Schema-minimal but valid.
const SEED_STEP = {
  stepId: 'STEP_99_TEST',
  name: 'PRD',
  status: 'PENDING',
  applicability: { applicable: true, reason: 'fixture probe' },
  startedAt: '2026-05-05T00:00:00Z',
  prd: {
    title: 'fixture',
    acceptanceCriteria: [],
    functionalRequirements: [],
  },
};

// ── walk -----------------------------------------------------------------------

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

function collectMarkdownTargets() {
  const targets = [];
  for (const ent of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const skillDir = join(SKILLS_ROOT, ent.name);
    const skillMd = join(skillDir, 'SKILL.md');
    if (existsSync(skillMd)) targets.push(skillMd);
    const refsDir = join(skillDir, 'references');
    if (existsSync(refsDir)) walkMd(refsDir, targets);
  }
  return targets;
}

// ── extract --------------------------------------------------------------------

const FENCE_OPEN = /^(\s*)```bash\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

function extractBashBlocks(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN);
    if (!open) {
      i++;
      continue;
    }
    const blockStart = i;
    const prev = i > 0 ? lines[i - 1] : '';
    const skipped = SKIP_TAG.test(prev);
    i++;
    const buf = [];
    while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ file, blockStartLine: blockStart + 1, body: buf, skipped });
    i++;
  }
  return blocks;
}

function joinContinuations(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    let text = body[i];
    const start = i;
    while (text.endsWith('\\') && i + 1 < body.length) {
      text = text.slice(0, -1) + ' ' + body[i + 1].trimStart();
      i++;
    }
    out.push({ text, origLine: start });
    i++;
  }
  return out;
}

const VERB_LINE = /\bbrowzer\s+workflow\s+([a-z][a-z-]*)\b/;

function findInvocations(block) {
  const joined = joinContinuations(block.body);
  const out = [];
  for (const { text, origLine } of joined) {
    const m = text.match(VERB_LINE);
    if (!m) continue;
    if (!TRACKED_VERBS.has(m[1])) continue;
    const trimmed = text.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('//')) continue;
    out.push({
      file: block.file,
      lineInFile: block.blockStartLine + origLine + 1,
      verb: m[1],
      raw: trimmed,
    });
  }
  return out;
}

// ── prepare invocation ---------------------------------------------------------

function materialise(raw, workflowPath) {
  const ctx = { ...VAR_TABLE, WORKFLOW: workflowPath };
  // Strip leading "echo … | " / "printf … | " / "cat <<EOF | " — we feed
  // stdin payload separately for verbs that need it.
  let cmd = raw.replace(/^\s*(echo|printf|cat)\s[^|]*\|\s*/, '');

  // $VAR / ${VAR} substitution. Anything we don't recognise → VAR_FALLBACK.
  cmd = cmd.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
    name in ctx ? ctx[name] : VAR_FALLBACK,
  );
  cmd = cmd.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) =>
    name in ctx ? ctx[name] : VAR_FALLBACK,
  );

  cmd = cmd.replace(/\s--await\b/g, '');
  cmd = cmd.replace(/\s--async\b/g, '');

  if (!/\s--sync\b/.test(cmd)) cmd = cmd + ' --sync';
  if (!/\s--workflow\b/.test(cmd)) cmd = cmd + ` --workflow ${workflowPath}`;

  return cmd;
}

function tokenise(cmd) {
  const argv = [];
  let buf = '';
  let i = 0;
  let quote = null;
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
        buf += cmd[i + 1];
        i++;
      } else {
        buf += c;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (/\s/.test(c)) {
      if (buf) {
        argv.push(buf);
        buf = '';
      }
    } else if (c === '\\' && i + 1 < cmd.length) {
      buf += cmd[i + 1];
      i++;
    } else {
      buf += c;
    }
    i++;
  }
  if (buf) argv.push(buf);
  return argv;
}

// ── execute --------------------------------------------------------------------

function freshFixture(verb) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-samples-'));
  const wf = join(dir, 'workflow.json');
  if (verb === 'init') {
    // init refuses if file exists (unless --force). For the fixture we drop
    // an empty path and let init seed it.
  } else {
    copyFileSync(BASELINE, wf);
    // Pre-seed the SEED_STEP so verbs that target $STEP_ID find a step.
    const wfData = JSON.parse(readFileSync(wf, 'utf8'));
    wfData.steps = [SEED_STEP];
    wfData.totalSteps = 1;
    wfData.currentStepId = SEED_STEP.stepId;
    writeFileSync(wf, JSON.stringify(wfData, null, 2));
  }
  return { dir, wf };
}

function runInvocation(invocation) {
  const { dir, wf } = freshFixture(invocation.verb);
  try {
    const cmd = materialise(invocation.raw, wf);
    const argv = tokenise(cmd);
    if (argv[0] !== 'browzer') {
      return { ok: false, error: `non-browzer leading token: ${argv[0]}` };
    }
    let stdin = '';
    if (invocation.verb === 'append-step') {
      stdin = JSON.stringify({
        stepId: 'STEP_98_TEST',
        name: 'PRD',
        status: 'PENDING',
        applicability: { applicable: true, reason: 'fixture probe' },
        startedAt: '2026-05-05T00:00:00Z',
        prd: {
          title: 'fixture',
          acceptanceCriteria: [],
          functionalRequirements: [],
        },
      });
    }
    const r = spawnSync(argv[0], argv.slice(1), {
      input: stdin,
      env: {
        ...process.env,
        BROWZER_LLM: '1',
        BROWZER_WORKFLOW_QUIET: '1',
        BROWZER_WORKFLOW: wf,
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (r.status === 0) return { ok: true };
    const stderr = (r.stderr || '').trim().split('\n').slice(-3).join(' | ');
    return { ok: false, error: stderr || `exit ${r.status}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── pre-flight ----------------------------------------------------------------

function preflight() {
  if (!existsSync(BASELINE)) {
    process.stderr.write(`✗ baseline fixture missing: ${BASELINE}\n`);
    process.exit(1);
  }
  try {
    execFileSync('browzer', ['workflow', '--help'], {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch (e) {
    process.stderr.write(
      `✗ \`browzer\` CLI not on PATH (${e.message}). Install via \`go build -o /usr/local/bin/browzer ./cmd/browzer\`.\n`,
    );
    process.exit(1);
  }
}

// ── failure baseline -----------------------------------------------------------

function loadBaseline() {
  if (!existsSync(FAILURE_BASELINE)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(FAILURE_BASELINE, 'utf8'));
    return new Set(arr.map((e) => failureKey(e)));
  } catch {
    return new Set();
  }
}

function failureKey({ file, verb }) {
  return `${file}::${verb}`;
}

// ── main -----------------------------------------------------------------------

function main() {
  const updateBaseline = process.argv.includes('--update-baseline');

  preflight();

  const targets = collectMarkdownTargets();
  const allBlocks = targets.flatMap(extractBashBlocks);
  const live = allBlocks.filter((b) => !b.skipped);
  const skipped = allBlocks.length - live.length;

  const invocations = live.flatMap(findInvocations);

  let passed = 0;
  const failures = [];
  for (const inv of invocations) {
    const r = runInvocation(inv);
    if (r.ok) {
      passed++;
    } else {
      failures.push({
        file: relative(REPO_ROOT, inv.file),
        line: inv.lineInFile,
        verb: inv.verb,
        error: r.error,
      });
    }
  }

  const total = invocations.length;
  const rate = total > 0 ? passed / total : 1;
  const rateStr = (rate * 100).toFixed(1);

  process.stdout.write(
    `\nskill-samples: ${passed}/${total} pass (${rateStr}%) — ${skipped} blocks skipped via 'samples-eval: skip'\n`,
  );

  // Drift gate against baseline.
  const baseline = loadBaseline();
  const seenKeys = new Set(failures.map((f) => failureKey(f)));
  const newFailures = failures.filter((f) => !baseline.has(failureKey(f)));
  const fixedKeys = [...baseline].filter((k) => !seenKeys.has(k));

  if (updateBaseline) {
    const compact = failures.map(({ file, verb }) => ({ file, verb }));
    // Dedup
    const seen = new Set();
    const dedup = compact.filter((e) => {
      const k = failureKey(e);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    dedup.sort((a, b) => failureKey(a).localeCompare(failureKey(b)));
    writeFileSync(FAILURE_BASELINE, JSON.stringify(dedup, null, 2) + '\n');
    process.stdout.write(
      `✓ baseline updated: ${dedup.length} entries written to ${relative(REPO_ROOT, FAILURE_BASELINE)}\n`,
    );
    process.exit(0);
  }

  if (failures.length > 0) {
    process.stdout.write(`\nFailures (showing up to 30):\n`);
    for (const f of failures.slice(0, 30)) {
      const tag = baseline.has(failureKey(f)) ? '[baselined]' : '[NEW]';
      process.stdout.write(
        `  ${tag} ${f.file}:${f.line} [${f.verb}] — ${f.error}\n`,
      );
    }
    if (failures.length > 30) {
      process.stdout.write(`  … and ${failures.length - 30} more.\n`);
    }
  }

  process.stdout.write(`\nMETRIC_SAMPLES_PASS_RATE=${rate.toFixed(4)}\n`);

  if (newFailures.length > 0) {
    process.stderr.write(
      `\n✗ ${newFailures.length} NEW failure(s) not in baseline. ` +
        `Either fix the sample, add a 'samples-eval: skip' tag for genuine pseudo-code, ` +
        `or run with --update-baseline to accept the regression.\n`,
    );
    for (const f of newFailures.slice(0, 10)) {
      process.stderr.write(`    ${f.file}:${f.line} [${f.verb}]\n`);
    }
    process.exit(1);
  }

  if (fixedKeys.length > 0) {
    process.stdout.write(
      `\n✓ ${fixedKeys.length} baselined failure(s) no longer reproduce — run with --update-baseline to shrink the allowlist:\n`,
    );
    for (const k of fixedKeys.slice(0, 10)) {
      process.stdout.write(`    ${k}\n`);
    }
  }

  if (rate >= TARGET_PASS_RATE) {
    process.stdout.write(
      `✓ pass rate at or above target ${(TARGET_PASS_RATE * 100).toFixed(0)}%\n`,
    );
  } else {
    process.stdout.write(
      `(pass rate ${rateStr}% below target ${(TARGET_PASS_RATE * 100).toFixed(0)}%; held green by baseline allowlist — track follow-ups in TECHNICAL_DEBTS.md)\n`,
    );
  }
  process.exit(0);
}

main();
