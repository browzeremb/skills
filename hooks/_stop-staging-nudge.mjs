#!/usr/bin/env node
// _stop-staging-nudge.mjs — Stop / SubagentStop hook entrypoint (FR-4).
//
// Fires when the agent is about to stop. Checks whether the most recently
// active workflow phase has its staging artifact on disk. If missing, emits
// an additionalContext nudge so the agent knows it must write the file before
// its turn is truly complete.
//
// Exit semantics:
//   0  silent — no in-flight phase, artifact present, or no workflow found
//   0  silent — active phase is PENDING (FR-6: only IN_PROGRESS triggers nudge)
//   0  silent — BROWZER_WORKFLOW_ID set but workflow.json not found (FR-9: strict scoping)
//   0  with JSON on stdout — artifact missing (non-blocking nudge)
//
// Performance: all I/O is synchronous. The hook MUST return within ~50ms
// (NFR-1). No spawned children, no network calls.
//
// Environment toggles:
//   BROWZER_AUTOSAVE=0   bypass entirely (debug, mirrors _auto-save-step)
//   BROWZER_WORKFLOW_ID  feature id hint — skips the mtime-based discovery

import fs from 'node:fs';
import path from 'node:path';
import { readHookInput } from './guards/_util.mjs';

// Virtual phases that can never have a staging artifact.
const VIRTUAL_PHASES = new Set(['CONFIG', 'ORIGINAL_REQUEST']);

// Phases whose staging artifact is a .md file; all others use .json.
const MD_PHASES = new Set(['PRD']);

// Regex matching workflow.json paths under docs/browzer/<feat>/workflow.json
const WORKFLOW_PATH_RE = /docs[/\\]browzer[/\\]([^/\\]+)[/\\]workflow\.json$/;

/**
 * Walk upward from `base`, looking for docs/browzer/ with at least one
 * workflow.json, then return the one with the highest mtime. Returns null when
 * none found within 20 ancestor hops.
 */
