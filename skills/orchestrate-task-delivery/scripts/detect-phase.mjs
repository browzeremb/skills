#!/usr/bin/env node

/**
 * detect-phase.mjs — filesystem-driven phase detector for orchestrate-task-delivery
 *
 * Reads docs/browzer/<feat>/staging/ and returns the next phase to dispatch as JSON.
 * `README.md` is the only artefact at the feat root (committed); every other
 * workflow file lives under `staging/` (gitignored). Implements the state
 * machine transition table in
 * ${CLAUDE_SKILL_DIR}/references/state-machine.md.
 *
 * Includes a cycle guard: reads the last MAX_REPEAT transitions from
 * staging/DELEGATION_TRACE.md; refuses to repeat the same (from → next) more
 * than MAX_REPEAT times consecutively.
 *
 * Usage:
 *   node detect-phase.mjs <featureId> [--json]
 *
 * Exit codes:
 *   0   next phase identified (printed)
 *   2   bad usage
 *   3   HALT condition (operator must act)
 *   4   cycle detected (orchestrator must stop)
 *   5   DONE (terminal state)
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_REPEAT = 3;

function die(msg, code = 1) {
  process.stderr.write(`detect-phase: ${msg}\n`);
  process.exit(code);
}

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listGlob(featDir, regex) {
  try {
    return readdirSync(featDir).filter((e) => regex.test(e));
  } catch {
    return [];
  }
}

function parseFmKv(text, key) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const re = new RegExp(`^${key}:\\s*"?(.+?)"?$`, 'm');
  return (fm[1].match(re) || [])[1] ?? null;
}

function readVerdict(dir, filename) {
  const p = join(dir, filename);
  if (!fileExists(p)) return null;
  return parseFmKv(readFileSync(p, 'utf8'), 'verdict');
}

function readSeverityHigh(dir) {
  // Detect any FIX_F-*.tech_debt.md with severity: high
  for (const e of listGlob(dir, /^FIX_F-\d+\.tech_debt\.md$/)) {
    const sev = parseFmKv(readFileSync(join(dir, e), 'utf8'), 'severity');
    if (sev === 'high') return e;
  }
  return null;
}

function readTotalFindings(dir) {
  const p = join(dir, 'CODE_REVIEW.md');
  if (!fileExists(p)) return null;
  const m = readFileSync(p, 'utf8').match(/^totalFindings:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : null;
}

function isGitClean(featDir) {
  try {
    const out = execSync(`git status --porcelain -- "${featDir}"`, {
      encoding: 'utf8',
    }).trim();
    return out === '';
  } catch {
    return true;
  }
}

// Detect post-commit DONE state via git log. The skill `commit` writes
// `Feature: <featureId>` as a body trailer; scanning for that pattern in the
// recent commit history catches the case where the operator cleaned up the
// feat-root (deleting README.md per cleanup discipline) and the state machine
// would otherwise regress to an earlier phase. RETRO §3.1 documents the
// symptom.
function hasCommittedFeature(featureId, featDir) {
  try {
    // -- on featDir narrows the log to commits that touched this folder; the
    // grep matches the canonical trailer pattern. The combination avoids both
    // global-history scans and false positives from cherry-picks across
    // unrelated branches.
    const out = execSync(
      `git log --grep="Feature: ${featureId}" --max-count=1 --pretty=format:%H -- "${featDir}"`,
      { encoding: 'utf8' },
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function readTraceTail(stagingDir) {
  const p = join(stagingDir, 'DELEGATION_TRACE.md');
  if (!fileExists(p)) return [];
  const lines = readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => /^- /.test(l));
  return lines.slice(-MAX_REPEAT * 2);
}

function cycleDetected(stagingDir, fromState, nextPhase) {
  const tail = readTraceTail(stagingDir);
  if (tail.length < MAX_REPEAT) return false;
  const re = new RegExp(
    `${escapeRe(fromState)}\\s*→\\s*${escapeRe(nextPhase)}`,
  );
  let consecutive = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (re.test(tail[i])) consecutive++;
    else break;
  }
  return consecutive >= MAX_REPEAT;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emit(result, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`${result.state} → ${result.nextPhase || '(none)'}\n`);
    if (result.notes) process.stdout.write(`  ${result.notes}\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const featureId = args.find((a) => /^feat-\d{8}-[a-z0-9-]+$/.test(a));
  if (!featureId) die('usage: detect-phase <featureId> [--json]', 2);

  const featDir = resolve('docs', 'browzer', featureId);
  const stagingDir = join(featDir, 'staging');
  const result = { featureId, state: '', nextPhase: null, args: [], notes: '' };

  // Row #1 — feat folder does not exist
  if (!dirExists(featDir)) {
    result.state = 'no-feat-folder';
    result.nextPhase = 'INIT';
    result.notes =
      'orchestrator must create staging/ + CONFIG.md and run brainstorming or generate-prd';
    emit(result, asJson);
    process.exit(0);
  }

  // Row #1a — feat folder exists but staging/ does not (fresh init or legacy
  // flat layout pending migration). Orchestrator INIT handles both.
  if (!dirExists(stagingDir)) {
    result.state = 'no-staging-folder';
    result.nextPhase = 'INIT';
    result.notes =
      'staging/ subfolder missing — orchestrator must init or migrate legacy flat layout per feature-folder-layout.md';
    emit(result, asJson);
    process.exit(0);
  }

  const has = (f) => fileExists(join(stagingDir, f));
  const hasAtRoot = (f) => fileExists(join(featDir, f));
  const tasksMd = listGlob(stagingDir, /^TASK_\d+\.md$/);
  const tasksCompleted = listGlob(stagingDir, /^TASK_\d+\.completed\.md$/);
  const tasksFailed = listGlob(stagingDir, /^TASK_\d+\.failed\.md$/);

  // Row #2 — BRIEF.md missing, PRD.md missing → brainstorming
  if (!has('BRIEF.md') && !has('PRD.md')) {
    result.state = 'init-no-brief-no-prd';
    result.nextPhase = 'brainstorming';
    result.args = [featureId];
  }
  // Row #3 — PRD missing, brief OR skip → generate-prd
  else if (!has('PRD.md')) {
    result.state = 'brief-no-prd';
    result.nextPhase = 'generate-prd';
    result.args = [featureId];
  }
  // Row #4 — PRD exists, EXPLORATION missing
  else if (!has('EXPLORATION.md')) {
    result.state = 'prd-no-exploration';
    result.nextPhase = 'scope-feature';
    result.args = [featureId];
  }
  // Row #5 — EXPLORATION exists, no tasks
  else if (
    tasksMd.length === 0 &&
    tasksCompleted.length === 0 &&
    tasksFailed.length === 0
  ) {
    result.state = 'exploration-no-tasks';
    result.nextPhase = 'generate-task';
    result.args = [featureId];
  }
  // Row #6 — Any failed task → HALT
  else if (tasksFailed.length > 0) {
    result.state = 'tasks-failed';
    result.nextPhase = null;
    result.notes = `HALT — failed tasks: ${tasksFailed.join(', ')}; re-run /execute-task on each`;
    emit(result, asJson);
    process.exit(3);
  }
  // Row #7 — Pending tasks remain
  else if (tasksMd.length > 0) {
    result.state = 'tasks-pending';
    result.nextPhase = 'execute-task';
    result.args = [featureId];
  }
  // Row #8 — All tasks completed, no TESTS.md → write-tests FIRST (before
  // code-review). Rationale: tests written before review let the qa lane
  // weigh surviving mutants when grading; review then becomes a
  // contract+correctness check informed by mutation evidence. RETRO §15
  // #2 + JUDGMENT §3.15 both propose this reordering.
  else if (tasksCompleted.length > 0 && !has('TESTS.md')) {
    result.state = 'tasks-done-no-tests';
    result.nextPhase = 'write-tests';
    result.args = [featureId];
  }
  // Row #9 — Tests done, no code-review
  else if (has('TESTS.md') && !has('CODE_REVIEW.md')) {
    result.state = 'tests-done-no-review';
    result.nextPhase = 'code-review';
    result.args = [featureId];
  }
  // Row #10 — Code-review with 0 findings → skip to feature-acceptance
  else if (
    has('CODE_REVIEW.md') &&
    readTotalFindings(stagingDir) === 0 &&
    !has('ACCEPTANCE.md')
  ) {
    result.state = 'review-no-findings';
    result.nextPhase = 'feature-acceptance';
    const configMode = has('CONFIG.md')
      ? parseFmKv(
          readFileSync(join(stagingDir, 'CONFIG.md'), 'utf8'),
          'acceptanceMode',
        ) || 'hybrid'
      : 'hybrid';
    result.args = [featureId, configMode];
    result.notes = 'skipping receiving-code-review (totalFindings == 0)';
  }
  // Row #11 — Code-review with findings, no receiving-code-review
  else if (has('CODE_REVIEW.md') && !has('RECEIVING_CODE_REVIEW.md')) {
    result.state = 'review-has-findings';
    result.nextPhase = 'receiving-code-review';
    result.args = [featureId];
  }
  // Row #12 — High-severity tech-debt without override → HALT
  else if (
    readSeverityHigh(stagingDir) &&
    !fileExists('.browzer/accepted-tech-debt.json')
  ) {
    const file = readSeverityHigh(stagingDir);
    result.state = 'tech-debt-high-no-override';
    result.nextPhase = null;
    result.notes = `HALT — high-severity tech-debt: ${file}; operator must triage`;
    emit(result, asJson);
    process.exit(3);
  }
  // Row #13 — receiving-code-review done, no acceptance
  else if (has('RECEIVING_CODE_REVIEW.md') && !has('ACCEPTANCE.md')) {
    const configMode = has('CONFIG.md')
      ? parseFmKv(
          readFileSync(join(stagingDir, 'CONFIG.md'), 'utf8'),
          'acceptanceMode',
        ) || 'hybrid'
      : 'hybrid';
    result.state = 'fixes-done-no-acceptance';
    result.nextPhase = 'feature-acceptance';
    result.args = [featureId, configMode];
  }
  // Row #14 — acceptance rejected → HALT
  else if (readVerdict(stagingDir, 'ACCEPTANCE.md') === 'rejected') {
    result.state = 'acceptance-rejected';
    result.nextPhase = null;
    result.notes =
      'HALT — ACCEPTANCE.md verdict is rejected; operator must triage';
    emit(result, asJson);
    process.exit(3);
  }
  // Row #15 — acceptance accepted, finalize-feature handles BOTH doc patching
  // (Phase A, inline — replaces the legacy standalone update-docs phase) AND
  // README rendering (Phase B). DOC_PATCHES.md is produced as a side effect of
  // Phase A; the state machine routes on README presence at feat-root.
  else if (
    readVerdict(stagingDir, 'ACCEPTANCE.md') === 'accepted' &&
    !hasAtRoot('README.md')
  ) {
    result.state = 'accepted-no-readme';
    result.nextPhase = 'finalize-feature';
    result.args = [featureId];
  }
  // Row #16 — README exists, git dirty
  else if (hasAtRoot('README.md') && !isGitClean(featDir)) {
    result.state = 'readme-uncommitted';
    result.nextPhase = 'commit';
    result.args = [featureId];
  }
  // Row #17 — README exists, git clean → DONE (filesystem-driven check)
  else if (hasAtRoot('README.md') && isGitClean(featDir)) {
    result.state = 'done';
    result.nextPhase = null;
    result.notes = 'DONE — all phases complete, git clean for this feat folder';
    emit(result, asJson);
    process.exit(5);
  }
  // Row #18 — Post-commit recovery (README cleaned up by operator OR feat-root
  // wiped, but commit landed). Detect via the `Feature: <featureId>` trailer
  // pattern that `commit` writes. RETRO §3.1 / R9 documents the bandaid that
  // this row eliminates.
  else if (hasCommittedFeature(featureId, featDir)) {
    result.state = 'done-via-git-log';
    result.nextPhase = null;
    result.notes = `DONE — commit with trailer 'Feature: ${featureId}' found in git log; feat-root cleaned`;
    emit(result, asJson);
    process.exit(5);
  }
  // Row #19 — fall-through (no other state matched) → DONE-but-degraded so
  // the orchestrator doesn't loop forever on an inconsistent staging/.
  else {
    result.state = 'done';
    result.nextPhase = null;
    result.notes = 'DONE — no further transition applies';
    emit(result, asJson);
    process.exit(5);
  }

  // Cycle guard
  if (
    result.nextPhase &&
    cycleDetected(stagingDir, result.state, result.nextPhase)
  ) {
    result.notes = `CYCLE — ${result.state} → ${result.nextPhase} has fired ${MAX_REPEAT}+ times consecutively; operator must inspect`;
    result.nextPhase = null;
    emit(result, asJson);
    process.exit(4);
  }

  emit(result, asJson);
  process.exit(0);
}

main();
