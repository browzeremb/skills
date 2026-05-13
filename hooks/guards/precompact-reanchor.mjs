#!/usr/bin/env node
// PreCompact: inject a tight summary of in-flight workflow state + last gate
// receipt as additionalContext so the post-compaction agent re-anchors
// without losing track of the current step. Best-effort, never blocks.
//
// WHY this hook combines workflow-state AND gate-receipt re-anchoring:
// Claude Code allows exactly one hook handler per event matcher. Splitting
// these two concerns into separate hooks would require a second PreCompact
// matcher entry, which the schema does not support. Combining them here
// saves a hook invocation on every compaction event — both sources of
// context land in a single additionalContext write, with zero extra I/O.
// The gate-receipt portion (_gate-receipts / _gate-resolve) is load-bearing
// for the quality-gate surfacing pipeline; do NOT split this file.
import fs from 'node:fs';
import path from 'node:path';
import { listValidReceipts } from '../_gate-receipts.mjs';
import { getEffectiveConfig } from '../_gate-resolve.mjs';
import { isHookEnabled, workspaceRootFor } from './_util.mjs';

if (!isHookEnabled('precompact-reanchor')) process.exit(0);

const cwd = process.cwd();
const wsRoot = workspaceRootFor(cwd) ?? cwd;

// Process-lifetime cache for the docs/browzer readdir result, keyed on the
// mtimeMs of the feat-root directory. When the directory mtime is unchanged
// since the last PreCompact firing (common in long sessions with no active
// task edits), we skip the O(N) stat loop entirely and reuse the prior
// winner — drops ~51 syscalls to ~2 on cache-hit paths.
const _readdirCache = new Map(); // rootPath → { rootMtimeMs, result }

function readWorkflowSummary() {
  // Markdown-chains era: derive context from the feat directory instead of
  // the legacy state file. Finds the most recently modified feat directory
  // and counts completed/total task files.
  const cfgPath = path.join(wsRoot, '.browzer', 'config.json');
  let featRoot = 'docs/browzer';
  let featPrefix = 'feat-';
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    featRoot = cfg?.workflow?.featRoot ?? featRoot;
    featPrefix = cfg?.workflow?.featPrefix ?? featPrefix;
  } catch {
    /* defaults are fine */
  }
  const root = path.join(wsRoot, featRoot);
  if (!fs.existsSync(root)) return null;

  // Check whether the feat-root dir mtime changed since the last call. If
  // not, serve the cached result immediately (zero readdir/stat calls).
  let rootMtimeMs = 0;
  try {
    rootMtimeMs = fs.statSync(root).mtimeMs;
  } catch {
    return null;
  }
  const cached = _readdirCache.get(root);
  if (cached && cached.rootMtimeMs === rootMtimeMs) {
    return cached.result;
  }

  let latest = null;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(featPrefix)) continue;
      const featDir = path.join(root, e.name);
      try {
        const stat = fs.statSync(featDir);
        if (!latest || stat.mtimeMs > latest.mtimeMs) {
          latest = { featDir, name: e.name, mtimeMs: stat.mtimeMs };
        }
      } catch {}
    }
  } catch {
    return null;
  }

  let result = null;
  if (latest) {
    try {
      const entries = fs.readdirSync(latest.featDir);
      const taskRe = /^TASK_\d+\.md$/;
      const completedRe = /^TASK_\d+\.completed\.md$/;
      const failedRe = /^TASK_\d+\.failed\.md$/;
      const total = entries.filter(
        (f) => taskRe.test(f) || completedRe.test(f) || failedRe.test(f),
      ).length;
      const done = entries.filter((f) => completedRe.test(f)).length;
      const inFlight = entries.filter((f) => taskRe.test(f)).length;

      // Suppress emission when all tasks are done AND the feat dir hasn't
      // been touched in 24 hours — a finished feature from a prior session
      // should not stamp its context onto unrelated new sessions.
      if (inFlight === 0 && latest.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) {
        _readdirCache.set(root, { rootMtimeMs, result: null });
        return null;
      }

      // Pick the SMALLEST TASK_NN that lacks a .completed/.failed sibling —
      // using array length is unsafe for non-contiguous task IDs.
      let lastStep;
      if (inFlight > 0) {
        const inFlightIds = entries
          .filter((f) => taskRe.test(f))
          .map((f) =>
            Number.parseInt(f.replace(/^TASK_/, '').replace(/\.md$/, ''), 10),
          )
          .sort((a, b) => a - b);
        lastStep = `TASK_${String(inFlightIds[0]).padStart(2, '0')} IN_PROGRESS`;
      } else if (done > 0) {
        lastStep = 'all tasks done';
      } else {
        lastStep = '(none)';
      }

      result = {
        feat: latest.name,
        stepId: lastStep,
        status:
          inFlight > 0 ? 'IN_PROGRESS' : done > 0 ? 'COMPLETED' : 'PENDING',
        progress: `${done}/${total}`,
      };
    } catch {
      result = null;
    }
  }

  // Store in process-lifetime cache keyed on root mtime.
  _readdirCache.set(root, { rootMtimeMs, result });
  return result;
}

function readGateReceiptSummary() {
  try {
    const cfg = getEffectiveConfig(wsRoot);
    const dirRel =
      cfg?.hooks?.qualityGate?.receipt?.directory ?? '.browzer/.gate-receipts';
    const receipts = listValidReceipts({ cwd: wsRoot, dirRel });
    if (receipts.length === 0) return null;
    const r = receipts[0];
    return `gate=${r.status}${r.command ? ` (${r.command})` : ''}`;
  } catch {
    return null;
  }
}

const wf = readWorkflowSummary();
const gate = readGateReceiptSummary();
if (!wf && !gate) process.exit(0);

const parts = [];
if (wf)
  parts.push(
    `Active workflow: ${wf.feat} | step ${wf.stepId} (${wf.status}) | progress ${wf.progress}`,
  );
if (gate) parts.push(gate);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: `[browzer re-anchor] ${parts.join(' — ')}`,
    },
  }),
);
process.exit(0);
