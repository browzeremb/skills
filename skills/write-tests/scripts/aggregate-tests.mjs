#!/usr/bin/env node
/**
 * aggregate-tests.mjs — assemble TESTS.md frontmatter from tester subagent output
 *
 * The tester subagent emits a discovery receipt at /tmp/write-tests-<feat>-summary.json
 * with the structured shape this script expects. We render the canonical
 * TESTS.md (frontmatter + body) atomically.
 *
 * Usage: node aggregate-tests.mjs <featureId>
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';

function die(msg, code = 1) {
  process.stderr.write(`aggregate-tests: ${msg}\n`);
  process.exit(code);
}

function atomicWrite(path, content) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// Surface test files the tester likely created without recording in its
// receipt. Looks at both staged and unstaged changes plus untracked files;
// filters to extensions + path shapes commonly used by test runners.
function recoverTestFilesFromGit() {
  const out = new Set();
  const TEST_RE =
    /(\.test\.(ts|tsx|js|mjs|cjs)|_test\.(go|py)|\/test_[^/]+\.py|\.spec\.(ts|tsx|js|mjs|cjs))$/;
  const runs = [
    ['git', ['diff', '--name-only']],
    ['git', ['diff', '--cached', '--name-only']],
    ['git', ['ls-files', '--others', '--exclude-standard']],
  ];
  for (const [cmd, args] of runs) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0) continue;
    for (const line of r.stdout.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      if (TEST_RE.test(p)) out.add(p);
    }
  }
  return [...out];
}

function scanReceipts(featureId) {
  const SCAN_ROOTS = [tmpdir(), '/tmp'];
  const seen = new Set();
  const items = [];
  for (const root of SCAN_ROOTS) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!new RegExp(`^write-tests-${featureId}-summary\\.json$`).test(e))
        continue;
      if (seen.has(e)) continue;
      seen.add(e);
      const full = join(root, e);
      try {
        items.push({
          path: full,
          mtime: statSync(full).mtimeMs,
          content: JSON.parse(readFileSync(full, 'utf8')),
        });
      } catch {}
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

function readPrdSha(stagingDir) {
  for (const candidate of ['RECEIVING_CODE_REVIEW.md', 'CODE_REVIEW.md']) {
    const p = join(stagingDir, candidate);
    if (existsSync(p)) {
      const fm = readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const m = fm[1].match(/^prdSha:\s*(\S+)/m);
        if (m) return m[1];
      }
    }
  }
  return '';
}

function main() {
  const featureId = process.argv[2];
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: aggregate-tests <featureId>', 2);
  }
  const featDir = resolve('docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  const receipts = scanReceipts(featureId);
  if (receipts.length === 0) {
    die(
      `no /tmp/write-tests-${featureId}-summary.json receipt found — tester subagent must emit one`,
      3,
    );
  }
  const data = receipts[0].content;

  // Receipt empty? Fall back to scanning the working tree for *.test.{ts,tsx,
  // js,mjs,cjs,go,py,rs} files that the tester subagent touched but failed to
  // record. The fallback is best-effort: it produces a `testsAdded[]` with
  // synthetic entries (no kill-rate, no pinsAcs), enough to surface in the
  // aggregate and signal a receipt-protocol violation to the operator.
  if (
    !data.skipped &&
    (!Array.isArray(data.testsAdded) || data.testsAdded.length === 0) &&
    (!Array.isArray(data.filesCreated) || data.filesCreated.length === 0)
  ) {
    const recovered = recoverTestFilesFromGit();
    if (recovered.length > 0) {
      process.stderr.write(
        `warning: receipt has empty testsAdded[] but git diff surfaces ${recovered.length} test file(s); synthesizing entries.\n`,
      );
      data.filesCreated = recovered.map((p) => ({ path: p, lineCount: 0 }));
      data.testsAdded = recovered.map((p, i) => ({
        testId: `T-${i + 1}-recovered`,
        file: p,
        symbolUnderTest: '(unknown — recovered from git diff)',
        intent: 'green',
        killedMutants: 0,
        totalMutants: 0,
      }));
    } else {
      // Empty glob: receipt empty AND git surfaces nothing. A hard `die`
      // here would block the orchestrator's write-tests phase on hosts
      // where the feature legitimately needed no test changes (e.g. a
      // docs-only refactor). Emit the structured skip signal and exit 0
      // so the next phase proceeds.
      process.stdout.write(
        JSON.stringify({
          testsFound: 0,
          skipped: true,
          reason: 'no-test-files',
        }),
      );
      process.stdout.write('\n');
      process.exit(0);
    }
  }

  const prdSha = readPrdSha(stagingDir);
  const skipped = !!data.skipped;
  const testsAdded = Array.isArray(data.testsAdded) ? data.testsAdded : [];
  const totalTests = testsAdded.length;
  const killedMutants = testsAdded.reduce(
    (acc, t) => acc + (t.killedMutants || 0),
    0,
  );
  const totalMutants = testsAdded.reduce(
    (acc, t) => acc + (t.totalMutants || 0),
    0,
  );
  // Distinguish "tool absent" from "tool ran, killed nothing" — both used to
  // collapse to killRate=0, which read as a RED FLAG when it was actually a
  // SKIP signal. JUDGMENT §3.4 #6 / J8 documents the ambiguity.
  //   killRate === null   → tool not detected on host; not measured.
  //   killRate === 0      → tool ran, killed zero mutants — RED FLAG.
  //   killRate ∈ (0, 1]   → measured rate.
  const mutationToolDetected = Boolean(data.mutationTool);
  const killRate = !mutationToolDetected
    ? null
    : totalMutants > 0
      ? Math.round((killedMutants / totalMutants) * 100) / 100
      : 0;
  const coverageGaps = Array.isArray(data.coverageGaps)
    ? data.coverageGaps.length
    : 0;

  const fm = {
    featureId,
    prdSha,
    generatedAt: new Date().toISOString(),
    runner: data.runner || null,
    mutationTool: data.mutationTool || null,
    skipped,
    ...(skipped
      ? { skipReason: data.skipReason || 'no rationale provided' }
      : {}),
    summary: {
      totalTests,
      killedMutants,
      totalMutants,
      killRate,
      coverageGaps,
    },
    testsAdded,
    mutationCategoriesCovered: Array.isArray(data.mutationCategoriesCovered)
      ? data.mutationCategoriesCovered
      : [],
  };

  const filesModified = Array.isArray(data.filesModified)
    ? data.filesModified
    : [];
  const filesCreated = Array.isArray(data.filesCreated)
    ? data.filesCreated
    : [];

  const body = [
    '# Tests added',
    '',
    '## Coverage log',
    '',
    '### Files modified',
    '',
    filesModified.length === 0
      ? '- (none)'
      : filesModified
          .map((f) => `- ${f.path} (+${f.added || 0}/-${f.removed || 0})`)
          .join('\n'),
    '',
    '### Files created',
    '',
    filesCreated.length === 0
      ? '- (none)'
      : filesCreated
          .map((f) => `- ${f.path} (+${f.lineCount || 0})`)
          .join('\n'),
    '',
    '### Tests added',
    '',
    testsAdded.length === 0
      ? '- (none)'
      : testsAdded
          .map(
            (t) =>
              `- ${t.testId} ${t.file}::${t.symbolUnderTest} ${t.intent} ${t.killedMutants || 0}/${t.totalMutants || 0}`,
          )
          .join('\n'),
    '',
    '## Mutation analysis',
    '',
    skipped
      ? `Test phase skipped: ${data.skipReason || 'no rationale provided'}`
      : killRate === null
        ? `Mutation: not measured (no mutation tool detected on host). Categories covered: ${(data.mutationCategoriesCovered || []).join(', ') || '(none)'}. Suggest installing the appropriate mutation runner for ${data.runner || 'this stack'} — see runner-detection.md §mutation-tool-recommendations.`
        : killRate === 0
          ? `Kill rate 0% (${killedMutants}/${totalMutants}) — **RED FLAG**: the test suite does not differentiate the code. Categories covered: ${(data.mutationCategoriesCovered || []).join(', ') || '(none)'}.`
          : `Kill rate ${(killRate * 100).toFixed(0)}% (${killedMutants}/${totalMutants}). Categories covered: ${(data.mutationCategoriesCovered || []).join(', ') || '(none)'}.`,
    '',
    coverageGaps > 0
      ? `## Coverage gaps\n\n${data.coverageGaps.map((g) => `- ${g.file}::${g.symbol} — ${g.reason}`).join('\n')}\n`
      : '',
    data.survivingMutants && data.survivingMutants.length > 0
      ? `## Surviving mutants\n\n${data.survivingMutants.map((s) => `- ${s.file}:${s.line} (${s.kind}) — ${s.rationale}`).join('\n')}\n`
      : '',
    skipped ? `## Skipped\n\n${data.skipReason}\n` : '',
  ].join('\n');

  const out = ['---', yamlStringify(fm).trimEnd(), '---', '', body].join('\n');
  const outPath = join(stagingDir, 'TESTS.md');
  atomicWrite(outPath, out);
  const killRateStr =
    killRate === null ? 'not measured' : `${killRate * 100}% kill rate`;
  console.log(`wrote ${outPath} (${totalTests} tests, ${killRateStr})`);
}

main();
