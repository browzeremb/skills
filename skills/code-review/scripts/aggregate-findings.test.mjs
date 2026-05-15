/**
 * aggregate-findings.test.mjs
 *
 * Covers:
 *   - Alias normalization: pin.{path, startLine} → pinsFiles[] + line;
 *     summary → description; missing ruleId → "general" (with warning).
 *   - ±5 line dedup tolerance when (file, ruleId) matches.
 *   - Title-overlap merge when one side has ruleId == "general".
 *   - Clean input (strict default): exit 0, output written.
 *   - Empty description (strict default): exit 1, no output written.
 *   - Empty fix (strict default): exit 1, no output written.
 *   - --allow-partial: partial findings emitted with a single count warning.
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

function run(root, extraArgs = []) {
  const r = spawnSync(process.execPath, [SCRIPT, FEAT_ID, ...extraArgs], {
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
      Pre-LLM soft-gate denial returns 402 without calling dailySpendGateDecisions.inc().
    fix: "Call the spend-gate decisions counter on the denial path."`,
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
    fix: "Align the decision label with the HTTP status returned by the caller."
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

// Clean path: well-formed findings with no --allow-partial exit 0 and write
// output. (Also covered implicitly by the alias-normalization and dedup tests
// above, which all use well-formed findings. This test provides an explicit
// minimal assertion.)
test('aggregate-findings: clean findings exit 0 and write output', () => {
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
    description: "The counter is never asserted in the test suite."
    fix: "Add an assertion on the counter value after the operation."
    pinsFiles: [src/x.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 0, `unexpected failure: ${r.stderr}`);
    const out = readAggregate(stagingDir);
    assert.match(out, /totalFindings: 1/);
    assert.match(out, /id: F-001/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Empty description (strict default): exit 1, no output file written.
test('aggregate-findings: empty description rejected without --allow-partial', () => {
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
    description: ""
    fix: "Add an assertion."
    pinsFiles: [src/x.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 1, `expected exit 1, got ${r.exitCode}`);
    assert.match(
      r.stderr,
      /^aggregator: rejected — [^/]+\/[^ ]+: description empty$/m,
    );
    // No output file should be written on rejection.
    assert.throws(
      () => readAggregate(stagingDir),
      /ENOENT/,
      'aggregate output must not be written on rejection',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Empty fix (strict default): exit 1, no output file written.
test('aggregate-findings: empty fix rejected without --allow-partial', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: medium
    file: src/y.ts
    line: 10
    ruleId: race-condition
    title: "unlocked read"
    description: "The shared counter is read without a lock."
    fix: ""
    pinsFiles: [src/y.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 1, `expected exit 1, got ${r.exitCode}`);
    assert.match(r.stderr, /^aggregator: rejected — [^/]+\/[^ ]+: fix empty$/m);
    assert.throws(
      () => readAggregate(stagingDir),
      /ENOENT/,
      'aggregate output must not be written on rejection',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// With --allow-partial: same partial input exits 0, output written, single
// stderr count line.
test('aggregate-findings: --allow-partial permits partial findings and emits count warning', () => {
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
    const r = run(root, ['--allow-partial']);
    assert.equal(r.exitCode, 0, `unexpected failure: ${r.stderr}`);
    // Single count warning line on stderr.
    assert.match(
      r.stderr,
      /^aggregator: WARN — [0-9]+ finding\(s\) template-defaulted$/m,
    );
    const out = readAggregate(stagingDir);
    assert.match(out, /totalFindings: 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Strict mode now collects ALL violations and emits one stderr line per
// violation before exiting 1. The previous behavior exited on the FIRST
// violation, forcing operators into a fix-rerun loop to discover the next
// defect. Three deliberately-broken findings should surface three stderr
// rejection lines AND zero merged-artifact output.
test('aggregate-findings: strict mode collects all violations (3 findings → 3 stderr lines)', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: low
    file: src/a.ts
    line: 1
    ruleId: missing-test
    title: "first broken finding"
    description: ""
    fix: "fix a"
    pinsFiles: [src/a.ts]
  - id: F-QA-002
    severity: medium
    file: src/b.ts
    line: 2
    ruleId: missing-test
    title: "second broken finding"
    description: "ok"
    fix: ""
    pinsFiles: [src/b.ts]
  - id: F-QA-003
    severity: high
    file: src/c.ts
    line: 3
    ruleId: missing-test
    title: "third broken finding (whitespace-only fix)"
    description: "ok"
    fix: "   "
    pinsFiles: [src/c.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 1, `expected exit 1, got ${r.exitCode}`);
    // Three distinct rejection lines must surface, one per defect.
    const rejectionLines = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('aggregator: rejected'));
    assert.equal(
      rejectionLines.length,
      3,
      `expected 3 rejection lines, got ${rejectionLines.length}: ${r.stderr}`,
    );
    assert.match(r.stderr, /qa\/F-QA-001: description empty/);
    assert.match(r.stderr, /qa\/F-QA-002: fix empty/);
    assert.match(r.stderr, /qa\/F-QA-003: fix empty/);
    // No merged-artifact output may be written when violations are present.
    assert.throws(
      () => readAggregate(stagingDir),
      /ENOENT/,
      'aggregate output must not be written when violations are present',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Whitespace-only fix must be rejected just like whitespace-only description.
// Previously the fix predicate only rejected `null` / `''`, letting `"   "`
// slip through and be emitted as a literal whitespace-only fix block.
test('aggregate-findings: whitespace-only fix rejected without --allow-partial', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - id: F-QA-001
    severity: medium
    file: src/z.ts
    line: 5
    ruleId: missing-test
    title: "whitespace-only fix"
    description: "real description"
    fix: "    "
    pinsFiles: [src/z.ts]`,
    );
    const r = run(root);
    assert.equal(r.exitCode, 1, `expected exit 1, got ${r.exitCode}`);
    assert.match(r.stderr, /qa\/F-QA-001: fix empty/);
    assert.throws(() => readAggregate(stagingDir), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: --allow-partial must not crash on id-less template-defaulted
// findings. Previously the post-merge sort comparator dereferenced an
// undefined id via .localeCompare() and threw TypeError. Two findings (both
// missing id) are needed to actually drive the comparator (a single-group
// sort never compares ids); we also assert the orphan-id default is emitted
// so the aggregate downstream stays correlatable.
test('aggregate-findings: --allow-partial does not crash on id-less template-defaulted findings', () => {
  const { root, stagingDir } = makeFeatDir();
  try {
    writeLane(
      stagingDir,
      'qa',
      `lane: qa
findings:
  - severity: low
    file: src/x.ts
    line: 1
    ruleId: missing-test
    title: "no id, no description"
    pinsFiles: [src/x.ts]
  - severity: low
    file: src/y.ts
    line: 2
    ruleId: missing-coverage
    title: "second id-less finding"
    pinsFiles: [src/y.ts]`,
    );
    const r = run(root, ['--allow-partial']);
    assert.equal(r.exitCode, 0, `unexpected failure: ${r.stderr}`);
    assert.doesNotMatch(
      r.stderr,
      /localeCompare/,
      'sort comparator must not throw on undefined id',
    );
    assert.match(r.stderr, /template-defaulted/);
    const out = readAggregate(stagingDir);
    assert.match(out, /totalFindings: 2/);
    // Both orphan ids surface in mergedFrom — proves the id-default fired.
    assert.match(out, /qa-orphan-1/);
    assert.match(out, /qa-orphan-2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
