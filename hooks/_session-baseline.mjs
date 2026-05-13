// Session-scoped baseline helpers for the quality-gate hooks.
//
// On the first gate run of each session, the set of already-failing tests
// is captured and persisted here. Subsequent runs treat those tests as
// pre-existing so the model only sees regressions introduced in the
// current session.
//
// Extracted as a peer module so both quality-gate-stop.mjs and
// quality-gate-context.mjs can import freely without going through the
// _isMain guard that prevented process.exit() from firing on import.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Single source of truth for the baseline directory name.
const BASELINE_DIR = '.browzer-gate';

/**
 * Returns the path for the session baseline file.
 * Keyed by sessionId so two concurrent sessions never collide.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function baselinePathFor(sessionId) {
  return path.join(os.tmpdir(), BASELINE_DIR, `${sessionId}-baseline.json`);
}

/**
 * Returns true iff a baseline already exists for this session (i.e. we have
 * already captured failures on the first gate run of the session).
 *
 * @param {string|null|undefined} sessionId
 * @returns {boolean}
 */
export function hasSessionBaseline(sessionId) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(baselinePathFor(sessionId));
  } catch {
    return false;
  }
}

/**
 * Reads and parses the baseline for a session. Returns an array of failing
 * test names (strings), or [] when missing/corrupt.
 *
 * @param {string|null|undefined} sessionId
 * @returns {string[]}
 */
export function readSessionBaseline(sessionId) {
  if (!sessionId) return [];
  try {
    const raw = fs.readFileSync(baselinePathFor(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.failures) ? parsed.failures : [];
  } catch {
    return [];
  }
}

/**
 * Atomically writes the session baseline. Uses tmp-rename to prevent torn
 * reads under concurrent Stop hook invocations.
 *
 * @param {string} sessionId
 * @param {string[]} failures - array of failing test names captured at gate run time
 */
export function writeSessionBaseline(sessionId, failures) {
  if (!sessionId) return;
  const baseDir = path.join(os.tmpdir(), BASELINE_DIR);
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch {
    // Best-effort; if mkdirSync fails the subsequent write will surface it.
  }
  const finalPath = baselinePathFor(sessionId);
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(baseDir, '.tmp-bl-'));
  } catch {
    // Non-fatal — baseline is advisory only; never block the gate.
    return;
  }
  const tmpFile = path.join(tmpDir, 'baseline.json');
  try {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ sessionId, capturedAt: Date.now(), failures }, null, 2),
      'utf8',
    );
    fs.renameSync(tmpFile, finalPath);
  } catch {
    // Best-effort.
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // tmp dir may already be gone.
    }
  }
}
