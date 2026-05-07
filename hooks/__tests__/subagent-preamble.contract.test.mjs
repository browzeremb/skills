// Contract test for references/subagent-preamble.md.
// Asserts that the three required clauses added by TASK_05 are present.
// Pure node:test + node stdlib. No external dependencies.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PREAMBLE_PATH = path.resolve(
  __dirname,
  '../../references/subagent-preamble.md',
);

const content = fs.readFileSync(PREAMBLE_PATH, 'utf8');

describe('subagent-preamble.md contract', () => {
  it('contains the skillsLoaded[] invocation imperative', () => {
    assert.ok(
      content.includes(
        'For each name listed in `skillsLoaded[]`, invoke `Skill: <name>`',
      ),
      'Expected clause "For each name listed in skillsLoaded[], invoke Skill: <name>" not found',
    );
  });

  it('requires skills to be loaded BEFORE any Read/Edit/Write work', () => {
    assert.ok(
      content.includes('BEFORE any Read/Edit/Write'),
      'Expected imperative ordering clause "BEFORE any Read/Edit/Write" not found',
    );
  });

  it('contains the --save discovery-receipt clause', () => {
    assert.ok(
      content.includes('--save /tmp/<phase>-<noun>.json'),
      'Expected discovery-receipt clause with "--save /tmp/<phase>-<noun>.json" not found',
    );
  });
});
