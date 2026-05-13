#!/usr/bin/env node
/**
 * append-receipts.mjs — append/refresh the `## scope-feature` section in
 * docs/browzer/<featureId>/RECEIPTS.md from /tmp/scope-*.json receipts.
 *
 * Usage:
 *   node append-receipts.mjs <featureId>
 *
 * Scans the system tmp directory for receipts named:
 *   scope-(ask|search|explore|deps|rdeps|status)-*.json
 *
 * Behaviour:
 *   - Existing RECEIPTS.md → append (or replace in-place) the section delimited
 *     by sentinel HTML comments. Other sections (e.g. `## generate-prd`) are
 *     preserved untouched. Idempotent across re-runs.
 *   - Missing RECEIPTS.md → create with a header before writing the section.
 *
 * Raw receipts stay in /tmp (gitignored by the OS). Only the consolidated
 * RECEIPTS.md is committed.
 *
 * Pure Node — no npm dependencies.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ───────────────────────────── entry ─────────────────────────────

const [, , featureId] = process.argv;
if (!featureId || !/^feat-[0-9]{8}-[a-z0-9-]+$/.test(featureId)) {
  console.error('Usage: append-receipts.mjs <featureId>');
  console.error('featureId must match ^feat-[0-9]{8}-[a-z0-9-]+$');
  process.exit(1);
}

// macOS sets os.tmpdir() to /var/folders/.../T/ while LLM-generated bash
// snippets commonly write to literal `/tmp/`. Scan both so receipts written
// to either path are picked up; de-dup on (type, slug) so the same receipt
// appearing in both dirs is counted once.
const SCAN_DIRS = uniqueDirs([tmpdir(), '/tmp']);
const RECEIPT_RE = /^scope-(ask|search|explore|deps|rdeps|status)-(.+)\.json$/;

const buckets = {
  status: [],
  ask: [],
  search: [],
  explore: [],
  deps: [],
  rdeps: [],
};
const seenSlugs = new Set();

for (const dir of SCAN_DIRS) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const m = RECEIPT_RE.exec(name);
    if (!m) continue;
    const [, type, slug] = m;
    const key = `${type}:${slug}`;
    if (seenSlugs.has(key)) continue;
    seenSlugs.add(key);
    const fullPath = join(dir, name);
    let payload;
    try {
      payload = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
    buckets[type].push({ slug, path: fullPath, payload });
  }
}

function uniqueDirs(paths) {
  return Array.from(new Set(paths));
}

const outDir = join('docs', 'browzer', featureId, 'staging');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'RECEIPTS.md');

const BEGIN = '<!-- scope-feature:BEGIN — managed by append-receipts.mjs -->';
const END = '<!-- scope-feature:END -->';

const section = renderSection(buckets);
const merged = mergeSection(outPath, featureId, section);
writeFileSync(outPath, merged);

const totalReceipts = Object.values(buckets).reduce(
  (n, arr) => n + arr.length,
  0,
);
console.log(
  `append-receipts: wrote ${outPath} (${totalReceipts} scope-feature receipts).`,
);

// ──────────────────────────── render section ─────────────────────

function renderSection(buckets) {
  const lines = [
    BEGIN,
    '',
    '## scope-feature',
    '',
    `> Auto-generated. Raw receipts matched \`scope-*.json\` in \`${SCAN_DIRS.join('` and `')}\` (OS-tmp; not committed).`,
    '',
  ];
  let totalReceipts = 0;
  for (const type of ['status', 'ask', 'search', 'explore', 'deps', 'rdeps']) {
    const items = buckets[type];
    if (!items.length) continue;
    totalReceipts += items.length;
    const heading =
      type === 'rdeps' ? 'browzer deps --reverse' : `browzer ${type}`;
    lines.push(`### ${heading} (${items.length})`);
    lines.push('');
    lines.push(`| Slug | Path | Summary |`);
    lines.push(`|---|---|---|`);
    for (const { slug, path, payload } of items) {
      lines.push(
        `| ${escapePipe(slug)} | \`${path}\` | ${summarize(type, payload)} |`,
      );
    }
    lines.push('');
  }
  if (totalReceipts === 0) {
    lines.push(
      `> No scope-feature receipts found in \`${SCAN_DIRS.join('` or `')}\`. Did the skill run the grounding protocol?`,
    );
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

function mergeSection(receiptsPath, featureId, section) {
  let existing;
  if (existsSync(receiptsPath)) {
    existing = readFileSync(receiptsPath, 'utf8');
  } else {
    existing = `# Receipts — ${featureId}\n\n`;
  }
  const sentinelRe = new RegExp(
    `${escapeRegex(BEGIN)}[\\s\\S]*?${escapeRegex(END)}`,
  );
  if (sentinelRe.test(existing)) {
    return existing.replace(sentinelRe, section);
  }
  // No prior section — append after the file's existing content with a blank line.
  return existing.trimEnd() + '\n\n' + section + '\n';
}

// ──────────────────────────── helpers ─────────────────────────────

function summarize(type, payload) {
  if (type === 'ask') {
    const ans = payload.answer || payload.response || '';
    return escapePipe(truncate(String(ans).replace(/\s+/g, ' '), 100));
  }
  if (type === 'search' || type === 'explore') {
    const hits = payload.results || payload.hits || payload.entries || [];
    const count = Array.isArray(hits) ? hits.length : 0;
    return `${count} hit${count === 1 ? '' : 's'}`;
  }
  if (type === 'deps' || type === 'rdeps') {
    const importedBy = payload.importedBy || [];
    const imports = payload.imports || [];
    const direction = type === 'rdeps' ? 'reverse' : 'forward';
    const items = type === 'rdeps' ? importedBy : imports;
    const count = Array.isArray(items) ? items.length : 0;
    return `${direction}: ${count}`;
  }
  if (type === 'status') {
    const staleness = payload.staleness || payload.indexStaleness || 'unknown';
    return `staleness: ${staleness}`;
  }
  return '—';
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escapePipe(s) {
  return String(s).replace(/\|/g, '\\|');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
