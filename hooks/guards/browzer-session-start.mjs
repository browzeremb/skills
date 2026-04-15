#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readHookInput, daemonCall, isHookEnabled, resolveBrowzerBinary } from './_util.mjs';

if (!isHookEnabled()) process.exit(0);

const input = readHookInput();
const sessionId = input?.session_id;
const transcriptPath = input?.transcript_path;
if (!sessionId || !transcriptPath) process.exit(0);

// Ensure the daemon is up BEFORE SessionRegister. Every subsequent
// hook (rewrite-read, rewrite-bash, block-glob, suggest-grep) assumes
// a reachable socket; spawning here once per Claude Code session
// amortizes the cold-start cost.
//
// Strategy:
//   1. Probe the socket with Health. Fast path on a warm daemon.
//   2. On failure, spawn `browzer daemon start --background` and poll
//      the socket for up to 1.5s (default short-circuit so hook doesn't
//      block the agent's first turn longer than that).
//   3. Fall through to SessionRegister regardless — the other guards
//      tolerate a cold daemon (exit 0 passthrough).
try {
  await daemonCall('Health', {}, { timeoutMs: 500 });
} catch {
  // Daemon not up — try to spawn it using the resolved absolute binary
  // path to prevent PATH hijack (typosquat in node_modules/.bin or CWD).
  try {
    const browzerBin = resolveBrowzerBinary();
    if (!browzerBin) {
      // Binary not found or path is not absolute — skip spawn entirely.
      // Downstream guards degrade gracefully when the socket is absent.
      process.exit(0);
    }
    const child = spawn(browzerBin, ['daemon', 'start', '--background'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {}
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      await daemonCall('Health', {}, { timeoutMs: 200 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

try {
  await daemonCall('SessionRegister', { sessionId, transcriptPath });
} catch {
  // Daemon may still be cold after the spawn window; not fatal —
  // Read/Bash guards will retry session lookup on demand.
}
process.exit(0);
