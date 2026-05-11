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
 * Find the latest non-COMPLETED, non-virtual step that is either IN_PROGRESS
 * or PENDING. Returns the step name string, or null.
 */
function findActivePhase(workflowJson) {
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
    const name = step?.name ?? step?.id ?? '';
    if (VIRTUAL_PHASES.has(name)) continue;
    const status = step?.status ?? '';
    if (status === 'IN_PROGRESS' || status === 'PENDING') {
      return name;
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
}

if (!workflowPath) {
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

const phase = findActivePhase(workflowRaw);
if (!phase) process.exit(0);

// Workspace root = the ancestor that contains docs/browzer/<feat>/workflow.json
const workspaceRoot = path.resolve(workflowPath, '..', '..', '..', '..');

const artifactPath = stagingArtifactPath(workspaceRoot, feat, phase);

if (fs.existsSync(artifactPath)) process.exit(0);

// Artifact is missing — emit a non-blocking nudge.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext:
        `Your staging artifact at \`${artifactPath}\` was not found. ` +
        'Write it now — your turn is not complete until this file exists.',
    },
  }),
);
process.exit(0);
