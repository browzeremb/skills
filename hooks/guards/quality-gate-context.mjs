// UserPromptSubmit context injector: surfaces the most recent gate receipt as
// `additionalContext` on the next agent turn so the model sees pass/fail
// signal before deciding what to do.
//
// Always exits 0. Emits at most ~400 chars of context. No JSON output when
// no fresh receipt exists — silent no-op.

import { listValidReceipts } from '../_gate-receipts.mjs';
import { getEffectiveConfig } from '../_gate-resolve.mjs';
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  workspaceRootFor,
} from './_util.mjs';

const MAX_CONTEXT_CHARS = 400;
const MAX_TAIL_CHARS = 200;

function exit0() {
  process.exit(0);
}

function clip(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s ?? '';
  return s.slice(0, n - 1) + '…';
}

function emit(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    })}\n`,
  );
}

if (!isHookEnabled()) exit0();

const cwd = process.cwd();
if (!isInBrowzerWorkspace(cwd)) exit0();

const wsRoot = workspaceRootFor(cwd) ?? cwd;
const cfg = getEffectiveConfig(wsRoot);
const dirRel =
  cfg?.hooks?.qualityGate?.receipt?.directory ?? '.browzer/.gate-receipts';

const receipts = listValidReceipts({ cwd: wsRoot, dirRel });
if (receipts.length === 0) exit0();

const r = receipts[0];

const headerParts = [`[browzer] quality gate ${r.status}`];
if (r.command) headerParts.push(`(cmd: ${r.command})`);
if (typeof r.durationMs === 'number') {
  headerParts.push(`took ${(r.durationMs / 1000).toFixed(1)}s`);
}
if (r.status !== 'passed' && typeof r.exitCode === 'number') {
  headerParts.push(`exit=${r.exitCode}`);
}
const header = headerParts.join(' ');

let body = '';
if (r.status === 'failed') {
  // Bias toward stderr tail since failures usually surface there; fall back
  // to stdout if stderr is empty.
  const tail = (r.stderrTail && r.stderrTail.trim()) || r.stdoutTail || '';
  if (tail) body = `\n${clip(tail, MAX_TAIL_CHARS)}`;
} else if (r.status === 'pending') {
  body = ' (running in background — wait or proceed)';
}

const out = clip(`${header}${body}`, MAX_CONTEXT_CHARS);
emit(out);

exit0();
