#!/usr/bin/env node

/**
 * detect-quality-gate.mjs — resolve the host's local quality-gate command tuple.
 *
 * Loaded by ≥2 skills (`execute-task` and `regression-guard`), so it lives
 * in the cross-skill `references/scripts/` location per the
 * `packages/skills/CLAUDE.md` rule.
 *
 * Inspects the host repository's package metadata to pick the appropriate
 * lint+typecheck+test commands. Probes are ordered: turborepo monorepo →
 * pnpm/npm workspaces → plain pnpm/npm → poetry/pip → go module → cargo
 * workspace. Stops at the first match.
 *
 * Usage:
 *   node detect-quality-gate.mjs [--json] [--scope <packageFilter>] [--build]
 *
 * Output (default, --json):
 *   {
 *     "runner": "turbo" | "pnpm" | "npm" | "yarn" | "go" | "cargo" | "pytest" | "unknown",
 *     "lint":      ["pnpm", "turbo", "lint", "--filter=..."],
 *     "typecheck": ["pnpm", "turbo", "typecheck", "--filter=..."],
 *     "test":      ["pnpm", "turbo", "test", "--filter=..."],
 *     "build":     ["pnpm", "turbo", "build", "--filter=..."]    // present only when --build was requested AND runner supports it
 *   }
 *
 * Notes:
 *   - "unknown" runner returns empty arrays; callers should report
 *     "no detectable gate; skipping" rather than fail.
 *   - --scope <filter> threads `--filter=<filter>` into turbo / pnpm
 *     commands. Pass package names or path globs the host's runner
 *     understands.
 *   - The function is pure — only reads files; never executes the gate.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function detect(cwd) {
  // Turborepo monorepo
  if (fileExists(resolve(cwd, 'turbo.json'))) {
    const pkg = readJson(resolve(cwd, 'package.json'));
    if (pkg) {
      const pm = (pkg.packageManager || '').split('@')[0] || 'pnpm';
      return { kind: 'turbo', packageManager: pm };
    }
  }
  // pnpm workspaces (without turbo)
  if (fileExists(resolve(cwd, 'pnpm-workspace.yaml'))) {
    return { kind: 'pnpm-workspace' };
  }
  // Plain pnpm
  if (fileExists(resolve(cwd, 'pnpm-lock.yaml'))) {
    return { kind: 'pnpm' };
  }
  // Yarn classic / berry
  if (fileExists(resolve(cwd, 'yarn.lock'))) {
    return { kind: 'yarn' };
  }
  // npm
  if (
    fileExists(resolve(cwd, 'package-lock.json')) ||
    (fileExists(resolve(cwd, 'package.json')) &&
      !fileExists(resolve(cwd, 'pnpm-lock.yaml')))
  ) {
    return { kind: 'npm' };
  }
  // Cargo workspace
  if (fileExists(resolve(cwd, 'Cargo.toml'))) {
    return { kind: 'cargo' };
  }
  // Go module
  if (fileExists(resolve(cwd, 'go.mod'))) {
    return { kind: 'go' };
  }
  // Python — poetry / pyproject
  if (
    fileExists(resolve(cwd, 'pyproject.toml')) ||
    fileExists(resolve(cwd, 'pytest.ini')) ||
    fileExists(resolve(cwd, 'setup.cfg'))
  ) {
    return { kind: 'pytest' };
  }
  return { kind: 'unknown' };
}

function pkgHasScript(cwd, name) {
  const pkg = readJson(resolve(cwd, 'package.json'));
  if (!pkg || !pkg.scripts) return false;
  return typeof pkg.scripts[name] === 'string';
}

function buildCommandTuple(runner, scope, build) {
  const filter = scope ? [`--filter=${scope}`] : [];
  const out = { runner: runner.kind };

  switch (runner.kind) {
    case 'turbo': {
      const pm =
        runner.packageManager === 'yarn' ? 'yarn' : runner.packageManager;
      const turboPrefix = [pm, 'turbo'];
      out.lint = [...turboPrefix, 'lint', ...filter];
      out.typecheck = [...turboPrefix, 'typecheck', ...filter];
      out.test = [...turboPrefix, 'test', ...filter];
      if (build) out.build = [...turboPrefix, 'build', ...filter];
      break;
    }
    case 'pnpm-workspace':
    case 'pnpm': {
      out.lint = ['pnpm', 'lint', ...filter];
      out.typecheck = ['pnpm', 'typecheck', ...filter];
      out.test = ['pnpm', 'test', ...filter];
      if (build) out.build = ['pnpm', 'build', ...filter];
      break;
    }
    case 'yarn': {
      out.lint = ['yarn', 'lint'];
      out.typecheck = ['yarn', 'typecheck'];
      out.test = ['yarn', 'test'];
      if (build) out.build = ['yarn', 'build'];
      break;
    }
    case 'npm': {
      out.lint = ['npm', 'run', 'lint'];
      out.typecheck = ['npm', 'run', 'typecheck'];
      out.test = ['npm', 'test'];
      if (build) out.build = ['npm', 'run', 'build'];
      break;
    }
    case 'go': {
      // golangci-lint is the de-facto lint; fall back to go vet if absent.
      out.lint = ['golangci-lint', 'run', './...'];
      out.typecheck = ['go', 'vet', './...'];
      out.test = ['go', 'test', './...'];
      if (build) out.build = ['go', 'build', './...'];
      break;
    }
    case 'cargo': {
      out.lint = ['cargo', 'clippy', '--', '-D', 'warnings'];
      out.typecheck = ['cargo', 'check'];
      out.test = ['cargo', 'test'];
      if (build) out.build = ['cargo', 'build'];
      break;
    }
    case 'pytest': {
      // python projects vary a lot — best-effort default chain
      out.lint = ['ruff', 'check', '.'];
      out.typecheck = ['mypy', '.'];
      out.test = ['pytest'];
      if (build) out.build = [];
      break;
    }
    default: {
      out.lint = [];
      out.typecheck = [];
      out.test = [];
      if (build) out.build = [];
    }
  }

  // Sanity sweep: drop tuples for kinds that don't actually have the script.
  // Only applies to npm-style runners — for go/cargo/pytest we trust the
  // binary chain.
  if (['pnpm-workspace', 'pnpm', 'yarn', 'npm'].includes(runner.kind)) {
    const cwd = process.cwd();
    if (!pkgHasScript(cwd, 'lint')) out.lint = [];
    if (!pkgHasScript(cwd, 'typecheck')) out.typecheck = [];
    if (!pkgHasScript(cwd, 'test')) out.test = [];
    if (build && !pkgHasScript(cwd, 'build')) out.build = [];
  }

  return out;
}

function emit(out, _asJson) {
  // JSON is currently the only supported mode; a future revision may add a
  // human-readable mode keyed off `_asJson`. Keep the signature stable.
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : null;
  const build = args.includes('--build');
  const asJson = args.includes('--json') || !args.includes('--text');

  const runner = detect(cwd);
  const out = buildCommandTuple(runner, scope, build);
  emit(out, asJson);
  process.exit(0);
}

// Allow imports for unit tests
export { buildCommandTuple, detect };

if (import.meta.url === `file://${process.argv[1]}`) main();
