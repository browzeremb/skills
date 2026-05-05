#!/usr/bin/env node
//
// detect-prepush-gates.test.mjs — unit tests for the pre-push audit detector.
//
// Strategy: spawn the script under bash with a controlled CWD that simulates
// husky / git-hook layouts (lefthook-yaml branch is harder to test without a
// real lefthook binary on PATH; we shadow it via a fake stub on PATH for that
// case). Each test runs in an isolated tmpdir so PATH and filesystem mutations
// do not leak.
//
// Run via: node --test packages/skills/skills/commit/scripts/detect-prepush-gates.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, 'detect-prepush-gates.sh');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'detect-gates-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(cwd, env = {}) {
  // Use an empty PATH augmented only with /usr/bin + /bin + the optional
  // stub-bin dir, so tests are isolated from the developer's lefthook/yq
  // installation.
  const out = execFileSync('bash', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: env.PATH ?? '/usr/bin:/bin',
      ...env,
    },
  });
  return JSON.parse(out);
}

describe('detect-prepush-gates', () => {
  it('returns empty arrays when no gate config is present', () => {
    withTmp((dir) => {
      const result = runIn(dir);
      assert.deepEqual(result, { audits: [], failed: [], runners: [] });
    });
  });

  it('detects and runs a husky pre-push hook (passing)', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.husky'));
      writeFileSync(
        join(dir, '.husky', 'pre-push'),
        '#!/usr/bin/env bash\nexit 0\n',
      );
      const result = runIn(dir);
      assert.deepEqual(result.runners, ['husky']);
      assert.equal(result.audits.length, 1);
      assert.equal(result.audits[0].name, 'husky:pre-push');
      assert.equal(result.audits[0].source, 'husky');
      assert.equal(result.audits[0].exitCode, 0);
      assert.deepEqual(result.failed, []);
    });
  });

  it('captures a failing husky pre-push hook in the failed[] array', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.husky'));
      writeFileSync(
        join(dir, '.husky', 'pre-push'),
        '#!/usr/bin/env bash\nexit 7\n',
      );
      const result = runIn(dir);
      assert.equal(result.audits[0].exitCode, 7);
      assert.deepEqual(result.failed, ['husky:pre-push']);
    });
  });

  it('detects a raw git pre-push hook only when no higher-level manager is present', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      const hook = join(dir, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(hook, 0o755);
      const result = runIn(dir);
      assert.deepEqual(result.runners, ['git']);
      assert.equal(result.audits[0].name, 'git:pre-push');
    });
  });

  it('skips the raw git hook when husky is also configured', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.husky'));
      writeFileSync(
        join(dir, '.husky', 'pre-push'),
        '#!/usr/bin/env bash\nexit 0\n',
      );
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      const hook = join(dir, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, '#!/usr/bin/env bash\nexit 1\n'); // would fail if run
      chmodSync(hook, 0o755);
      const result = runIn(dir);
      assert.deepEqual(result.runners, ['husky']);
      // raw hook is NOT exercised — its failure does not appear in failed[]
      assert.deepEqual(result.failed, []);
    });
  });

  it('detects and runs a lefthook config (single command, passing) via stubbed binary', () => {
    withTmp((dir) => {
      // Drop a lefthook.yml into the project root.
      writeFileSync(
        join(dir, 'lefthook.yml'),
        [
          'pre-push:',
          '  commands:',
          '    typecheck:',
          '      run: echo ok',
        ].join('\n'),
      );
      // Stub `lefthook` and `yq` on PATH. The detector enumerates command
      // names via yq, then runs each via `lefthook run pre-push --commands <name>`.
      const stubBin = join(dir, 'stub-bin');
      mkdirSync(stubBin);
      const lefthook = join(stubBin, 'lefthook');
      writeFileSync(lefthook, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(lefthook, 0o755);
      const yq = join(stubBin, 'yq');
      writeFileSync(
        yq,
        '#!/usr/bin/env bash\n# Echo the single command name our fixture declares.\necho typecheck\n',
      );
      chmodSync(yq, 0o755);

      const result = runIn(dir, { PATH: `${stubBin}:/usr/bin:/bin` });
      assert.deepEqual(result.runners, ['lefthook']);
      assert.equal(result.audits.length, 1);
      assert.equal(result.audits[0].name, 'lefthook:typecheck');
      assert.equal(result.audits[0].source, 'lefthook');
      assert.equal(result.audits[0].exitCode, 0);
    });
  });

  it('captures a failing lefthook command in failed[]', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'lefthook.yml'),
        ['pre-push:', '  commands:', '    audit:', '      run: false'].join(
          '\n',
        ),
      );
      const stubBin = join(dir, 'stub-bin');
      mkdirSync(stubBin);
      // lefthook stub fails when invoked
      const lefthook = join(stubBin, 'lefthook');
      writeFileSync(lefthook, '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(lefthook, 0o755);
      const yq = join(stubBin, 'yq');
      writeFileSync(yq, '#!/usr/bin/env bash\necho audit\n');
      chmodSync(yq, 0o755);

      const result = runIn(dir, { PATH: `${stubBin}:/usr/bin:/bin` });
      assert.deepEqual(result.failed, ['lefthook:audit']);
      assert.equal(result.audits[0].exitCode, 1);
    });
  });
});
