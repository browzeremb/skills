#!/usr/bin/env node
/**
 * append-receipts.mjs — append/refresh the `## generate-task` section in
 * docs/browzer/<featureId>/RECEIPTS.md from a decisions JSON receipt.
 *
 * Usage:
 *   node append-receipts.mjs <featureId>
 *
 * Reads the consolidated decisions file (if present):
 *   /tmp/tasks-decisions-<featureId>.json
 *
 * Schema (all fields optional, but at least one expected):
 *   {
 *     "suppressed": [
 *       {
 *         "candidateTitle": "Write unit tests for foo",
 *         "candidateScope": ["packages/cli/internal/commands/ask.go"],
 *         "reason": "duplicates-canonical-phase-write-tests",
 *         "detectedBy": "reviewer-pass"
 *       }
 *     ],
 *     "groundingQueries": [
 *       { "tool": "browzer search", "query": "...", "receiptPath": "/tmp/..." }
 *     ],
 *     "granularitySummary": [
 *       { "taskId": "TASK_03", "verdict": "split", "rationale": "..." }
 *     ]
 *   }
 *
 * Behaviour:
 *   - RECEIPTS.md exists → append (or replace in-place) the `## generate-task`
 *     section delimited by sentinel HTML comments. Other sections preserved.
 *   - RECEIPTS.md absent → create it with a header before writing the section.
 *   - Decisions file absent → write an empty `## generate-task` section
 *     stating no decisions were recorded (still idempotent).
 *
 * Pure Node — no npm dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ───────────────────────────── entry ─────────────────────────────

const [, , featureId] = process.argv;
if (!featureId || !/^feat-[0-9]{8}-[a-z0-9-]+$/.test(featureId)) {
  console.error('Usage: append-receipts.mjs <featureId>');
  console.error('featureId must match ^feat-[0-9]{8}-[a-z0-9-]+$');
  process.exit(1);
}

// macOS sets os.tmpdir() to /var/folders/.../T/ while LLM-generated bash
// snippets commonly write to literal `/tmp/`. Check both for the decisions
// JSON so we accept whichever path the Reviewer used.
const decisionsCandidates = uniqueDirs([tmpdir(), '/tmp']).map((d) =>
  join(d, `tasks-decisions-${featureId}.json`),
);
const decisionsPath = decisionsCandidates.find((p) => existsSync(p)) || null;
let decisions = {};
if (decisionsPath) {
  try {
    decisions = JSON.parse(readFileSync(decisionsPath, 'utf8'));
  } catch (err) {
    console.error(
      `append-receipts: failed to parse ${decisionsPath}: ${err.message}`,
    );
    process.exit(1);
  }
}

function uniqueDirs(paths) {
  return Array.from(new Set(paths));
}

const outDir = join('docs', 'browzer', featureId);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'RECEIPTS.md');

const BEGIN = '<!-- generate-task:BEGIN — managed by append-receipts.mjs -->';
const END = '<!-- generate-task:END -->';

const section = renderSection(
  decisions,
  decisionsPath || decisionsCandidates[0],
);
const merged = mergeSection(outPath, featureId, section);
writeFileSync(outPath, merged);

const counts = countItems(decisions);
console.log(
  `append-receipts: wrote ${outPath} (suppressed=${counts.suppressed}, queries=${counts.queries}, granularity-flags=${counts.granularity}).`,
);

// ──────────────────────────── render ──────────────────────────────

function renderSection(decisions, decisionsPath) {
  const lines = [
    BEGIN,
    '',
    '## generate-task',
    '',
    `> Auto-generated from \`${decisionsPath}\` (OS-tmp; not committed).`,
    '',
  ];

  const suppressed = Array.isArray(decisions.suppressed)
    ? decisions.suppressed
    : [];
  const queries = Array.isArray(decisions.groundingQueries)
    ? decisions.groundingQueries
    : [];
  const granularity = Array.isArray(decisions.granularitySummary)
    ? decisions.granularitySummary
    : [];

  if (
    suppressed.length === 0 &&
    queries.length === 0 &&
    granularity.length === 0
  ) {
    lines.push(
      '> No generate-task decisions recorded. Either the Reviewer pass had no suppressions/queries, or the decisions file was missing at run time.',
    );
    lines.push('');
  }

  if (suppressed.length > 0) {
    lines.push(
      `### Decomposition decisions — suppressed (${suppressed.length})`,
    );
    lines.push('');
    lines.push('| Candidate title | Reason | Detected by | Scope |');
    lines.push('|---|---|---|---|');
    for (const s of suppressed) {
      const scope = Array.isArray(s.candidateScope)
        ? s.candidateScope.join(', ')
        : '';
      lines.push(
        `| ${escapePipe(s.candidateTitle || '')} | \`${escapePipe(s.reason || '')}\` | ${escapePipe(s.detectedBy || '')} | ${escapePipe(scope)} |`,
      );
    }
    lines.push('');
  }

  if (queries.length > 0) {
    lines.push(`### Reviewer grounding queries (${queries.length})`);
    lines.push('');
    lines.push('| Tool | Query | Receipt |');
    lines.push('|---|---|---|');
    for (const q of queries) {
      lines.push(
        `| ${escapePipe(q.tool || '')} | ${escapePipe(q.query || '')} | \`${escapePipe(q.receiptPath || '')}\` |`,
      );
    }
    lines.push('');
  }

  if (granularity.length > 0) {
    lines.push(`### Granularity flags (${granularity.length})`);
    lines.push('');
    lines.push('| Task | Verdict | Rationale |');
    lines.push('|---|---|---|');
    for (const g of granularity) {
      lines.push(
        `| ${escapePipe(g.taskId || '')} | ${escapePipe(g.verdict || '')} | ${escapePipe(g.rationale || '')} |`,
      );
    }
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
  return existing.trimEnd() + '\n\n' + section + '\n';
}

function countItems(decisions) {
  return {
    suppressed: Array.isArray(decisions.suppressed)
      ? decisions.suppressed.length
      : 0,
    queries: Array.isArray(decisions.groundingQueries)
      ? decisions.groundingQueries.length
      : 0,
    granularity: Array.isArray(decisions.granularitySummary)
      ? decisions.granularitySummary.length
      : 0,
  };
}

// ──────────────────────────── utils ───────────────────────────────

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
