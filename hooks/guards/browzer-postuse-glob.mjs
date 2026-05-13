#!/usr/bin/env node
// PostToolUse(Glob) tracker. Mirrors postuse-grep but honours the optional
// `hooks.glob.mode === "block"` config so the source/filter labels reflect
// what the PreToolUse guard advertised to the model.
//
// Block-mode counterfactual: when Glob is denied the tool_response is
// empty, so a measured savedTokens would always be 0. We instead read the
// per-workspace manifest (same path layout as the daemon's
// `manifest_cache.go`: `~/.browzer/workspaces/<workspaceId>/manifest.json`)
// and estimate savedTokens from the byte-length of files matching the
// Glob pattern. Falls back to a flat 40KB-equivalent estimate when the
// manifest is unavailable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_SURFACE_RE,
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
  tokensOf,
  trackEvent,
  workspaceRootFor,
} from './_util.mjs';

if (!isHookEnabled('postuse-glob')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Glob') process.exit(0);

const ti = input.tool_input ?? {};
const target = [ti.path, ti.pattern, ti.glob, ti.type, ti.include]
  .filter(Boolean)
  .join(' ');

if (CONFIG_SURFACE_RE.test(target)) process.exit(0);

function readWorkspaceConfig() {
  const root = workspaceRootFor(process.cwd());
  if (!root) return null;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, '.browzer', 'config.json'), 'utf8'),
    );
    return cfg ?? null;
  } catch {
    return null;
  }
}

const wsCfg = readWorkspaceConfig();
const mode = wsCfg?.hooks?.glob?.mode === 'block' ? 'block' : 'soft';

/**
 * Match a path against a glob pattern using Node 22's `path.matchesGlob`
 * when available, falling back to a regex equivalent. Patterns supported:
 * `*`, `**`, `?`, character classes, comma-separated lists are NOT
 * supported in the fallback (good enough for the common Glob payloads).
 */
function matchGlob(p, pattern) {
  if (typeof path.matchesGlob === 'function') {
    try {
      return path.matchesGlob(p, pattern);
    } catch {
      /* fall through */
    }
  }
  const re = globToRegExp(pattern);
  return re.test(p);
}

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$|(){}[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * Estimate savedTokens for a denied Glob by scanning the workspace
 * manifest. Returns null when the manifest is unavailable or unreadable.
 */
function counterfactualFromManifest(workspaceId, pattern) {
  if (!workspaceId || !pattern) return null;
  const manifestPath = path.join(
    os.homedir(),
    '.browzer',
    'workspaces',
    workspaceId,
    'manifest.json',
  );
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const files = manifest?.files;
  if (!files || typeof files !== 'object') return null;
  let totalBytes = 0;
  for (const [relPath, entry] of Object.entries(files)) {
    if (!matchGlob(relPath, pattern)) continue;
    const lineCount = entry?.lineCount;
    // Manifest carries lineCount, not byteLength. Approximate ~80 bytes
    // per source line — close enough for an order-of-magnitude estimate.
    if (Number.isFinite(lineCount)) totalBytes += lineCount * 80;
  }
  if (totalBytes === 0) return null;
  return tokensOf(totalBytes);
}

const tr = input.tool_response ?? {};
const content = tr.content ?? tr.stdout ?? '';
const outputBytes = Buffer.byteLength(String(content), 'utf8');

let savedTokens;
let estimationMethod;
if (mode === 'block') {
  const pattern = ti.pattern ?? ti.glob ?? '';
  const cf = counterfactualFromManifest(wsCfg?.workspaceId, pattern);
  if (cf !== null) {
    savedTokens = cf;
    estimationMethod = 'counterfactual';
  } else {
    // Manifest unavailable — fall back to a flat 40KB-equivalent estimate.
    savedTokens = tokensOf(40 * 1024);
    estimationMethod = 'estimated';
  }
} else {
  savedTokens = tokensOf(outputBytes);
  estimationMethod = 'measured';
}

const payload = {
  ts: new Date().toISOString(),
  source: mode === 'block' ? 'hook-glob-blocked' : 'hook-glob-suggested',
  command: 'Glob',
  inputBytes: 0,
  outputBytes,
  savedTokens,
  savingsPct: 0,
  filterLevel: mode === 'block' ? 'blocked' : 'suggested',
  filterFailed: false,
  execMs: 0,
  sessionId: input.session_id ?? null,
  estimationMethod,
};

await trackEvent(payload);

process.exit(0);
