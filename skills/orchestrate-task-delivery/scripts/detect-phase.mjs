#!/usr/bin/env node

/**
 * detect-phase.mjs — filesystem-driven phase detector for orchestrate-task-delivery
 *
 * Reads docs/browzer/<feat>/staging/ (six per-phase subfolders) and returns the
 * next phase to dispatch as JSON. `README.md` is the only artefact at the feat
 * root (committed); every other workflow file lives under `staging/`
 * (gitignored).
 *
 * Tier-aware: reads `CONFIG.tier` from `staging/CONFIG.md` and routes
 * per `${CLAUDE_SKILL_DIR}/references/tier-dispatch-table.md`. When
 * the tier field is absent (feats predating the probe), defaults to
 * `full` to preserve current behaviour.
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

function listGlob(dir, regex) {
  try {
    return readdirSync(dir).filter((e) => regex.test(e));
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

function parseFmInt(text, key) {
  const v = parseFmKv(text, key);
  if (v === null || v === '' || v === 'null') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function readConfig(stagingDir) {
  const p = join(stagingDir, 'CONFIG.md');
  if (!fileExists(p))
    return { tier: null, acceptanceMode: null, regressionGuardRound: 1 };
  const text = readFileSync(p, 'utf8');
  return {
    tier: parseFmKv(text, 'tier'),
    acceptanceMode: parseFmKv(text, 'acceptanceMode'),
    regressionGuardRound: parseFmInt(text, 'regressionGuardRound') ?? 1,
  };
}

function readVerdict(absPath) {
  if (!fileExists(absPath)) return null;
  return parseFmKv(readFileSync(absPath, 'utf8'), 'verdict');
}

function readSeverityHigh(fixesDir) {
  for (const e of listGlob(fixesDir, /^F-\d+\.tech_debt\.md$/)) {
    const sev = parseFmKv(readFileSync(join(fixesDir, e), 'utf8'), 'severity');
    if (sev === 'high') return e;
  }
  return null;
}

function readFindingsCount(reviewDir) {
  const p = join(reviewDir, 'CODE_REVIEW.md');
  if (!fileExists(p)) return null;
  const text = readFileSync(p, 'utf8');
  // Two shapes are valid: a precomputed `totalFindings:` counter, or a
  // `findings:` block we count by `- id:` bullets. Either parses to the same
  // result.
  const total = text.match(/^totalFindings:\s*(\d+)/m);
  if (total) return parseInt(total[1], 10);
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const findingsBlock = fm[1].match(
    /^findings:\s*\n([\s\S]*?)(?=^[A-Za-z][^\n]*:|z)/m,
  );
  if (!findingsBlock) return 0;
  return (findingsBlock[1].match(/^\s+-\s+id:/gm) || []).length;
}

function readGateAnyFailed(reviewDir) {
  const p = join(reviewDir, 'GATE_REPORT.md');
  if (!fileExists(p)) return null;
  const text = readFileSync(p, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const block = fm[1].match(
    /^gateResults:\s*\n([\s\S]*?)(?=^[A-Za-z][^\n]*:|z)/m,
  );
  if (!block) return false;
  return /^\s+\w+:\s*fail\b/m.test(block[1]);
}

function readGateOverride(acceptanceDir) {
  const p = join(acceptanceDir, 'ACCEPTANCE.md');
  if (!fileExists(p)) return false;
  const text = readFileSync(p, 'utf8');
  return /^gateOverride:\s*\n/m.test(text) || /^gateOverride:\s*\{/m.test(text);
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
// `Feature: <featureId>` as a body trailer; scanning for that pattern catches
// the case where the operator cleaned up the feat-root (deleting README.md per
// cleanup discipline) and the state machine would otherwise regress to an
// earlier phase.
function hasCommittedFeature(featureId, featDir) {
  try {
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

// Resolve the effective tier from CONFIG.md. Unset / null defaults to `full`
// per the zero-config rule in tier-dispatch-table.md.
function resolveTier(stagingDir) {
  const cfg = readConfig(stagingDir);
  if (!cfg.tier || cfg.tier === 'null' || cfg.tier === '') return 'full';
  if (!['express', 'standard', 'full'].includes(cfg.tier)) return 'full';
  return cfg.tier;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const featureId = args.find((a) => /^feat-\d{8}-[a-z0-9-]+$/.test(a));
  if (!featureId) die('usage: detect-phase <featureId> [--json]', 2);

  const featDir = resolve('docs', 'browzer', featureId);
  const stagingDir = join(featDir, 'staging');
  const planningDir = join(stagingDir, 'planning');
  const tasksDir = join(stagingDir, 'tasks');
  const reviewDir = join(stagingDir, 'review');
  const reviewLanesDir = join(stagingDir, 'review-lanes');
  const fixesDir = join(stagingDir, 'fixes');
  const acceptanceDir = join(stagingDir, 'acceptance');

  const result = {
    featureId,
    state: '',
    nextPhase: null,
    args: [],
    notes: '',
    tier: null,
  };

  // Row #1 — feat folder does not exist
  if (!dirExists(featDir)) {
    result.state = 'no-feat-folder';
    result.nextPhase = 'INIT';
    result.notes =
      'orchestrator must create staging/ + six subfolders + CONFIG.md and run brainstorming / probe-tier / generate-prd';
    emit(result, asJson);
    process.exit(0);
  }

  // Row #1 — feat folder exists but staging/ does not (fresh init or legacy
  // flat layout pending migration). Orchestrator INIT handles both.
  if (!dirExists(stagingDir)) {
    result.state = 'no-staging-folder';
    result.nextPhase = 'INIT';
    result.notes =
      'staging/ subfolder missing — orchestrator must init (or migrate legacy flat layout per feature-folder-layout.md)';
    emit(result, asJson);
    process.exit(0);
  }

  // Row #1.5 — CONFIG.md missing OR tier unset → PROBE-TIER
  const config = readConfig(stagingDir);
  result.tier = resolveTier(stagingDir);
  if (!fileExists(join(stagingDir, 'CONFIG.md')) || !config.tier) {
    result.state = 'config-no-tier';
    result.nextPhase = 'PROBE-TIER';
    result.args = [featureId];
    result.notes =
      'CONFIG.tier unset — orchestrator must run scripts/probe-tier.mjs (or honour --tier= override)';
    emit(result, asJson);
    process.exit(0);
  }

  const tier = result.tier;

  const tasksMd = listGlob(tasksDir, /^TASK_\d+\.md$/);
  const tasksCompleted = listGlob(tasksDir, /^TASK_\d+\.completed\.md$/);
  const tasksFailed = listGlob(tasksDir, /^TASK_\d+\.failed\.md$/);

  const hasPlanning = (f) => fileExists(join(planningDir, f));
  const hasReview = (f) => fileExists(join(reviewDir, f));
  const hasAcceptance = (f) => fileExists(join(acceptanceDir, f));
  const hasFixes = (f) => fileExists(join(fixesDir, f));
  const fixesPresent = () =>
    listGlob(fixesDir, /^F-\d+\.(completed|tech_debt)\.md$/).length > 0;
  const hasAtRoot = (f) => fileExists(join(featDir, f));

  // Row #2 — BRIEF.md missing, PRD.md missing → brainstorming
  // (express tier may also skip when probe shows briefClarity = all-3-present;
  // the orchestrator's intent-detection heuristic handles that path before
  // dispatching brainstorming).
  if (!hasPlanning('BRIEF.md') && !hasPlanning('PRD.md')) {
    result.state = 'init-no-brief-no-prd';
    result.nextPhase = 'brainstorming';
    result.args = [featureId];
  }
  // Row #3 — PRD missing, brief exists (or skip path)
  else if (!hasPlanning('PRD.md') && tier !== 'express') {
    result.state = 'brief-no-prd';
    result.nextPhase = 'generate-prd';
    result.args = [featureId];
  }
  // Row #3 express — orchestrator writes inline PRD-compact section into BRIEF.md
  else if (
    !hasPlanning('PRD.md') &&
    tier === 'express' &&
    !hasPlanningPrdCompact(planningDir)
  ) {
    result.state = 'express-no-prd-compact';
    result.nextPhase = 'INLINE-PRD-IN-BRIEF';
    result.args = [featureId];
  }
  // Row #4 — PRD exists (or express skipped), EXPLORATION missing (standard/full only)
  else if (
    !hasPlanning('EXPLORATION.md') &&
    tier !== 'express' &&
    tasksMd.length === 0 &&
    tasksCompleted.length === 0
  ) {
    result.state = 'prd-no-exploration';
    result.nextPhase = 'scope-feature';
    result.args = [featureId];
  }
  // Row #5 — No tasks yet (express inline-writes TASK_01)
  else if (
    tasksMd.length === 0 &&
    tasksCompleted.length === 0 &&
    tasksFailed.length === 0
  ) {
    if (tier === 'express') {
      result.state = 'express-no-task-01';
      result.nextPhase = 'INLINE-TASK_01';
      result.args = [featureId];
    } else {
      result.state = 'exploration-no-tasks';
      result.nextPhase = 'generate-task';
      result.args = [featureId];
    }
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
  // Row #8 — All tasks completed, no CODE_REVIEW.md
  else if (tasksCompleted.length > 0 && !hasReview('CODE_REVIEW.md')) {
    result.state = 'tasks-done-no-review';
    result.nextPhase = 'code-review';
    result.args = [featureId];
  }
  // Row #9 — Code-review with 0 findings AND no fixes → skip to feature-acceptance
  else if (
    hasReview('CODE_REVIEW.md') &&
    readFindingsCount(reviewDir) === 0 &&
    !fixesPresent() &&
    !hasAcceptance('ACCEPTANCE.md')
  ) {
    result.state = 'review-no-findings';
    result.nextPhase = 'feature-acceptance';
    const mode = config.acceptanceMode || defaultModeForTier(tier);
    result.args = [featureId, mode];
    result.notes =
      'skipping receiving-code-review AND regression-guard (findings empty, fixes/ empty)';
  }
  // Row #10 — Code-review with findings, FIXES.md not yet aggregated
  else if (
    hasReview('CODE_REVIEW.md') &&
    readFindingsCount(reviewDir) > 0 &&
    !hasFixes('FIXES.md')
  ) {
    // Row #12a — regression-guard rerun sentinel (round 2/3 fixers)
    if (fileExists(join(stagingDir, '.regression-guard-rerun'))) {
      result.state = 'regression-guard-rerun';
      result.nextPhase = 'receiving-code-review';
      result.args = [featureId];
    } else {
      result.state = 'review-has-findings';
      result.nextPhase = 'receiving-code-review';
      result.args = [featureId];
    }
  }
  // Row #11 — High-severity tech-debt without override → HALT
  else if (
    readSeverityHigh(fixesDir) &&
    !fileExists('.browzer/accepted-tech-debt.json')
  ) {
    const file = readSeverityHigh(fixesDir);
    result.state = 'tech-debt-high-no-override';
    result.nextPhase = null;
    result.notes = `HALT — high-severity tech-debt: fixes/${file}; operator must triage`;
    emit(result, asJson);
    process.exit(3);
  }
  // Row #12 — FIXES.md present, GATE_REPORT.md missing → regression-guard
  else if (hasFixes('FIXES.md') && !hasReview('GATE_REPORT.md')) {
    result.state = 'fixes-done-no-gate-report';
    result.nextPhase = 'regression-guard';
    result.args = [featureId];
  }
  // Row #12b — GATE_REPORT.md says fail AND round == 3 (no override) → HALT
  else if (
    hasReview('GATE_REPORT.md') &&
    readGateAnyFailed(reviewDir) &&
    config.regressionGuardRound >= 3 &&
    !readGateOverride(acceptanceDir)
  ) {
    result.state = 'regression-guard-max-rounds';
    result.nextPhase = null;
    result.notes =
      'HALT — regression-guard: exceeded max rounds (3); operator must inspect or pass --override-gate';
    emit(result, asJson);
    process.exit(3);
  }
  // Row #13 — Gate passed (or override), no ACCEPTANCE.md
  else if (
    hasFixes('FIXES.md') &&
    hasReview('GATE_REPORT.md') &&
    (!readGateAnyFailed(reviewDir) || readGateOverride(acceptanceDir)) &&
    !hasAcceptance('ACCEPTANCE.md')
  ) {
    const mode = config.acceptanceMode || defaultModeForTier(tier);
    result.state = 'fixes-done-no-acceptance';
    result.nextPhase = 'feature-acceptance';
    result.args = [featureId, mode];
  }
  // Row #14 — acceptance rejected → HALT
  else if (readVerdict(join(acceptanceDir, 'ACCEPTANCE.md')) === 'rejected') {
    result.state = 'acceptance-rejected';
    result.nextPhase = null;
    result.notes =
      'HALT — ACCEPTANCE.md verdict is rejected; operator must triage';
    emit(result, asJson);
    process.exit(3);
  }
  // Row #15 — acceptance accepted, finalize-feature handles Phase A + Phase B
  else if (
    readVerdict(join(acceptanceDir, 'ACCEPTANCE.md')) === 'accepted' &&
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
  // Row #17 — README exists, git clean → DONE
  else if (hasAtRoot('README.md') && isGitClean(featDir)) {
    result.state = 'done';
    result.nextPhase = null;
    result.notes = 'DONE — all phases complete, git clean for this feat folder';
    emit(result, asJson);
    process.exit(5);
  }
  // Row #18 — Post-commit recovery via git log trailer
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

// Express tier's inline PRD-compact write places a `## PRD-compact` heading
// inside planning/BRIEF.md. Detect it so we don't loop back to the inline-write
// state once the heading is present.
function hasPlanningPrdCompact(planningDir) {
  const p = join(planningDir, 'BRIEF.md');
  if (!fileExists(p)) return false;
  return /^##\s+PRD-compact\b/m.test(readFileSync(p, 'utf8'));
}

function defaultModeForTier(tier) {
  if (tier === 'express') return 'smoke';
  if (tier === 'standard') return 'hybrid';
  return 'autonomous-with-stack-boot';
}

main();
