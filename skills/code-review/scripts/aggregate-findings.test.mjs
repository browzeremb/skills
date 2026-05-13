/**
 * aggregate-findings.test.mjs
 *
 * Covers:
 *   - Alias normalization: pin.{path, startLine} → pinsFiles[] + line;
 *     summary → description; missing ruleId → "general" (with warning).
 *   - ±5 line dedup tolerance when (file, ruleId) matches.
 *   - title-overlap merge when one side has ruleId == "general".
 *   - missing description/fix warnings still emit the finding.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'aggregate-findings.mjs');
const FEAT_ID = 'feat-20260513-aggr-smoke';

function makeFeatDir() {
  const root = mkdtempSync(join(tmpdir(), 'aggr-test-'));
  const featDir = join(root, 'docs', 'browzer', FEAT_ID);
  const stagingDir = join(featDir, 'staging');
  mkdirSync(stagingDir, { recursive: true });
  return { root, featDir, stagingDir };
}

function writeLane(stagingDir, lane, fmYaml, body = '# body\n') {
  writeFileSync(
    join(stagingDir, `CODE_REVIEW.${lane}.md`),
    `---\n${fmYaml}\n---\n\n${body}`,
    'utf8',
  );
}

function run(root) {
  const r = spawnSync(process.execPath, [SCRIPT, FEAT_ID], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function readAggregate(stagingDir) {
  return readFileSync(join(stagingDir, 'CODE_REVIEW.md'), 'utf8');
}

test('aggregate-findings: alias normalization (pin object → pinsFiles + line, summary → description)', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'software-architect',
      `lane: software-architect
prdSha: deadbeef
diffBase: cafebabe
findings:
  - id: F-SA-001
    severity: medium
    title: "soft-gate denial emits no metric"
    file: apps/api/src/foo.ts
    pin:
      kind: line
      path: apps/api/src/foo.ts
      startLine: 162
      endLine: 183
    summary: >
      Pre-LLM soft-gate denial returns 402 without calling dailySpendGateDecisions.inc().`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `failed: ${r.stderr}`);
    const out = readAggregate(stagingDir);
    // description carries the summary text
    assert.match(out, /Pre-LLM soft-gate denial returns 402/);
    // pinsFiles contains the pin.path
    assert.match(out, /pinsFiles:\s*\[apps\/api\/src\/foo\.ts\]/);
    // line is promoted from pin.startLine
    assert.match(out, /line: 162/);
    // ruleId defaulted to "general" with a stderr warning
    assert.match(out, /ruleId: general/);
    assert.match(r.stderr, /ruleId missing/);
    assert.match(r.stderr, /fix missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate-findings: ±5 line drift dedups same-rule findings across lanes', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'senior-engineer',
      `lane: senior-engineer
findings:
  - id: F-SE-001
    severity: high
    file: apps/api/src/billing-compensation.ts
    line: 270
    ruleId: misleading-label-value
    title: "decision='allow' emitted when caller returns 402"
    description: |
      The refund-succeeded path sets decision='allow' but caller returns 402.
    fix: "Change decision to 'deny'."
    pinsFiles: [apps/api/src/billing-compensation.ts]`,
    );
    writeLane(
      stagingDir,
      'software-architect',
      `lane: software-architect
findings:
  - id: F-SA-001
    severity: medium
    file: apps/api/src/billing-compensation.ts
    line: 268
    ruleId: misleading-label-value
    title: "refund-applied path emits allow despite 402"
    description: |
      Inversion of label semantics; impossible to PromQL 'all 402s from atomic gate'.
    fix: "Change to deny."
    pinsFiles: [apps/api/src/billing-compensation.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `failed: ${r.stderr}`);
    const out = readAggregate(stagingDir);
    // Exactly ONE merged finding (was 2 in the smoke run).
    assert.match(out, /totalFindings: 1/);
    // mergedFrom carries both per-lane IDs.
    assert.match(out, /mergedFrom: \[F-SA-001, F-SE-001\]/);
    // severity rolled up to the max (high).
    assert.match(out, /severity: high/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate-findings: ruleId mismatch beyond fuzz keeps findings separate', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'senior-engineer',
      `lane: senior-engineer
findings:
  - id: F-SE-001
    severity: high
    file: apps/api/src/foo.ts
    line: 10
    ruleId: misleading-label-value
    title: "X"
    description: a
    fix: "fix a"
    pinsFiles: [apps/api/src/foo.ts]`,
    );
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: medium
    file: apps/api/src/foo.ts
    line: 100
    ruleId: missing-test
    title: "Y"
    description: b
    fix: "fix b"
    pinsFiles: [apps/api/src/foo.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `failed: ${r.stderr}`);
    const out = readAggregate(stagingDir);
    // Two separate findings — different ruleId AND line drift > 5.
    assert.match(out, /totalFindings: 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate-findings: title-overlap merges general-ruleId finding with a specific one', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'senior-engineer',
      `lane: senior-engineer
findings:
  - id: F-SE-001
    severity: high
    file: apps/api/src/billing.ts
    line: 50
    ruleId: misleading-label-value
    title: "decision allow emitted when caller returns 402"
    description: "specific"
    fix: "fix it"
    pinsFiles: [apps/api/src/billing.ts]`,
    );
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: high
    file: apps/api/src/billing.ts
    line: 52
    title: "decision allow returned despite caller emitting 402"
    summary: "narrative summary describing the same defect"
    pinsFiles: [apps/api/src/billing.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `failed: ${r.stderr}`);
    const out = readAggregate(stagingDir);
    // The general-ruleId qa finding matches the SE one by title overlap.
    assert.match(out, /totalFindings: 1/);
    assert.match(out, /mergedFrom: \[F-QA-001, F-SE-001\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate-findings: tolerant escape — fix scalar containing \\d+ no longer throws SyntaxError', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    // YAML body deliberately uses unescaped backslashes (\d, \w) — the exact
    // shape that previously threw "Bad escaped character" via JSON.parse. The
    // unescaper now preserves the `\X` sequence verbatim instead of crashing
    // or silently dropping the backslash.
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: medium
    file: src/regex.ts
    line: 12
    ruleId: regex-escape
    title: "matcher accepts unescaped backslash"
    description: "input \\d+ slipped past validation"
    fix: "tighten regex to /^\\d+$/"
    pinsFiles: [src/regex.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `failed: ${r.stderr}`);
    const out = readAggregate(stagingDir);
    assert.match(out, /totalFindings: 1/);
    // Backslash preserved in the description AND fix bodies (no JSON crash,
    // no silent drop). Match \d+ literally in the rendered YAML output.
    assert.match(out, /\\d\+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate-findings: missing description still emits finding + warning', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: low
    file: src/x.ts
    line: 1
    ruleId: missing-test
    title: "no test asserts counter"
    pinsFiles: [src/x.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `failed: ${r.stderr}`);
    assert.match(r.stderr, /description missing/);
    assert.match(r.stderr, /fix missing/);
    const out = readAggregate(stagingDir);
    assert.match(out, /totalFindings: 1/);
    assert.match(out, /id: F-001/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
