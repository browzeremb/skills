// Atomic gate-receipt I/O + working-tree fingerprinting.
//
// Receipt lifecycle:
//   pending → passed | failed
//
// Receipt path: .browzer/.gate-receipts/<fingerprint-12char-prefix>.json
//   Same fingerprint = same receipt slot (deduplicated by tree state).
//
// Receipt schema (version-stamped for forward compat):
//   {
//     version: 1,
//     fingerprint: <full sha256 hex>,
//     status: 'pending' | 'passed' | 'failed',
//     command: <string>,
//     source: <string>,         // resolveGateCommand source tag
//     mode: <string>,           // 'affected' | 'full'
//     startedAt: <ms epoch>,
//     completedAt: <ms epoch | null>,
//     durationMs: <number | null>,
//     exitCode: <number | null>,
//     stdoutTail: <string>,
//     stderrTail: <string>,
//     pid: <number | null>,
//     ttlSec: <number>,         // freshness window for surfacing
//   }
//
// Atomicity: writeReceipt uses fs.mkdtempSync neighbor + fs.renameSync, so
// readers never see a half-written file. Concurrent writers race but neither
// produces a torn file.
//
// Two TTLs:
//   - Freshness TTL (default 300s): how long a receipt counts as "current"
//     for the freshness check (skip-spawn / surface-context decisions).
//   - Disk TTL (24h): floor for prune. Older files unlinked on every read
//     so the directory stays bounded (~20 files in steady state).

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DISK_TTL_MS = 24 * 60 * 60 * 1000;
const RECEIPT_VERSION = 1;

function receiptDir(cwd, dirRel = '.browzer/.gate-receipts') {
  return path.resolve(cwd, dirRel);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // EEXIST raced; ignore. Other errors surface on the subsequent write.
  }
}

/**
 * sha256 fingerprint of the working tree. Captures only files git considers
 * modified or untracked (`-m -o --exclude-standard`), keyed by path + mtimeMs
 * + size — same approach Turbo/Nx use, sufficient for "did anything edit
 * since the last gate run?". Returns null when CWD is not a git repo or git
 * is unavailable; callers MUST treat null as "always re-run".
 */
export function computeFingerprint({ cwd } = {}) {
  if (!cwd) cwd = process.cwd();
  let listing;
  try {
    listing = execSync('git ls-files -m -o --exclude-standard -z', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const paths = listing
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
    // Exclude the receipt directory itself — it's a control-plane artifact
    // describing the tree, so including it would create an infinite loop:
    // every receipt write would shift the fingerprint, generating a new slot.
    .filter((p) => !p.startsWith('.browzer/.gate-receipts/'));

  // Sort for determinism — git ls-files order is stable but we want belts AND
  // suspenders given fingerprints gate the freshness path.
  paths.sort();

  const hash = crypto.createHash('sha256');
  for (const rel of paths) {
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = fs.statSync(path.join(cwd, rel));
      mtimeMs = Math.floor(st.mtimeMs);
      size = st.size;
    } catch {
      // File listed by git but absent now (rapid delete). Hash the path with
      // sentinel values so the fingerprint still changes.
      mtimeMs = -1;
      size = -1;
    }
    hash.update(`${rel}\0${mtimeMs}\0${size}\n`);
  }
  // Also fold in HEAD ref so the fingerprint shifts after a checkout/rebase
  // even when the working tree is clean.
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    hash.update(`HEAD\0${head}\n`);
  } catch {
    // Detached or empty repo — keep the working-tree-only fingerprint.
  }
  return hash.digest('hex');
}

function fingerprintToFile(dir, fingerprint) {
  return path.join(dir, `${fingerprint.slice(0, 12)}.json`);
}

/** Reads the receipt for a given fingerprint, or null if missing/corrupt. */
export function readReceipt({ cwd, fingerprint, dirRel } = {}) {
  if (!cwd) cwd = process.cwd();
  if (!fingerprint) return null;
  const dir = receiptDir(cwd, dirRel);
  const file = fingerprintToFile(dir, fingerprint);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === RECEIPT_VERSION) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically writes a receipt. Caller passes a partial; missing fields are
 * defaulted. Existing receipt (if any) is overwritten — race-safe via
 * mkdtemp neighbor + renameSync.
 */
export function writeReceipt({ cwd, fingerprint, receipt, dirRel } = {}) {
  if (!cwd) cwd = process.cwd();
  if (!fingerprint) throw new Error('writeReceipt: fingerprint required');
  const dir = receiptDir(cwd, dirRel);
  ensureDir(dir);
  const finalPath = fingerprintToFile(dir, fingerprint);

  const merged = {
    version: RECEIPT_VERSION,
    fingerprint,
    status: 'pending',
    command: '',
    source: '',
    mode: '',
    startedAt: Date.now(),
    completedAt: null,
    durationMs: null,
    exitCode: null,
    stdoutTail: '',
    stderrTail: '',
    pid: null,
    ttlSec: 300,
    ...(receipt || {}),
    version: RECEIPT_VERSION,
    fingerprint,
  };

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(dir, '.tmp-'));
  } catch {
    // Receipt directory missing or non-writable — last-chance retry after
    // ensureDir already ran. Bubble the error up so callers can log.
    ensureDir(dir);
    tmpDir = fs.mkdtempSync(path.join(dir, '.tmp-'));
  }
  const tmpFile = path.join(tmpDir, 'receipt.json');
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmpFile, finalPath);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // tmp dir may already be empty (rename moved its only file). Best-effort.
    }
  }
  return merged;
}

/**
 * Walks the receipt directory, unlinks files older than 24h (mtime-based).
 * Best-effort — never throws. Cheap enough to call on every hook entry.
 */
export function pruneOldReceipts({ cwd, dirRel } = {}) {
  if (!cwd) cwd = process.cwd();
  const dir = receiptDir(cwd, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - DISK_TTL_MS;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Returns receipts whose status freshness window (`completedAt + ttlSec` for
 * terminal states, `startedAt + ttlSec` for pending) has not elapsed. Sorted
 * recent-first. Used by quality-gate-context.mjs to surface the latest run.
 */
export function listValidReceipts({ cwd, dirRel } = {}) {
  if (!cwd) cwd = process.cwd();
  const dir = receiptDir(cwd, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.tmp-')) continue;
    const file = path.join(dir, name);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const r = JSON.parse(raw);
      if (!r || r.version !== RECEIPT_VERSION) continue;
      const ttl = (typeof r.ttlSec === 'number' ? r.ttlSec : 300) * 1000;
      const anchor = r.completedAt ?? r.startedAt ?? 0;
      if (anchor + ttl >= now) out.push(r);
    } catch {
      // Skip unreadable / parse-error files.
    }
  }
  out.sort(
    (a, b) =>
      (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0),
  );
  return out;
}

/**
 * Convenience: returns the receipt for `fingerprint` IF it's still fresh per
 * its own `ttlSec`, else null. Used by the Stop hook to decide whether to
 * skip spawning the gate.
 */
export function readFreshReceipt({ cwd, fingerprint, dirRel } = {}) {
  const r = readReceipt({ cwd, fingerprint, dirRel });
  if (!r) return null;
  const ttl = (typeof r.ttlSec === 'number' ? r.ttlSec : 300) * 1000;
  const anchor = r.completedAt ?? r.startedAt ?? 0;
  if (anchor + ttl < Date.now()) return null;
  return r;
}

/** Receipt directory absolute path (for callers that need it for logging). */
export function receiptDirFor(cwd, dirRel) {
  return receiptDir(cwd ?? process.cwd(), dirRel);
}
