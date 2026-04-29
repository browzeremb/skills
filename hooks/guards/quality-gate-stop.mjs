// Stop-event guard: spawns the resolved quality-gate command in background
// after the model finishes a turn naturally. Writes a 'pending' receipt
// synchronously, then a detached child rewrites it with passed|failed once
// the gate exits. The hook itself returns within ~50ms.
//
// Boundary contract:
//   - Never blocks the agent (exit 0 fast on every code path).
//   - Never re-triggers itself (input.stop_hook_active).
//   - Skips on non-Browzer repos, BROWZER_HOOK=off, missing gate command,
//     fresh receipt for current fingerprint, or qualityGate.enabled=false.
//   - BROWZER_GATE_DRY_RUN=1 short-circuits the spawn for tests.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeFingerprint,
  pruneOldReceipts,
  readFreshReceipt,
  receiptDirFor,
  writeReceipt,
} from '../_gate-receipts.mjs';
import { getEffectiveConfig, resolveGateCommand } from '../_gate-resolve.mjs';
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  workspaceRootFor,
} from './_util.mjs';

function exit0() {
  process.exit(0);
}

if (!isHookEnabled()) exit0();

const input = readHookInput();
if (input && input.stop_hook_active === true) exit0();

const cwd = process.cwd();
if (!isInBrowzerWorkspace(cwd)) exit0();

// Anchor everything to the workspace root so the receipt directory is
// stable regardless of which subdirectory the model invoked Stop from.
const wsRoot = workspaceRootFor(cwd) ?? cwd;

const cfg = getEffectiveConfig(wsRoot);
const qg = cfg?.hooks?.qualityGate ?? {};
if (qg.enabled === false) exit0();

const resolved = resolveGateCommand({ cwd: wsRoot });
if (!resolved) {
  // resolveGateCommand already emitted a one-shot stderr advisory.
  exit0();
}

const fingerprint = computeFingerprint({ cwd: wsRoot });
if (!fingerprint) {
  // Not a git repo → can't fingerprint, can't dedup. Treat as transient and
  // skip the gate to stay non-disruptive in non-git scratch repos.
  exit0();
}

const receiptDirRel = qg?.receipt?.directory ?? '.browzer/.gate-receipts';
const ttlSec = typeof qg?.receipt?.ttl === 'number' ? qg.receipt.ttl : 300;
const timeoutSec = typeof qg.timeout === 'number' ? qg.timeout : 120;

pruneOldReceipts({ cwd: wsRoot, dirRel: receiptDirRel });

const fresh = readFreshReceipt({
  cwd: wsRoot,
  fingerprint,
  dirRel: receiptDirRel,
});
if (fresh) {
  // Already passed/failed/pending for this exact tree state → nothing to do.
  exit0();
}

const startedAt = Date.now();
writeReceipt({
  cwd: wsRoot,
  fingerprint,
  dirRel: receiptDirRel,
  receipt: {
    status: 'pending',
    command: resolved.command,
    source: resolved.source,
    mode: resolved.mode,
    startedAt,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    stdoutTail: '',
    stderrTail: '',
    pid: null,
    ttlSec,
  },
});

if (process.env.BROWZER_GATE_DRY_RUN === '1') {
  // Tests opt out of the actual spawn — receipt left as 'pending'.
  exit0();
}

// Open a log fd that the kernel keeps open for the detached child after this
// process exits. Both stdout + stderr stream there for post-mortem.
const receiptDir = receiptDirFor(wsRoot, receiptDirRel);
try {
  fs.mkdirSync(receiptDir, { recursive: true });
} catch {
  // Best effort.
}
const logFile = path.join(receiptDir, `${fingerprint.slice(0, 12)}.log`);
let logFd;
try {
  logFd = fs.openSync(logFile, 'a');
} catch {
  // Without a log fd we still prefer to run the gate; fall back to ignore.
  logFd = 'ignore';
}

const wrapperSrc = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeReceipt } from ${JSON.stringify(
  fileURLToPath(new URL('../_gate-receipts.mjs', import.meta.url)),
)};

const wsRoot = process.env.BROWZER_GATE_WSROOT;
const fingerprint = process.env.BROWZER_GATE_FINGERPRINT;
const command = process.env.BROWZER_GATE_COMMAND;
const source = process.env.BROWZER_GATE_SOURCE;
const mode = process.env.BROWZER_GATE_MODE;
const dirRel = process.env.BROWZER_GATE_DIR;
const ttlSec = Number(process.env.BROWZER_GATE_TTL || 300);
const timeoutSec = Number(process.env.BROWZER_GATE_TIMEOUT || 120);
const startedAt = Number(process.env.BROWZER_GATE_STARTED_AT || Date.now());

const TAIL_LINES = 32;
function tailOf(buf) {
  if (!buf) return '';
  const s = buf.toString('utf8');
  const lines = s.split(/\\r?\\n/);
  return lines.slice(-TAIL_LINES).join('\\n').slice(-4000);
}

const child = spawn(command, {
  cwd: wsRoot,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

const stdoutChunks = [];
const stderrChunks = [];
child.stdout.on('data', (c) => stdoutChunks.push(c));
child.stderr.on('data', (c) => stderrChunks.push(c));

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
}, timeoutSec * 1000);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const completedAt = Date.now();
  const exitCode = typeof code === 'number' ? code : (signal ? 128 : 1);
  const status = (exitCode === 0 && !timedOut) ? 'passed' : 'failed';
  const stdoutTail = tailOf(Buffer.concat(stdoutChunks));
  const stderrTail = tailOf(Buffer.concat(stderrChunks));
  try {
    writeReceipt({
      cwd: wsRoot,
      fingerprint,
      dirRel: dirRel,
      receipt: {
        status,
        command,
        source,
        mode,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        exitCode,
        stdoutTail,
        stderrTail: timedOut ? '[timed out]\\n' + stderrTail : stderrTail,
        pid: process.pid,
        ttlSec,
      },
    });
  } catch (e) {
    process.stderr.write('[browzer-gate] receipt write failed: ' + (e?.message ?? e) + '\\n');
  }
});

child.on('error', (e) => {
  clearTimeout(timer);
  const completedAt = Date.now();
  try {
    writeReceipt({
      cwd: wsRoot,
      fingerprint,
      dirRel: dirRel,
      receipt: {
        status: 'failed',
        command,
        source,
        mode,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        exitCode: -1,
        stdoutTail: '',
        stderrTail: 'spawn error: ' + (e?.message ?? String(e)),
        pid: process.pid,
        ttlSec,
      },
    });
  } catch {}
});
`;

const child = spawn(
  process.execPath,
  ['--input-type=module', '-e', wrapperSrc],
  {
    cwd: wsRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      BROWZER_GATE_WSROOT: wsRoot,
      BROWZER_GATE_FINGERPRINT: fingerprint,
      BROWZER_GATE_COMMAND: resolved.command,
      BROWZER_GATE_SOURCE: resolved.source,
      BROWZER_GATE_MODE: resolved.mode,
      BROWZER_GATE_DIR: receiptDirRel,
      BROWZER_GATE_TTL: String(ttlSec),
      BROWZER_GATE_TIMEOUT: String(timeoutSec),
      BROWZER_GATE_STARTED_AT: String(startedAt),
    },
  },
);
child.unref();

// We can close our reference to the log fd — the child inherited it.
if (typeof logFd === 'number') {
  try {
    fs.closeSync(logFd);
  } catch {
    // Already closed by the child handoff.
  }
}

exit0();
