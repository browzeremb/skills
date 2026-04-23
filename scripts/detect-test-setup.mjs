#!/usr/bin/env node
// detect-test-setup.mjs
// Agnostic probe: does the current repo have a test setup we can drive?
// Used by write-tests, test-driven-development, verification-before-completion.
//
// Runs from any CWD; defaults to the CWD when --repo is not passed.
// Node v18+ stdlib only — no npm dependencies.
//
// Output shape (stdout, JSON):
//   {
//     "hasTestSetup": boolean,          // overall verdict
//     "language": string|null,          // best-guess primary language
//     "runners": [                      // ordered by confidence
//       { "name": "vitest", "config": "vitest.config.ts", "testCommand": "...", "confidence": "high" },
//       ...
//     ],
//     "signals": {
//       "configFiles": string[],        // e.g. ["vitest.config.ts", "tsconfig.json"]
//       "scripts": Record<string,string>,
//       "testFileCount": number,
//       "manifestFiles": string[]
//     },
//     "testCommand": string|null,       // first runner's command if any
//     "hint": string|null               // human-readable reason if hasTestSetup=false
//   }
//
// Exit codes:
//   0 — ran successfully (hasTestSetup may be true or false)
//   1 — I/O error (permission, unreadable manifest, etc.)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let repoRoot = process.cwd();
let maxScanDepth = 4; // how deep to walk when counting test files

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1]) {
    repoRoot = args[i + 1];
    i++;
  } else if (args[i] === '--max-depth' && args[i + 1]) {
    maxScanDepth = Number.parseInt(args[i + 1], 10) || maxScanDepth;
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(
      'usage: detect-test-setup.mjs [--repo <path>] [--max-depth <n>]',
    );
    process.exit(0);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fileExists = (p) => existsSync(p) && statSync(p).isFile();
const dirExists = (p) => existsSync(p) && statSync(p).isDirectory();

function readJsonIfExists(path) {
  if (!fileExists(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(path) {
  if (!fileExists(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Walks up to maxScanDepth levels, collecting files that look like tests.
// Skips node_modules, dist, build, .git, .next, coverage — common high-cardinality
// dirs where we'd waste time and double-count.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  '.turbo',
  'coverage',
  '.venv',
  'venv',
  'target',
  '.pytest_cache',
  '__pycache__',
  '.worktrees',
  'worktrees',
]);

const TEST_NAME_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /_test\.go$/,
  /_test\.py$/,
  /^test_.*\.py$/,
  /\.test\.ex(s)?$/,
  /\.test\.rs$/,
];

function countTestFiles(root, depth) {
  if (depth < 0) return 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      // __tests__/, tests/, spec/ directories count as positive signals even
      // if we can't see inside them — record that.
      if (['__tests__', 'tests', 'spec', 'specs'].includes(entry.name)) {
        total += 1;
      }
      total += countTestFiles(p, depth - 1);
    } else if (entry.isFile()) {
      if (TEST_NAME_PATTERNS.some((re) => re.test(entry.name))) {
        total += 1;
      }
    }
  }
  return total;
}

// ── Detection ─────────────────────────────────────────────────────────────────
const configFiles = [];
const manifestFiles = [];
const runners = [];
const scripts = {};
let language = null;

// JavaScript / TypeScript
const pkgJson = readJsonIfExists(join(repoRoot, 'package.json'));
if (pkgJson) {
  manifestFiles.push('package.json');
  if (!language) {
    const hasTs =
      fileExists(join(repoRoot, 'tsconfig.json')) ||
      (pkgJson.devDependencies?.typescript ?? pkgJson.dependencies?.typescript);
    language = hasTs ? 'typescript' : 'javascript';
  }
  if (pkgJson.scripts) {
    for (const [k, v] of Object.entries(pkgJson.scripts)) {
      if (typeof v === 'string' && (k === 'test' || k.startsWith('test:'))) {
        scripts[k] = v;
      }
    }
  }

  const jsRunners = [
    {
      name: 'vitest',
      configs: [
        'vitest.config.ts',
        'vitest.config.mts',
        'vitest.config.js',
        'vitest.config.mjs',
      ],
      dep: 'vitest',
    },
    {
      name: 'jest',
      configs: [
        'jest.config.ts',
        'jest.config.js',
        'jest.config.mjs',
        'jest.config.cjs',
        'jest.config.json',
      ],
      dep: 'jest',
    },
    {
      name: 'mocha',
      configs: ['.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js'],
      dep: 'mocha',
    },
    {
      name: 'playwright',
      configs: ['playwright.config.ts', 'playwright.config.js'],
      dep: '@playwright/test',
    },
    {
      name: 'cypress',
      configs: ['cypress.config.ts', 'cypress.config.js'],
      dep: 'cypress',
    },
    {
      name: 'ava',
      configs: ['ava.config.js', 'ava.config.mjs', 'ava.config.cjs'],
      dep: 'ava',
    },
    {
      name: 'node-test',
      configs: [],
      dep: null, // node --test is stdlib since v18
    },
  ];

  for (const r of jsRunners) {
    const presentConfig = r.configs.find((c) => fileExists(join(repoRoot, c)));
    const presentDep =
      r.dep &&
      (pkgJson.devDependencies?.[r.dep] || pkgJson.dependencies?.[r.dep]);
    const scriptMentions =
      (scripts.test && scripts.test.includes(r.name)) ||
      Object.values(scripts).some((s) => s.includes(r.name));
    if (presentConfig || presentDep || scriptMentions) {
      if (presentConfig) configFiles.push(presentConfig);
      const pm = pkgJson.packageManager?.startsWith('pnpm')
        ? 'pnpm'
        : pkgJson.packageManager?.startsWith('yarn')
          ? 'yarn'
          : 'npm';
      const cmd = scripts.test || `${pm} test`;
      runners.push({
        name: r.name,
        config: presentConfig ?? null,
        testCommand: cmd,
        confidence: presentConfig && scriptMentions ? 'high' : 'medium',
      });
    }
  }
}

// Python
if (fileExists(join(repoRoot, 'pyproject.toml'))) {
  manifestFiles.push('pyproject.toml');
  if (!language) language = 'python';
  const text = readTextIfExists(join(repoRoot, 'pyproject.toml')) || '';
  if (text.includes('[tool.pytest') || fileExists(join(repoRoot, 'pytest.ini'))) {
    if (fileExists(join(repoRoot, 'pytest.ini'))) configFiles.push('pytest.ini');
    runners.push({
      name: 'pytest',
      config: 'pyproject.toml',
      testCommand: 'pytest',
      confidence: 'high',
    });
  } else if (text.includes('[tool.poetry.dev-dependencies]') && text.includes('pytest')) {
    runners.push({
      name: 'pytest',
      config: 'pyproject.toml',
      testCommand: 'pytest',
      confidence: 'medium',
    });
  }
}
if (fileExists(join(repoRoot, 'pytest.ini')) && !runners.some((r) => r.name === 'pytest')) {
  configFiles.push('pytest.ini');
  runners.push({
    name: 'pytest',
    config: 'pytest.ini',
    testCommand: 'pytest',
    confidence: 'high',
  });
  if (!language) language = 'python';
}
if (fileExists(join(repoRoot, 'tox.ini'))) {
  configFiles.push('tox.ini');
  if (!runners.some((r) => r.name === 'tox')) {
    runners.push({
      name: 'tox',
      config: 'tox.ini',
      testCommand: 'tox',
      confidence: 'medium',
    });
  }
  if (!language) language = 'python';
}

// Go
if (fileExists(join(repoRoot, 'go.mod'))) {
  manifestFiles.push('go.mod');
  if (!language) language = 'go';
  // Presence of go.mod is enough — `go test ./...` is stdlib.
  runners.push({
    name: 'go',
    config: 'go.mod',
    testCommand: 'go test ./...',
    confidence: 'high',
  });
}

// Rust
if (fileExists(join(repoRoot, 'Cargo.toml'))) {
  manifestFiles.push('Cargo.toml');
  if (!language) language = 'rust';
  runners.push({
    name: 'cargo',
    config: 'Cargo.toml',
    testCommand: 'cargo test',
    confidence: 'high',
  });
}

// Elixir
if (fileExists(join(repoRoot, 'mix.exs'))) {
  manifestFiles.push('mix.exs');
  if (!language) language = 'elixir';
  runners.push({
    name: 'mix',
    config: 'mix.exs',
    testCommand: 'mix test',
    confidence: 'high',
  });
}

// Ruby
if (fileExists(join(repoRoot, 'Gemfile'))) {
  manifestFiles.push('Gemfile');
  if (!language) language = 'ruby';
  const gemfile = readTextIfExists(join(repoRoot, 'Gemfile')) || '';
  if (gemfile.includes('rspec')) {
    runners.push({
      name: 'rspec',
      config: 'Gemfile',
      testCommand: 'bundle exec rspec',
      confidence: 'medium',
    });
  } else if (gemfile.includes('minitest')) {
    runners.push({
      name: 'minitest',
      config: 'Gemfile',
      testCommand: 'bundle exec rake test',
      confidence: 'medium',
    });
  }
}

// Count test files anywhere in the tree (bounded by maxScanDepth + SKIP_DIRS).
const testFileCount = countTestFiles(repoRoot, maxScanDepth);

// ── Verdict ───────────────────────────────────────────────────────────────────
// hasTestSetup requires at least one of:
//   - a named runner detected (config or manifest or script), OR
//   - >= 2 test-named files on disk (ambient signal — someone runs these).
const hasTestSetup = runners.length > 0 || testFileCount >= 2;

let hint = null;
if (!hasTestSetup) {
  if (manifestFiles.length === 0) {
    hint =
      'No recognised manifest (package.json, pyproject.toml, go.mod, Cargo.toml, Gemfile, mix.exs) at the repo root. This repo may not be an application codebase, or the detector should be pointed elsewhere via --repo.';
  } else {
    hint = `Manifests found (${manifestFiles.join(', ')}) but no runner/config/test files detected. The repo probably never had tests — skills that depend on this detector should skip their mutation/verification phases.`;
  }
}

// Fallback testCommand: when runners is empty but a package.json `test` script
// exists, surface it so callers don't need to re-probe. Common in monorepos
// where the runner config lives inside sub-packages.
const fallbackTestCommand =
  scripts.test ??
  (pkgJson ? `${pkgJson.packageManager?.startsWith('pnpm') ? 'pnpm' : 'npm'} test` : null);

const out = {
  hasTestSetup,
  language,
  runners,
  signals: {
    configFiles,
    scripts,
    testFileCount,
    manifestFiles,
  },
  testCommand: runners[0]?.testCommand ?? fallbackTestCommand,
  hint,
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
