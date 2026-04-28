#!/usr/bin/env node
// auto-format.mjs
// PostToolUse hook on Edit/Write. Formatter-agnostic by design:
// detects the target repo's formatter by file extension + config-file
// presence and runs it on the touched file synchronously. Silent no-op
// if nothing matches.
//
// Shipped with the browzer plugin but only fires inside Browzer-
// initialized repos (via isInBrowzerWorkspace) — the plugin cannot
// impose a formatter on unrelated repos that happen to have Claude
// Code installed.
//
// Matrix (first match wins):
//
//   .ts .tsx .js .jsx .mjs .cjs .json .jsonc
//     biome.json{,c}         → pnpm exec biome check --write  (or npx)
//     .prettierrc* / package.json "prettier" → prettier --write
//     else                   → no-op
//
//   .py
//     pyproject.toml has [tool.ruff] → ruff format
//     black on PATH                  → black --quiet
//     else                           → no-op
//
//   .rs       rustfmt on PATH   → rustfmt
//   .go       gofmt on PATH     → gofmt -w
//   .lua      stylua on PATH    → stylua
//
// Everything else: no-op. Markdown, YAML, TOML, etc. pass through —
// add new extensions by extending pickFormatter() below.
//
// Motivation: retro session-1 §12 / session-2 §4.2 push-time learnings.
// The lefthook pre-commit catches drift at commit time; this hook
// catches drift IN-LOOP so Claude's next turn already sees formatted
// code. No race with the pre-commit — they're complementary.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  isHookEnabled,
  isInBrowzerWorkspace,
  readHookInput,
} from './_util.mjs';

if (!isHookEnabled()) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
const toolName = input?.tool_name;
if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || !fs.existsSync(filePath)) process.exit(0);

const repoRoot = findRepoRoot(filePath);
if (!repoRoot) process.exit(0);

const ext = path.extname(filePath).toLowerCase();
const spec = pickFormatter(ext, repoRoot, filePath);
if (!spec) process.exit(0);

const prefix = pickRunner(repoRoot, spec.pkgEcosystem);
if (!prefix) process.exit(0);

const [cmd, ...rest] = [...prefix, spec.cmd, ...spec.args];
try {
  spawnSync(cmd, rest, {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10_000,
  });
} catch {
  // Formatter binary missing or crashed — silent degradation. Edit
  // survives unformatted; pre-commit / CI still catches it.
}

process.exit(0);

// ─── helpers ─────────────────────────────────────────────────────────

function findRepoRoot(fromPath) {
  let dir = path.dirname(fromPath);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function pickFormatter(ext, repoRoot, file) {
  const jsFamily = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.json',
    '.jsonc',
  ];
  if (jsFamily.includes(ext)) {
    if (hasBiomeConfig(repoRoot)) {
      return {
        cmd: 'biome',
        args: ['check', '--write', file],
        pkgEcosystem: 'node',
      };
    }
    if (hasPrettierConfig(repoRoot)) {
      return { cmd: 'prettier', args: ['--write', file], pkgEcosystem: 'node' };
    }
    return null;
  }

  if (ext === '.py') {
    const pyproject = safeReadFile(path.join(repoRoot, 'pyproject.toml'));
    if (pyproject && /\[tool\.ruff\]/.test(pyproject)) {
      return { cmd: 'ruff', args: ['format', file], pkgEcosystem: 'system' };
    }
    if (commandExists('black')) {
      return { cmd: 'black', args: ['--quiet', file], pkgEcosystem: 'system' };
    }
    return null;
  }

  if (ext === '.rs') {
    if (commandExists('rustfmt')) {
      return { cmd: 'rustfmt', args: [file], pkgEcosystem: 'system' };
    }
    return null;
  }

  if (ext === '.go') {
    if (commandExists('gofmt')) {
      return { cmd: 'gofmt', args: ['-w', file], pkgEcosystem: 'system' };
    }
    return null;
  }

  if (ext === '.lua') {
    if (commandExists('stylua')) {
      return { cmd: 'stylua', args: [file], pkgEcosystem: 'system' };
    }
    return null;
  }

  return null;
}

function pickRunner(repoRoot, pkgEcosystem) {
  if (pkgEcosystem === 'system') return [];
  // node ecosystem — prefer the lockfile's package manager.
  if (fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml')))
    return ['pnpm', 'exec'];
  if (
    fs.existsSync(path.join(repoRoot, 'bun.lock')) ||
    fs.existsSync(path.join(repoRoot, 'bun.lockb'))
  ) {
    return ['bunx'];
  }
  // Default: npx (resolves from node_modules/.bin, works even without lockfile).
  return ['npx'];
}

function hasBiomeConfig(repoRoot) {
  return (
    fs.existsSync(path.join(repoRoot, 'biome.json')) ||
    fs.existsSync(path.join(repoRoot, 'biome.jsonc'))
  );
}

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  '.prettierrc.mjs',
  '.prettierrc.cjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
];

function hasPrettierConfig(repoRoot) {
  for (const name of PRETTIER_CONFIGS) {
    if (fs.existsSync(path.join(repoRoot, name))) return true;
  }
  // Check for "prettier" key in package.json.
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    if (pkg?.prettier !== undefined) return true;
  } catch {
    // no package.json or unreadable — move on
  }
  return false;
}

function safeReadFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const commandExistsCache = new Map();
function commandExists(name) {
  if (commandExistsCache.has(name)) return commandExistsCache.get(name);
  let found = false;
  try {
    execSync(`command -v ${name}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/sh',
    });
    found = true;
  } catch {
    found = false;
  }
  commandExistsCache.set(name, found);
  return found;
}
