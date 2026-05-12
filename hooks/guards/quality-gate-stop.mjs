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
//
// FR-2 — Session baseline:
//   On the first gate run of each session, capture the set of failing tests
//   as a baseline and persist to $TMPDIR/.browzer-gate/<sessionId>-baseline.json.
//   Subsequent runs in the same session treat those tests as pre-existing;
//   quality-gate-context.mjs filters them from the failure surface.

import { spawn } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  computeFingerprint,
  pruneOldReceipts,
  readFreshReceipt,
  receiptDirFor,
  writeReceipt,
} from '../_gate-receipts.mjs';
import { getEffectiveConfig, resolveGateCommand } from '../_gate-resolve.mjs';
import {
  baselinePathFor,
  hasSessionBaseline,
  readSessionBaseline,
  writeSessionBaseline,
} from '../_session-baseline.mjs';
import { isHookEnabled, readHookInput, workspaceRootFor } from './_util.mjs';

// Re-export helpers so existing importers (tests, quality-gate-context.mjs)
// that import from this module continue to work without changes.
export {
  baselinePathFor,
  hasSessionBaseline,
  readSessionBaseline,
  writeSessionBaseline,
};

// ---------------------------------------------------------------------------
// _isMain guard (F-10): resolve symlinks in argv[1] before comparing so a
// symlinked entry-point still detects correctly. Handle undefined argv[1]
// (e.g. when running under --input-type=module -e <src>).
// ---------------------------------------------------------------------------
const _isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const thisHref = new URL(import.meta.url).href;
    const argv1Href = pathToFileURL(realpathSync(process.argv[1])).href;
    return thisHref === argv1Href;
  } catch {
    // Fallback: treat as main to preserve original direct-exec behaviour.
    return true;
  }
})();

function exit0() {
  process.exit(0);
}

if (!_isMain) {
  // Imported as a module — only the re-exported helper functions are needed.
  // No hook execution; no process.exit().
} else {
  if (!isHookEnabled('quality-gate-stop')) exit0();

  const input = readHookInput();
  if (input && input.stop_hook_active === true) exit0();

  // FR-2: extract session_id for baseline tracking (NFR-2: keyed by session).
  const sessionId = input?.session_id ?? input?.sessionId ?? null;

  const cwd = process.cwd();
  // Anchor to the .browzer workspace root if present; otherwise use the cwd
  // itself. The quality gate runs in any repo where a gate command resolves —
  // not gated by browzer workspace presence.
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

  // F-4: stake the slot SYNCHRONOUSLY before spawning the detached child so a
  // second concurrent Stop hook sees hasSessionBaseline() === true and skips
  // the capture. The child overwrites this placeholder with the real baseline.
  const isFirstSessionRun = sessionId ? !hasSessionBaseline(sessionId) : false;
  if (isFirstSessionRun && sessionId) {
    // Write a lightweight pending placeholder into the baseline slot.
    // writeSessionBaseline is atomic (tmp-rename), so the second hook can
    // reliably detect the slot as taken via hasSessionBaseline().
    writeSessionBaseline(sessionId, []);
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

  // F-14: accept conventional truthy spellings (1, true, yes) case-insensitively.
  if (/^(1|true|yes)$/i.test(process.env.BROWZER_GATE_DRY_RUN ?? '')) {
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

  // FR-2: the detached wrapper needs the baseline helper path and session info.
  const baselineHelperPath = fileURLToPath(
    new URL('../_session-baseline.mjs', import.meta.url),
  );

  const wrapperSrc = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeReceipt } from ${JSON.stringify(
    fileURLToPath(new URL('../_gate-receipts.mjs', import.meta.url)),
  )};
import { writeSessionBaseline } from ${JSON.stringify(baselineHelperPath)};

const wsRoot = process.env.BROWZER_GATE_WSROOT;
const fingerprint = process.env.BROWZER_GATE_FINGERPRINT;
const command = process.env.BROWZER_GATE_COMMAND;
const source = process.env.BROWZER_GATE_SOURCE;
const mode = process.env.BROWZER_GATE_MODE;
const dirRel = process.env.BROWZER_GATE_DIR;
const ttlSec = Number(process.env.BROWZER_GATE_TTL || 300);
const timeoutSec = Number(process.env.BROWZER_GATE_TIMEOUT || 120);
const startedAt = Number(process.env.BROWZER_GATE_STARTED_AT || Date.now());
const gateSessionId = process.env.BROWZER_GATE_SESSION_ID || '';
const captureBaseline = process.env.BROWZER_GATE_CAPTURE_BASELINE === '1';

const TAIL_LINES = 32;
function tailOf(buf) {
  if (!buf) return '';
  const s = buf.toString('utf8');
  const lines = s.split(/\\r?\\n/);
  return lines.slice(-TAIL_LINES).join('\\n').slice(-4000);
}

// FR-2: extract failing test names from combined output using common patterns:
//   TAP:    "not ok N - <name>"
//   Jest:   "● <name>"
//   Vitest: "FAIL <path> > <name>"
//   node:test: "✗ <name>" or "not ok"
//   Go test: "--- FAIL: <name>"
//   Generic: lines containing "FAIL" or "FAILED" followed by a test name
function extractFailingTests(combined) {
  const failures = new Set();
  for (const line of combined.split(/\\r?\\n/)) {
    // TAP: not ok N - test name
    let m = line.match(/^not ok \\d+ - (.+)$/);
    if (m) { failures.add(m[1].trim()); continue; }
    // Jest bullet: "● Suite > test name"
    m = line.match(/^\\s*● (.+)$/);
    if (m) { failures.add(m[1].trim()); continue; }
    // Go test: "--- FAIL: TestName"
    m = line.match(/^--- FAIL: (\\S+)/);
    if (m) { failures.add(m[1].trim()); continue; }
    // node:test: "✗ test name" or "✗ test name (Nms)"
    m = line.match(/^\\s*✗ (.+?)(?:\\s+\\(\\d+ms\\))?$/);
    if (m) { failures.add(m[1].trim()); continue; }
    // Vitest FAIL line: "FAIL path/to/file.test.ts > test name"
    m = line.match(/^\\s*FAIL .+ > (.+)$/);
    if (m) { failures.add(m[1].trim()); continue; }
  }
  return [...failures];
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

  // FR-2: on the first gate run of a session, persist failing tests as baseline.
  // This is async-safe: writeSessionBaseline uses atomic tmp-rename.
  if (captureBaseline && gateSessionId && status === 'failed') {
    try {
      const combined = Buffer.concat(stdoutChunks).toString('utf8') +
        '\\n' + Buffer.concat(stderrChunks).toString('utf8');
      const failures = extractFailingTests(combined);
      writeSessionBaseline(gateSessionId, failures);
    } catch {
      // Baseline capture is advisory — never block receipt write.
    }
  } else if (captureBaseline && gateSessionId && status === 'passed') {
    // Gate passed on first run → baseline is empty (no pre-existing failures).
    try { writeSessionBaseline(gateSessionId, []); } catch {}
  }

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
        // FR-2: session baseline capture
        BROWZER_GATE_SESSION_ID: sessionId ?? '',
        // F-4: the slot is already staked; child still captures real failures.
        BROWZER_GATE_CAPTURE_BASELINE: isFirstSessionRun ? '1' : '0',
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
} // end _isMain else block
