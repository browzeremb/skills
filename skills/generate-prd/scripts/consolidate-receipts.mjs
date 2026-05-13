#!/usr/bin/env node
/**
 * consolidate-receipts.mjs — Aggregate /tmp/prd-*.json receipts into RECEIPTS.md.
 *
 * Usage:
 *   node scripts/consolidate-receipts.mjs <featureId>
 *
 * Output:
 *   docs/browzer/<featureId>/RECEIPTS.md
 *
 * Scans the system tmp directory for receipt JSONs named
 *   prd-(ask|search|explore|status)-*.json
 * and emits a readable markdown table grouped by command type.
 *
 * Raw receipts stay in /tmp (gitignored by the OS). Only the consolidated
 * RECEIPTS.md is committed alongside the PRD.
 *
 * Pure Node — no npm dependencies.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ───────────────────────────── entry ─────────────────────────────

const [, , featureId] = process.argv;
if (!featureId || !/^feat-[0-9]{8}-[a-z0-9-]+$/.test(featureId)) {
  console.error('Usage: consolidate-receipts.mjs <featureId>');
  console.error('featureId must match ^feat-[0-9]{8}-[a-z0-9-]+$');
  process.exit(1);
}

const tmp = tmpdir();
const RECEIPT_RE = /^prd-(ask|search|explore|status)-(.+)\.json$/;

const buckets = { ask: [], search: [], explore: [], status: [] };

for (const name of readdirSync(tmp)) {
  const m = RECEIPT_RE.exec(name);
  if (!m) continue;
  const [, type, slug] = m;
  const fullPath = join(tmp, name);
  let payload;
  try {
    payload = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    continue;
  }
  buckets[type].push({ slug, path: fullPath, payload });
}

const outDir = join('docs', 'browzer', featureId);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'RECEIPTS.md');

const sections = [
  `# Receipts — ${featureId}`,
  ``,
  `> Auto-generated. Raw receipts in \`${tmp}/prd-*.json\` (OS-tmp; not committed).`,
  ``,
];

let totalReceipts = 0;

for (const type of ['status', 'ask', 'search', 'explore']) {
  const items = buckets[type];
  if (!items.length) continue;
  totalReceipts += items.length;
  sections.push(`## browzer ${type} (${items.length})`);
  sections.push(``);
  sections.push(`| Slug | Path | Summary |`);
  sections.push(`|---|---|---|`);
  for (const { slug, path, payload } of items) {
    const summary = summarize(type, payload);
    sections.push(`| ${escapePipe(slug)} | \`${path}\` | ${summary} |`);
  }
  sections.push(``);
}

if (totalReceipts === 0) {
  sections.push(
    `> No receipts found in \`${tmp}\`. Did the skill run the grounding protocol?`,
  );
  sections.push(``);
}

writeFileSync(outPath, sections.join('\n'));
console.log(
  `consolidate-receipts: wrote ${outPath} (${totalReceipts} receipts)`,
);

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
