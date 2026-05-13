#!/usr/bin/env node
/**
 * append-receipts.mjs — append/refresh the `## execute-task` section in
 * docs/browzer/<featureId>/RECEIPTS.md from per-task execution receipts.
 *
 * Usage:
 *   node append-receipts.mjs <featureId>
 *
 * Sources of truth (both must be scanned, in this order):
 *
 *   1. docs/browzer/<featureId>/TASK_*.completed.md
 *      docs/browzer/<featureId>/TASK_*.failed.md
 *      Read each renamed file's body for the appended `## Execution log`
 *      section. Parse it for: Mode, Model, Effort, Started, Completed,
 *      Skills invoked, file counts.
 *
 *   2. /tmp (system tmpdir + literal /tmp on macOS) for execution dispatch
 *      receipts named:  execute-dispatch-<feat>-<task>.json
 *      Optional sidecar capturing dispatch byte-count + raw subagent report.
 *      When present, augments the table; when absent, we render from the
 *      .completed.md / .failed.md body alone.
 *
 * Behaviour:
 *   - Existing RECEIPTS.md → append (or replace in-place) the section
 *     delimited by sentinel HTML comments. Other sections preserved.
 *   - Missing RECEIPTS.md → create with a header before writing the section.
 *
 * Pure Node — no npm dependencies.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ───────────────────────────── entry ─────────────────────────────

const [, , featureId] = process.argv;
if (!featureId || !/^feat-[0-9]{8}-[a-z0-9-]+$/.test(featureId)) {
  console.error('Usage: append-receipts.mjs <featureId>');
  console.error('featureId must match ^feat-[0-9]{8}-[a-z0-9-]+$');
  process.exit(1);
}

const featDir = join('docs', 'browzer', featureId);
if (!existsSync(featDir)) {
  console.error(`append-receipts: feature directory not found: ${featDir}`);
  process.exit(1);
}

// macOS sets os.tmpdir() to /var/folders/.../T/ while LLM-generated bash
// snippets commonly write to literal `/tmp/`. Scan both; first-found wins.
const SCAN_DIRS = uniqueDirs([tmpdir(), '/tmp']);
const DISPATCH_RE = new RegExp(
  `^execute-dispatch-${escapeRegex(featureId)}-(TASK_[0-9]{2})\\.json$`,
);

// ───────────────────────────── collect tasks ──────────────────────

const COMPLETED_RE = /^TASK_[0-9]{2}\.completed\.md$/;
const FAILED_RE = /^TASK_[0-9]{2}\.failed\.md$/;

const taskFiles = readdirSync(featDir)
  .filter((n) => COMPLETED_RE.test(n) || FAILED_RE.test(n))
  .sort();

const dispatchSidecars = collectDispatchSidecars();

const rows = taskFiles.map((file) => {
  const taskId = file.replace(/\.(completed|failed)\.md$/, '');
  const status = COMPLETED_RE.test(file) ? 'completed' : 'failed';
  const body = readFileSync(join(featDir, file), 'utf8');
  const log = parseExecutionLog(body);
  const sidecar = dispatchSidecars.get(taskId) || null;
  return { taskId, file, status, log, sidecar };
});

// ───────────────────────────── render + write ─────────────────────

const outPath = join(featDir, 'RECEIPTS.md');
const BEGIN = '<!-- execute-task:BEGIN — managed by append-receipts.mjs -->';
const END = '<!-- execute-task:END -->';

const section = renderSection(rows);
const merged = mergeSection(outPath, featureId, section);
if (!existsSync(featDir)) mkdirSync(featDir, { recursive: true });
writeFileSync(outPath, merged);

const completed = rows.filter((r) => r.status === 'completed').length;
const failed = rows.filter((r) => r.status === 'failed').length;
console.log(
  `append-receipts: wrote ${outPath} (completed=${completed}, failed=${failed}, dispatch-sidecars=${dispatchSidecars.size}).`,
);

// ───────────────────────────── helpers ────────────────────────────

function collectDispatchSidecars() {
  const seen = new Map(); // taskId -> { path, payload }
  for (const dir of SCAN_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const m = DISPATCH_RE.exec(name);
      if (!m) continue;
      const taskId = m[1];
      if (seen.has(taskId)) continue; // first-found wins
      const fullPath = join(dir, name);
      let payload;
      try {
        payload = JSON.parse(readFileSync(fullPath, 'utf8'));
      } catch {
        continue;
      }
      seen.set(taskId, { path: fullPath, payload });
    }
  }
  return seen;
}

function parseExecutionLog(body) {
  const m = body.match(
    /##\s+Execution log\b([\s\S]*?)(?=\n##\s+Retry attempt|\n##\s+(?!Execution log)|$)/,
  );
  if (!m) return null;
  const block = m[1];
  const get = (label) => {
    const re = new RegExp(
      `-\\s*\\*\\*${escapeRegex(label)}\\*\\*:\\s*([^\\n]+)`,
    );
    const r = re.exec(block);
    return r ? r[1].trim() : '';
  };
  const filesModified = countListSection(block, 'Files modified');
  const filesCreated = countListSection(block, 'Files created');
  const skills = (get('Skills invoked') || '').split(/\s*,\s*/).filter(Boolean);
  return {
    started: get('Started'),
    completed: get('Completed'),
    mode: get('Mode'),
    model: get('Model'),
    effort: get('Effort'),
    skills,
    filesModified,
    filesCreated,
  };
}

