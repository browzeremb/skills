// Agnostic quality-gate command resolver.
//
// Public API:
//   resolveGateCommand({cwd})      → {command, source, mode} | null
//   loadSkillsConfig(cwd)          → parsed+validated config | null
//   getEffectiveConfig(cwd)        → deep-merged config (defaults ⊕ user)
//   detectPackageManager(cwd)      → 'pnpm' | 'yarn' | 'npm' | 'bun' | null
//
// Cascade order (first non-null wins, fail-soft on every step):
//   1. `.browzer/skills.config.json#gates.affected`
//   2. `package.json#scripts["browzer:gate"]` (run via detected PM)
//   3. Auto-detect by manifest:
//        - turbo.json (with PM probe)
//        - package.json#scripts.test
//        - pyproject.toml
//        - go.mod
//        - Cargo.toml
//   4. null + one-shot stderr advisory.
//
// Never throws. Surfaces a one-shot stderr warning per failure source so an
// agent loop running thousands of hooks doesn't drown the log.

import fs from 'node:fs';
import path from 'node:path';

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`[browzer-gate] ${msg}\n`);
}

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  gates: {},
  hooks: {
    qualityGate: {
      enabled: true,
      timeout: 120,
      receipt: {
        ttl: 300,
        directory: '.browzer/.gate-receipts',
      },
    },
  },
});

function readJsonSafe(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function existsSafe(absPath) {
  try {
    return fs.existsSync(absPath);
  } catch {
    return false;
  }
}

/**
 * Detect package manager via lockfile probe + `package.json#packageManager`
 * override. Order: pnpm → yarn → npm → bun. Override only respected when its
 * spec parses (formato `pnpm@9.15.0`).
 */
export function detectPackageManager(cwd) {
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  if (pkg && typeof pkg.packageManager === 'string') {
    const m = pkg.packageManager.match(/^(pnpm|yarn|npm|bun)@/);
    if (m) return m[1];
  }
  if (existsSafe(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSafe(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSafe(path.join(cwd, 'package-lock.json'))) return 'npm';
  if (existsSafe(path.join(cwd, 'bun.lockb'))) return 'bun';
  return null;
}

/**
 * Schema check for `.browzer/skills.config.json`. Returns the parsed object
 * if valid, otherwise null + one-shot warning. Hand-rolled (no ajv).
 */
function validateConfig(cfg, sourcePath) {
  if (!cfg || typeof cfg !== 'object') {
    warnOnce(`cfg:not-object:${sourcePath}`, `${sourcePath} is not an object`);
    return null;
  }
  if (cfg.version !== 1) {
    warnOnce(
      `cfg:version:${sourcePath}`,
      `${sourcePath} has unsupported version ${JSON.stringify(cfg.version)} (expected 1)`,
    );
    return null;
  }
  if ('gates' in cfg) {
    if (
      typeof cfg.gates !== 'object' ||
      cfg.gates === null ||
      Array.isArray(cfg.gates)
    ) {
      warnOnce(
        `cfg:gates:${sourcePath}`,
        `${sourcePath} 'gates' must be an object`,
      );
      return null;
    }
    if ('affected' in cfg.gates && typeof cfg.gates.affected !== 'string') {
      warnOnce(
        `cfg:gates.affected:${sourcePath}`,
        `${sourcePath} 'gates.affected' must be a string`,
      );
      return null;
    }
    if ('full' in cfg.gates && typeof cfg.gates.full !== 'string') {
      warnOnce(
        `cfg:gates.full:${sourcePath}`,
        `${sourcePath} 'gates.full' must be a string`,
      );
      return null;
    }
  }
  if ('hooks' in cfg) {
    const qg = cfg.hooks?.qualityGate;
    if (qg !== undefined) {
      if (typeof qg !== 'object' || qg === null) {
        warnOnce(
          `cfg:hooks.qg:${sourcePath}`,
          `${sourcePath} 'hooks.qualityGate' must be an object`,
        );
        return null;
      }
      if ('timeout' in qg) {
        const t = qg.timeout;
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1800) {
          warnOnce(
            `cfg:hooks.qg.timeout:${sourcePath}`,
            `${sourcePath} 'hooks.qualityGate.timeout' must be a number in [0,1800]`,
          );
          return null;
        }
      }
      if (qg.receipt && 'ttl' in qg.receipt) {
        const ttl = qg.receipt.ttl;
        if (
          typeof ttl !== 'number' ||
          !Number.isFinite(ttl) ||
          ttl < 60 ||
          ttl > 3600
        ) {
          warnOnce(
            `cfg:hooks.qg.receipt.ttl:${sourcePath}`,
            `${sourcePath} 'hooks.qualityGate.receipt.ttl' must be a number in [60,3600]`,
          );
          return null;
        }
      }
    }
  }
  return cfg;
}

/**
 * Loads `.browzer/skills.config.json` (anchored at cwd, not walked upward).
 * Returns null if missing OR invalid (warning emitted once per failure).
 */
export function loadSkillsConfig(cwd) {
  const p = path.join(cwd, '.browzer', 'skills.config.json');
  if (!existsSafe(p)) return null;
  const cfg = readJsonSafe(p);
  if (cfg === null) {
    warnOnce(`cfg:parse:${p}`, `${p} is not valid JSON — ignoring`);
    return null;
  }
  return validateConfig(cfg, p);
}

/**
 * Deep-merge user config over defaults. Plain-object values are merged
 * recursively; everything else is overwritten. Arrays replace, not concat.
 */
function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(over) || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    const bv = base?.[k];
    const ov = over[k];
    if (
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      ov &&
      typeof ov === 'object' &&
      !Array.isArray(ov)
    ) {
      out[k] = deepMerge(bv, ov);
    } else {
      out[k] = ov;
    }
  }
  return out;
}