function findLatestWorkflowJson(base) {
  let dir = base;
  for (let i = 0; i < 20; i++) {
    const docsDir = path.join(dir, 'docs', 'browzer');
    if (fs.existsSync(docsDir)) {
      let best = null;
      let bestMtime = -1;
      let entries;
      try {
        entries = fs.readdirSync(docsDir);
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const candidate = path.join(docsDir, entry, 'workflow.json');
        try {
          const st = fs.statSync(candidate);
          if (st.isFile() && st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            best = candidate;
          }
        } catch {
          // not accessible
        }
      }
      if (best) return best;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Extract feat id from a workflow.json absolute path.
 */
function featFromPath(workflowPath) {
  const m = WORKFLOW_PATH_RE.exec(workflowPath);
  return m ? m[1] : null;
}

/**
 * Returns the FIRST step whose status is IN_PROGRESS. PENDING phases are
 * explicitly excluded per FR-6/R-19.
 *
 * FR-6 (R-19): only block Stop when the active phase status is IN_PROGRESS.
 * PENDING phases have not started yet — no staging artifact is expected, so
 * blocking for a missing artifact would be an over-eager false positive.
 * A PENDING step triggers a nudge ONLY when the immediately preceding step is
 * COMPLETED, indicating the phase is the immediate next-up that should have
 * started by now (dispatch-failure recovery path).
 *
 * For TASK-phase steps the workflow schema stores `name: "TASK"` (the literal
 * step type) and the per-task identifier in `taskId` (e.g. "TASK_01"). The
 * staging artifact is written as `staging/TASK_01.json`, so we must return
 * `taskId` rather than `name` when the two differ.
 */
function findInProgressPhase(workflowJson) {
  let parsed;
  try {
    parsed = JSON.parse(workflowJson);
  } catch {
    return null;
  }

  const steps = parsed?.steps;
  if (!Array.isArray(steps)) return null;

  // Walk in reverse to find the most recently active step.
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const name = step?.name ?? '';
    if (VIRTUAL_PHASES.has(name)) continue;
    const status = step?.status ?? '';

    // FR-6: only block when the phase is actively being worked on (IN_PROGRESS).
    if (status === 'IN_PROGRESS') {
      // TASK-phase steps store the per-task id in `taskId` (e.g. "TASK_01")
      // while `name` is always the literal "TASK". Return taskId so that the
      // staging artifact check resolves to staging/TASK_01.json, not the
      // non-existent staging/TASK.json.
      if (name === 'TASK') {
        if (typeof step?.taskId === 'string' && step.taskId.trim().length > 0) {
          return step.taskId;
        }
        return null; // silent exit — 'TASK' alone is not a valid artifact name
      }
      return name;
    }

    // Dispatch-failure recovery (FR-6 extension): a PENDING step that is the
    // immediate next-up after a COMPLETED predecessor indicates the dispatch
    // agent started but never transitioned the step to IN_PROGRESS. Surface
    // it so the agent knows to re-dispatch rather than silently stop.
    if (status === 'PENDING') {
      // Find the predecessor: walk backward past virtual phases.
      let prevStatus = null;
      for (let j = i - 1; j >= 0; j--) {
        const prev = steps[j];
        if (VIRTUAL_PHASES.has(prev?.name ?? '')) continue;
        prevStatus = prev?.status ?? '';
        break;
      }
      if (prevStatus === 'COMPLETED') {
        if (name === 'TASK') {
          if (
            typeof step?.taskId === 'string' &&
            step.taskId.trim().length > 0
          ) {
            return step.taskId;
          }
          return null;
        }
        return name;
      }
      // Predecessor not COMPLETED — step hasn't been reached yet, skip silently.
      return null;
    }
  }
  return null;
}

/**
 * Compute expected staging artifact path for a given phase + feat + workspaceRoot.
 * TASK_NN maps to TASK_NN.json; PRD maps to PRD.md; all others to <PHASE>.json.
 */
function stagingArtifactPath(workspaceRoot, feat, phase) {
  const ext = MD_PHASES.has(phase) ? '.md' : '.json';
  return path.join(
    workspaceRoot,
    'docs',
    'browzer',
    feat,
    'staging',
    `${phase}${ext}`,
  );
}

// ---------------------------------------------------------------------------
// Main (synchronous fast-path)
// ---------------------------------------------------------------------------

if (process.env.BROWZER_AUTOSAVE === '0') process.exit(0);

const input = readHookInput();
const cwd =
  typeof input?.cwd === 'string' && input.cwd.length > 0
    ? input.cwd
    : process.cwd();

// Locate workflow.json — prefer env hint for speed.
//
// FR-9 (R-24): when BROWZER_WORKFLOW_ID is set, scope discovery strictly to
// that feature id. If the corresponding workflow.json cannot be found after
// walking 20 ancestor hops, exit 0 silently — do NOT fall through to the
// mtime-based findLatestWorkflowJson discovery. Falling through would load
// a stale workflow from a different feature and emit false-positive nudges.
let workflowPath = null;
if (process.env.BROWZER_WORKFLOW_ID) {
  // Walk upward to find docs/browzer/<id>/workflow.json directly.
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(
      dir,
      'docs',
      'browzer',
      process.env.BROWZER_WORKFLOW_ID,
      'workflow.json',
    );
    if (fs.existsSync(candidate)) {
      workflowPath = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // FR-9: BROWZER_WORKFLOW_ID was set but no matching workflow.json found.
  // Exit silently — do NOT fall through to mtime-based discovery.
  if (!workflowPath) {
    if (process.env.BROWZER_HOOK_DEBUG) {
      process.stderr.write(
        `[_stop-staging-nudge] FR-9: BROWZER_WORKFLOW_ID="${process.env.BROWZER_WORKFLOW_ID}" set but no matching workflow.json found after 20-hop walk — exiting silently.\n`,
      );
    }
    process.exit(0);
  }
} else {
  workflowPath = findLatestWorkflowJson(cwd);
}

if (!workflowPath) process.exit(0);

const feat = featFromPath(workflowPath);
if (!feat) process.exit(0);

let workflowRaw;
try {
  workflowRaw = fs.readFileSync(workflowPath, 'utf8');
} catch {
  process.exit(0);
}

const phase = findInProgressPhase(workflowRaw);
if (!phase) process.exit(0);

// Workspace root = the ancestor that contains docs/browzer/<feat>/workflow.json
const workspaceRoot = path.resolve(workflowPath, '..', '..', '..', '..');

const artifactPath = stagingArtifactPath(workspaceRoot, feat, phase);

if (fs.existsSync(artifactPath)) process.exit(0);

// Artifact is missing — block Stop so the agent continues and writes it.
// Stop hooks do NOT accept `hookSpecificOutput.additionalContext` (that field
// is only valid for UserPromptSubmit / PostToolUse / PostToolBatch). The
// correct channel to surface a message back into the model from a Stop hook
// is `decision: "block"` + `reason`, which both prevents the turn from ending
// and feeds the reason into the next model step.
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `Your staging artifact at \`${artifactPath}\` was not found. ` +
      'Write it now — your turn is not complete until this file exists.',
  }),
);
process.exit(0);
