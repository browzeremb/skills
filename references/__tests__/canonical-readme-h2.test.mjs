import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const filePath = join(__dirname, '..', 'canonical-readme-h2.md');
const content = readFileSync(filePath, 'utf8');

// ---------------------------------------------------------------------------
// Parse the canonical table.
// Rows have the form: | H2 heading | always-emit | rationale |
// The header row and separator row are skipped via the always-emit value guard.
// ---------------------------------------------------------------------------
const VALID_CLASSIFIERS = new Set(['yes', 'conditional', 'optional']);

/** @type {Array<{heading: string, alwaysEmit: string, rationale: string}>} */
const rows = content
  .split('\n')
  .map((line) => {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (!m) return null;
    const [, heading, alwaysEmit, rationale] = m;
    // Skip the header row and separator row
    if (!VALID_CLASSIFIERS.has(alwaysEmit)) return null;
    return {
      heading: heading.trim(),
      alwaysEmit: alwaysEmit.trim(),
      rationale: rationale.trim(),
    };
  })
  .filter(Boolean);

// Frozen canonical order — update this list when a new heading is added.
// The list must stay in the same order as the table in canonical-readme-h2.md.
const CANONICAL_ORDER = Object.freeze([
  'Summary',
  'Original request',
  'Acceptance',
  'Tasks completed',
  'Code review',
  'Fixes applied',
  'Tests added',
  'Docs patched',
  'Tech debt',
  'Known issues',
  'Deploy notes',
  'Blast radius (top reverse dependencies)',
  'Blast-radius receipts',
  'Deferred actions / follow-ups',
  'Phase summary',
  'Tasks',
  'What was NOT verified',
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('canonical-readme-h2: closed-set is non-empty (≥ 17 entries)', () => {
  assert.ok(
    rows.length >= 17,
    `Expected at least 17 table rows, got ${rows.length}`,
  );
});

test('canonical-readme-h2: order matches frozen canonical list', () => {
  const actual = rows.map((r) => r.heading);
  assert.deepStrictEqual(
    actual,
    [...CANONICAL_ORDER],
    'Row order does not match CANONICAL_ORDER',
  );
});

test('canonical-readme-h2: every entry has a valid always-emit classifier', () => {
  for (const row of rows) {
    assert.ok(
      VALID_CLASSIFIERS.has(row.alwaysEmit),
      `Row "${row.heading}" has invalid always-emit value: "${row.alwaysEmit}"`,
    );
  }
});

test('canonical-readme-h2: no duplicate headings', () => {
  const seen = new Set();
  for (const row of rows) {
    assert.ok(
      !seen.has(row.heading),
      `Duplicate heading found: "${row.heading}"`,
    );
    seen.add(row.heading);
  }
});

test('canonical-readme-h2: every entry has a non-empty rationale', () => {
  for (const row of rows) {
    assert.ok(
      row.rationale.length > 0,
      `Row "${row.heading}" has an empty rationale`,
    );
  }
});

// AC-3.1 compatibility: the file must still contain ≥1 ^## heading
// (finalize-feature's grep -cE '^## ' gate must pass).
test('canonical-readme-h2: file still contains ≥1 H2 heading (AC-3.1)', () => {
  const h2Count = content.split('\n').filter((l) => /^## \S/.test(l)).length;
  assert.ok(h2Count >= 1, `Expected ≥1 ^## heading, got ${h2Count}`);
});