export function getEffectiveConfig(cwd) {
  const user = loadSkillsConfig(cwd);
  return deepMerge(DEFAULT_CONFIG, user || {});
}

/**
 * Resolve the gate command for `cwd` via the documented cascade. Returns
 * `{command, source, mode}` where `mode` is 'affected' for cascade steps that
 * scope to the working tree (steps 1-2 with package-script scoping is up to
 * the user; auto-detect emits an 'affected' Turbo command for the monorepo
 * case and 'full' otherwise). Returns null when nothing is detected.
 */
export function resolveGateCommand({ cwd } = {}) {
  if (!cwd) cwd = process.cwd();

  // Step 1: explicit config.
  const cfg = loadSkillsConfig(cwd);
  if (
    cfg &&
    typeof cfg.gates?.affected === 'string' &&
    cfg.gates.affected.trim() !== ''
  ) {
    return {
      command: cfg.gates.affected.trim(),
      source: 'config',
      mode: 'affected',
    };
  }

  // Step 2: package.json#scripts["browzer:gate"].
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts['browzer:gate'] === 'string') {
    const pm = detectPackageManager(cwd) ?? 'npm';
    const runner = pm === 'npm' ? 'npm run' : `${pm} run`;
    return {
      command: `${runner} browzer:gate`,
      source: 'package-script',
      mode: 'affected',
    };
  }

  // Step 3a: turbo.json (Browzer monorepo + any Turborepo user repo).
  if (existsSafe(path.join(cwd, 'turbo.json'))) {
    const pm = detectPackageManager(cwd);
    const cmd =
      pm === 'pnpm' || pm === 'yarn' || pm === 'bun'
        ? `${pm} turbo lint typecheck test --filter='...[origin/main]'`
        : `npx turbo lint typecheck test --filter='...[origin/main]'`;
    return { command: cmd, source: 'auto:turbo', mode: 'affected' };
  }

  // Step 3b: package.json#scripts.test (any plain Node project).
  if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string') {
    const pm = detectPackageManager(cwd) ?? 'npm';
    return { command: `${pm} test`, source: 'auto:npm-test', mode: 'full' };
  }

  // Step 3c: Python (pyproject.toml).
  if (existsSafe(path.join(cwd, 'pyproject.toml'))) {
    return {
      command: 'pytest && ruff check',
      source: 'auto:python',
      mode: 'full',
    };
  }

  // Step 3d: Go (go.mod).
  if (existsSafe(path.join(cwd, 'go.mod'))) {
    return {
      command: 'go test ./... && go vet ./...',
      source: 'auto:go',
      mode: 'full',
    };
  }

  // Step 3e: Rust (Cargo.toml).
  if (existsSafe(path.join(cwd, 'Cargo.toml'))) {
    return {
      command: 'cargo test && cargo clippy -- -D warnings',
      source: 'auto:rust',
      mode: 'full',
    };
  }

  warnOnce(
    `resolve:none:${cwd}`,
    `no quality-gate command detected at ${cwd} — set gates.affected in .browzer/skills.config.json or add scripts.browzer:gate`,
  );
  return null;
}
