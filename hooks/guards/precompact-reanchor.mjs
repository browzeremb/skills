#!/usr/bin/env node
// PreCompact: inject a tight summary of in-flight workflow state + last gate
// receipt as additionalContext so the post-compaction agent re-anchors
// without losing track of the current step. Best-effort, never blocks.
import fs from 'node:fs';
import path from 'node:path';
import { listValidReceipts } from '../_gate-receipts.mjs';
import { getEffectiveConfig } from '../_gate-resolve.mjs';
import { isHookEnabled, workspaceRootFor } from './_util.mjs';

if (!isHookEnabled('precompact-reanchor')) process.exit(0);

const cwd = process.cwd();
const wsRoot = workspaceRootFor(cwd) ?? cwd;

function readWorkflowSummary() {
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
  let latest = null;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(featPrefix)) continue;
      const wf = path.join(root, e.name, 'workflow.json');
      try {
        const stat = fs.statSync(wf);
        if (!latest || stat.mtimeMs > latest.mtimeMs) {
          latest = { wf, name: e.name, mtimeMs: stat.mtimeMs };
        }
      } catch {}
    }
  } catch {
    return null;
  }
  if (!latest) return null;
  try {
    const data = JSON.parse(fs.readFileSync(latest.wf, 'utf8'));
    const stepId = String(data?.currentStepId ?? '').trim();
    const steps = Array.isArray(data?.steps) ? data.steps : [];
    const step = steps.find((s) => s?.stepId === stepId);
    const status = step?.status ?? '?';
    const total = steps.length;
    const done = steps.filter((s) =>
      ['COMPLETED', 'SKIPPED'].includes(String(s?.status ?? '')),
    ).length;
    return {
      feat: latest.name,
      stepId: stepId || '(none)',
      status,
      progress: `${done}/${total}`,
    };
  } catch {
    return null;
  }
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