function countListSection(block, heading) {
  const re = new RegExp(
    `###\\s+${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n##\\s+|$)`,
  );
  const m = re.exec(block);
  if (!m) return 0;
  const lines = m[1].split('\n').filter((l) => /^\s*-\s+/.test(l));
  if (lines.length === 1 && /\(none\)/i.test(lines[0])) return 0;
  return lines.length;
}

function renderSection(rows) {
  const lines = [
    BEGIN,
    '',
    '## execute-task',
    '',
    `> Auto-generated from \`docs/browzer/${featureId}/TASK_*.{completed,failed}.md\` and dispatch sidecars under \`${SCAN_DIRS.join('` or `')}\` (OS-tmp; not committed).`,
    '',
  ];

  if (rows.length === 0) {
    lines.push(
      '> No execute-task receipts found. Run `/execute-task <featureId>` for at least one task before re-running this script.',
    );
    lines.push('');
    lines.push(END);
    return lines.join('\n');
  }

  lines.push(
    '| Task | Status | Mode | Model | Effort | Files mod | Files new | Skills | Started → Completed |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const log = r.log || {};
    const skills = (log.skills || []).join(', ') || '—';
    const span =
      log.started && log.completed ? `${log.started} → ${log.completed}` : '—';
    lines.push(
      `| ${r.taskId} | ${r.status} | ${log.mode || '—'} | ${log.model || '—'} | ${log.effort || '—'} | ${log.filesModified ?? '—'} | ${log.filesCreated ?? '—'} | ${escapePipe(skills)} | ${escapePipe(span)} |`,
    );
  }
  lines.push('');

  const sidecarsPresent = rows.filter((r) => r.sidecar);
  if (sidecarsPresent.length > 0) {
    lines.push('### Dispatch sidecars');
    lines.push('');
    lines.push('| Task | Receipt | Bytes | Subagent |');
    lines.push('|---|---|---|---|');
    for (const r of sidecarsPresent) {
      const p = r.sidecar.payload || {};
      lines.push(
        `| ${r.taskId} | \`${r.sidecar.path}\` | ${p.bytes ?? '—'} | ${escapePipe(p.subagentType || 'browzer:coder')} |`,
      );
    }
    lines.push('');
  }

  const failures = rows.filter((r) => r.status === 'failed');
  if (failures.length > 0) {
    lines.push('### Failures');
    lines.push('');
    lines.push('| Task | File |');
    lines.push('|---|---|');
    for (const r of failures) {
      lines.push(`| ${r.taskId} | \`docs/browzer/${featureId}/${r.file}\` |`);
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

function uniqueDirs(paths) {
  return Array.from(new Set(paths));
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
