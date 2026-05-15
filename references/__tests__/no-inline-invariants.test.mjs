// This test verifies that the dispatch-invariants closed set is not duplicated inline
// in any individual skill body. Until consumer skills are migrated to Read the shared
// reference, this test is expected to fail. The failure is informational: it tracks
// the migration progress.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FINGERPRINT =
  'the dispatcher truncates at the first newline and surfaces a warning';

const repoRoot = join(__dirname, '..', '..', '..', '..');
const skillsRoot = join(repoRoot, 'packages', 'skills', 'skills');

function getSkillFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = join(dir, entry.name, 'SKILL.md');
      try {
        statSync(skillFile);
        results.push(skillFile);
      } catch {
        // no SKILL.md in this directory
      }
    }
  }
  return results;
}

const skillFiles = getSkillFiles(skillsRoot);

test('no SKILL.md contains the inline invariants fingerprint', () => {
  const violations = [];
  for (const filePath of skillFiles) {
    const content = readFileSync(filePath, 'utf8');
    if (content.includes(FINGERPRINT)) {
      violations.push(filePath.replace(repoRoot + '/', ''));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Found inline invariant copies in: ${violations.join(', ')}`,
  );
});
