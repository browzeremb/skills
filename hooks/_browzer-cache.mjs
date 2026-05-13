// Cross-phase cache for `browzer mentions` (and any other deterministic
// browzer query) keyed by SHA-256 of the query string. Scope is the active
// staging directory — when a feature run ends, its staging/ is gone and so
// is the cache. No TTL: staging-lifetime == cache-lifetime by design.
//
// Public surface is intentionally tiny:
//   getCached(query) -> {hit: boolean, value: unknown}
//   setCached(query, value)
//
// Callers (phase skills, dispatched subagents) should consult getCached()
// BEFORE running the network query, and call setCached() on miss. The
// helper is best-effort: filesystem errors degrade to {hit: false} rather
// than throwing.

import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function resolveStagingDir() {
  const envDir = process.env.BROWZER_STAGING_DIR;
  if (envDir && envDir.length > 0) return envDir;

  let cwd = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(cwd, 'docs', 'browzer');
    if (existsSync(candidate)) {
      const feats = readdirSync(candidate, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('feat-'))
        .map((d) => {
          const stagingPath = join(candidate, d.name, 'staging');
          let mtime = 0;
          try {
            mtime = statSync(stagingPath).mtimeMs;
          } catch {}
          return { name: d.name, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (feats.length > 0) {
        const staging = join(candidate, feats[0].name, 'staging');
        if (existsSync(staging)) return staging;
      }
    }
    const parent = resolve(cwd, '..');
    if (parent === cwd) break;
    cwd = parent;
  }

  return join(tmpdir(), 'browzer-cache-fallback');
}

function cachePathFor(query) {
  const sha = crypto.createHash('sha256').update(query).digest('hex');
  const dir = join(resolveStagingDir(), '.cache');
  return { dir, file: join(dir, `browzer-mentions-${sha}.json`) };
}

export function getCached(query) {
  if (typeof query !== 'string' || query.length === 0) {
    return { hit: false, value: null };
  }
  const { file } = cachePathFor(query);
  try {
    if (!existsSync(file)) return { hit: false, value: null };
    const raw = readFileSync(file, 'utf8');
    return { hit: true, value: JSON.parse(raw) };
  } catch {
    return { hit: false, value: null };
  }
}

export function setCached(query, value) {
  if (typeof query !== 'string' || query.length === 0) return false;
  const { dir, file } = cachePathFor(query);
  try {
    mkdirSync(dir, { recursive: true });
    // Atomic write: tmp + rename keeps a concurrent reader from observing a
    // half-written file when two phases race on the same query.
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
