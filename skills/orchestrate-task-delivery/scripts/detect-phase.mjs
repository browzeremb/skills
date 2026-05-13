#!/usr/bin/env node
/**
 * detect-phase.mjs — filesystem-driven phase detector for orchestrate-task-delivery
 *
 * Reads docs/browzer/<feat>/ and returns the next phase to dispatch as JSON.
 * Implements the state machine transition table in
 * ${CLAUDE_SKILL_DIR}/references/state-machine.md.
 *
 * Includes a cycle guard: reads the last MAX_REPEAT transitions from
 * DELEGATION_TRACE.md; refuses to repeat the same (from → next) more than
 * MAX_REPEAT times consecutively.
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

function readVerdict(featDir, filename) {
  const p = join(featDir, filename);
  if (!fileExists(p)) return null;
  return parseFmKv(readFileSync(p, 'utf8'), 'verdict');
}

function readSeverityHigh(featDir) {
  // Detect any FIX_F-*.tech_debt.md with severity: high
  for (const e of listGlob(featDir, /^FIX_F-\d+\.tech_debt\.md$/)) {
    const sev = parseFmKv(readFileSync(join(featDir, e), 'utf8'), 'severity');
    if (sev === 'high') return e;
  }
  return null;
}

function readTotalFindings(featDir) {
  const p = join(featDir, 'CODE_REVIEW.md');
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

function readTraceTail(featDir) {
  const p = join(featDir, 'DELEGATION_TRACE.md');
  if (!fileExists(p)) return [];
  const lines = readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => /^- /.test(l));
  return lines.slice(-MAX_REPEAT * 2);
}

function cycleDetected(featDir, fromState, nextPhase) {
  const tail = readTraceTail(featDir);
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
  const result = { featureId, state: '', nextPhase: null, args: [], notes: '' };

  // Row #1 — feat folder does not exist
  if (!dirExists(featDir)) {
    result.state = 'no-feat-folder';
    result.nextPhase = 'INIT';
    result.notes =
      'orchestrator must create CONFIG.md and run brainstorming or generate-prd';
    emit(result, asJson);
    process.exit(0);
  }

  const has = (f) => fileExists(join(featDir, f));
  const tasksMd = listGlob(featDir, /^TASK_\d+\.md$/);
  const tasksCompleted = listGlob(featDir, /^TASK_\d+\.completed\.md$/);
  const tasksFailed = listGlob(featDir, /^TASK_\d+\.failed\.md$/);

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
  // Row #8 — All tasks completed, no code-review
  else if (tasksCompleted.length > 0 && !has('CODE_REVIEW.md')) {
    result.state = 'tasks-done-no-review';
    result.nextPhase = 'code-review';
    result.args = [featureId];
  }
  // Row #9 — Code-review with 0 findings, no tests → skip receiving-code-review
  else if (
    has('CODE_REVIEW.md') &&
    readTotalFindings(featDir) === 0 &&
    !has('TESTS.md')
  ) {
    result.state = 'review-no-findings';
    result.nextPhase = 'write-tests';
    result.args = [featureId];
    result.notes = 'skipping receiving-code-review (totalFindings == 0)';
  }
  // Row #10 — Code-review with findings, no receiving-code-review
  else if (has('CODE_REVIEW.md') && !has('RECEIVING_CODE_REVIEW.md')) {
    result.state = 'review-has-findings';
    result.nextPhase = 'receiving-code-review';
    result.args = [featureId];
  }
  // Row #11 — High-severity tech-debt without override → HALT
  else if (
    readSeverityHigh(featDir) &&
    !fileExists('.browzer/accepted-tech-debt.json')
  ) {
    const file = readSeverityHigh(featDir);
    result.state = 'tech-debt-high-no-override';
    result.nextPhase = null;
    result.notes = `HALT — high-severity tech-debt: ${file}; operator must triage`;
    emit(result, asJson);
    process.exit(3);
  }
  // Row #12 — receiving-code-review done, no tests
  else if (has('RECEIVING_CODE_REVIEW.md') && !has('TESTS.md')) {
    result.state = 'fixes-done-no-tests';
    result.nextPhase = 'write-tests';
    result.args = [featureId];
  }
  // Row #13 — tests done, no doc-patches
  else if (has('TESTS.md') && !has('DOC_PATCHES.md')) {
    result.state = 'tests-done-no-docs';
    result.nextPhase = 'update-docs';
    result.args = [featureId];
  }
  // Row #14 — doc-patches done, no acceptance
  else if (has('DOC_PATCHES.md') && !has('ACCEPTANCE.md')) {
    const configMode = has('CONFIG.md')
      ? parseFmKv(
          readFileSync(join(featDir, 'CONFIG.md'), 'utf8'),
          'acceptanceMode',
        ) || 'hybrid'
      : 'hybrid';
    result.state = 'docs-done-no-acceptance';
    result.nextPhase = 'feature-acceptance';
    result.args = [featureId, configMode];
  }
  // Row #15 — acceptance rejected → HALT
  else if (readVerdict(featDir, 'ACCEPTANCE.md') === 'rejected') {
    result.state = 'acceptance-rejected';
    result.nextPhase = null;
    result.notes =
      'HALT — ACCEPTANCE.md verdict is rejected; operator must triage';
    emit(result, asJson);
    process.exit(3);
  }
  // Row #16 — acceptance accepted, no README
  else if (
    readVerdict(featDir, 'ACCEPTANCE.md') === 'accepted' &&
    !has('README.md')
  ) {
    result.state = 'accepted-no-readme';
    result.nextPhase = 'finalize-feature';
    result.args = [featureId];
  }
  // Row #17 — README exists, git dirty
  else if (has('README.md') && !isGitClean(featDir)) {
    result.state = 'readme-uncommitted';
    result.nextPhase = 'commit';
    result.args = [featureId];
  }
  // Row #18 — DONE
  else {
    result.state = 'done';
    result.nextPhase = null;
    result.notes = 'DONE — all phases complete, git clean for this feat folder';
    emit(result, asJson);
    process.exit(5);
  }

  // Cycle guard
  if (
    result.nextPhase &&
    cycleDetected(featDir, result.state, result.nextPhase)
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
