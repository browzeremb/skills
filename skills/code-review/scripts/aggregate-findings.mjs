#!/usr/bin/env node
/**
 * aggregate-findings.mjs
 *
 * Reads:  docs/browzer/<feat>/staging/review-lanes/CODE_REVIEW.<lane>.md (× N lanes)
 * Writes: docs/browzer/<feat>/staging/review/CODE_REVIEW.md
 *
 * Preserve-all merge algorithm — see
 * ${CLAUDE_PLUGIN_ROOT}/skills/code-review/references/finding-shape.md.
 *
 * Tolerates these shape drifts (aliases normalized before merge):
 *   - `summary:`            → `description:`
 *   - `pin: {path, ...}`    → `pinsFiles: [pin.path]` (when pinsFiles absent)
 *   - `pin.startLine`       → `line:`               (when line absent)
 *   - missing `ruleId:`     → `"general"`           (warns to stderr)
 *
 * Strict validation (default): a finding with empty `description` or empty
 * `fix` (after alias normalization) causes the aggregator to exit 1 with a
 * structured stderr line before writing any output.
 *
 * --allow-partial: restores legacy permissive behavior — partial findings are
 * emitted with a template-default fix value and a single stderr warning line
 * with the count. Emergency-use-only; prefer fixing lane files instead.
 *
 * Dedup tolerates ±LINE_FUZZ line drift (default 5) when (file, ruleId)
 * matches and either ruleId is non-`general` on both sides OR titles overlap.
 *
 * Usage:
 *   node aggregate-findings.mjs <featureId> [--allow-partial]
 *   node aggregate-findings.mjs --help
 */

const LINE_FUZZ = 5;

// U+2014 EM DASH — used verbatim in structured rejection/warning lines.
const EM = '—';

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ALLOW_PARTIAL = process.argv.includes('--allow-partial');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    [
      'Usage: node aggregate-findings.mjs <featureId> [--allow-partial]',
      '',
      'Options:',
      `  --allow-partial  Emergency-use-only: emit partial findings (empty description/fix)`,
      `                   instead of rejecting. Counts violations and writes a single`,
      `                   stderr warning line: "aggregator: WARN ${EM} N finding(s) template-defaulted".`,
      '  --help           Show this message.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

function die(msg, code = 1) {
  process.stderr.write(`aggregate-findings: ${msg}\n`);
  process.exit(code);
}

// Resolve the host repo root by preferring an env hint, then walking up for a
// `.git` or `.browzer/config.json` marker. Falls back to `process.cwd()` so
// existing test fixtures that drive the script from a sandbox cwd keep working.
function resolveRepoRoot() {
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && existsSync(envRoot)) return envRoot;
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, '.browzer', 'config.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// Aliases: see ${CLAUDE_PLUGIN_ROOT}/skills/code-review/references/finding-shape.md §Aliases.
// violations[] is mutated in-place; each entry is { lane, id, field } for
// post-loop rejection (strict mode) or counting (--allow-partial).
// laneOrphanCounters is a Map<lane, number> that supplies stable orphan ids
// when raw.id is missing — required because the post-merge sort comparator
// calls .localeCompare on the smallest mergedFrom id and would otherwise
// dereference undefined.
function normalizeFinding(raw, lane, warnings, violations, laneOrphanCounters) {
  const f = { ...raw, lane };
  // id default — every finding MUST carry a non-empty id by the end of
  // normalization so the sort comparator at the merge step is null-safe.
  // Missing id is template-defaulted to `<lane>-orphan-<N>` (per-lane counter).
  if (typeof f.id !== 'string' || f.id.trim() === '') {
    const prev = laneOrphanCounters.get(lane) ?? 0;
    const next = prev + 1;
    laneOrphanCounters.set(lane, next);
    f.id = `${lane}-orphan-${next}`;
  }
  // description ← summary
  if (
    (f.description === undefined ||
      f.description === null ||
      f.description === '') &&
    typeof f.summary === 'string' &&
    f.summary.length > 0
  ) {
    f.description = f.summary;
  }
  // pin object → pinsFiles[] + line
  if (f.pin && typeof f.pin === 'object') {
    if (typeof f.pin.path === 'string' && f.pin.path.length > 0) {
      const existing = Array.isArray(f.pinsFiles) ? f.pinsFiles : [];
      if (!existing.includes(f.pin.path))
        f.pinsFiles = [f.pin.path, ...existing];
    }
    if (
      (f.line === undefined || f.line === null) &&
      typeof f.pin.startLine === 'number'
    ) {
      f.line = f.pin.startLine;
    }
  }
  // pinsFile (singular) → pinsFiles[]
  if (
    !Array.isArray(f.pinsFiles) &&
    typeof f.pinsFile === 'string' &&
    f.pinsFile.length > 0
  ) {
    f.pinsFiles = [f.pinsFile];
  }
  // ensure file appears in pinsFiles
  if (typeof f.file === 'string') {
    if (!Array.isArray(f.pinsFiles)) f.pinsFiles = [];
    if (!f.pinsFiles.includes(f.file)) f.pinsFiles.unshift(f.file);
  }
  // ruleId default
  if (!f.ruleId || typeof f.ruleId !== 'string') {
    warnings.push(
      `${lane}/${f.id || '<no-id>'}: ruleId missing — defaulted to "general"`,
    );
    f.ruleId = 'general';
  }
  // description / fix: validate after alias normalization.
  // In strict mode (default) violations accumulate for post-loop rejection.
  // In --allow-partial mode violations are counted and a template-default is
  // injected so downstream phases are not blocked on empty fields.
  const findingId = f.id || '<no-id>';
  if (
    f.description === undefined ||
    f.description === null ||
    typeof f.description !== 'string' ||
    f.description.trim() === ''
  ) {
    violations.push({ lane, id: findingId, field: 'description' });
    f.description = '';
  }
  if (
    f.fix === undefined ||
    f.fix === null ||
    typeof f.fix !== 'string' ||
    f.fix.trim() === ''
  ) {
    violations.push({ lane, id: findingId, field: 'fix' });
    // Template-default keeps downstream phases unblocked when --allow-partial
    // is active. The fixer derives concrete steps from title + description.
    f.fix =
      '(derive from title + description; lane did not emit a structured fix block)';
  }
  return f;
}

// Two findings merge when they share a normalized file path AND
//   (a) ruleId matches (canonical case) OR
//   (b) ruleId is "general" on at least one side AND title-token overlap is ≥40%
// AND their lines are within LINE_FUZZ of each other (or one side has no line).
function canMerge(a, b) {
  if (a.file !== b.file) return false;
  const sameRule =
    a.ruleId &&
    b.ruleId &&
    a.ruleId !== 'general' &&
    b.ruleId !== 'general' &&
    a.ruleId === b.ruleId;
  const generalSideMatchesTitle =
    (a.ruleId === 'general' || b.ruleId === 'general') &&
    titlesOverlap(a.title, b.title);
  if (!sameRule && !generalSideMatchesTitle) return false;
  if (a.line == null || b.line == null) return true;
  return Math.abs(a.line - b.line) <= LINE_FUZZ;
}

function titlesOverlap(t1, t2) {
  if (!t1 || !t2) return false;
  const norm = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4),
    );
  const a = norm(t1);
  const b = norm(t2);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const denom = Math.min(a.size, b.size);
  return shared / denom >= 0.4;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return parseYaml(m[1]);
}

// Minimal YAML parser sufficient for finding shapes (lists of maps + scalars).
// Doesn't handle every edge case but matches what code-review lane files emit.
function parseYaml(src) {
  const root = {};
  const lines = src.split('\n');
  parseBlock(lines, 0, 0, root);
  return root;
}

// Consume an indented block-scalar (literal `|` or folded `>`), starting at
// the line AFTER the indicator. Returns { idx, lines } where lines is the
// raw collected slice (caller joins with the appropriate separator).
function consumeBlockScalar(lines, idx, blockIndent) {
  const blockLines = [];
  while (idx < lines.length) {
    const bl = lines[idx];
    const bi = bl.length - bl.trimStart().length;
    if (bl.trim() === '') {
      blockLines.push('');
      idx++;
      continue;
    }
    if (bi < blockIndent) break;
    blockLines.push(bl.slice(blockIndent));
    idx++;
  }
  return { idx, blockLines };
}

// Table-driven dispatch for a single `key: rest` line. `target` is the map or
// list-item to mutate (assigns `target[key] = value`). `parentIndent` is the
// indent of the parent line that owns `key`; child indent is `parentIndent + 2`.
// Returns the next `idx` after consuming this entry. Both parseBlock and
// parseList route every kv through this single table so the dispatch logic
// lives in ONE place (was previously duplicated 3× at cyclomatic ~30).
const KV_HANDLERS = [
  {
    // Empty rest → child block (nested map OR list of maps OR null sibling).
    match: (rest) => rest === '',
    handle: (ctx) => {
      const { lines, idx, target, key, parentIndent } = ctx;
      const next = lines[idx + 1] || '';
      const nextIndent = next.length - next.trimStart().length;
      if (next.trimStart().startsWith('- ')) {
        const inner = [];
        target[key] = inner;
        return parseList(lines, idx + 1, nextIndent, inner);
      }
      if (nextIndent > parentIndent) {
        const map = {};
        target[key] = map;
        return parseBlock(lines, idx + 1, nextIndent, map);
      }
      target[key] = null;
      return idx + 1;
    },
  },
  {
    // Literal block scalar (`|`): newlines preserved.
    match: (rest) => rest === '|',
    handle: (ctx) => {
      const { lines, idx, target, key, parentIndent } = ctx;
      const { idx: nextIdx, blockLines } = consumeBlockScalar(
        lines,
        idx + 1,
        parentIndent + 2,
      );
      target[key] = blockLines.join('\n').trimEnd();
      return nextIdx;
    },
  },
  {
    // Folded block scalar (`>`): newlines collapsed to spaces.
    match: (rest) => rest.startsWith('>'),
    handle: (ctx) => {
      const { lines, idx, target, key, parentIndent } = ctx;
      const { idx: nextIdx, blockLines } = consumeBlockScalar(
        lines,
        idx + 1,
        parentIndent + 2,
      );
      target[key] = blockLines.join(' ').replace(/\s+/g, ' ').trim();
      return nextIdx;
    },
  },
  {
    // Inline flow list (`[a, b, c]`).
    match: (rest) => rest.startsWith('[') && rest.endsWith(']'),
    handle: (ctx) => {
      const { target, key, rest, idx } = ctx;
      target[key] = parseInlineList(rest);
      return idx + 1;
    },
  },
  {
    // Default: plain scalar.
    match: () => true,
    handle: (ctx) => {
      const { target, key, rest, idx } = ctx;
      target[key] = parseScalar(rest);
      return idx + 1;
    },
  },
];

function dispatchKv(lines, idx, target, key, rest, parentIndent) {
  const handler = KV_HANDLERS.find((h) => h.match(rest));
  return handler.handle({ lines, idx, target, key, rest, parentIndent });
}

function parseBlock(lines, idx, indent, out) {
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      idx++;
      continue;
    }
    const curIndent = line.length - line.trimStart().length;
    if (curIndent < indent) return idx;
    const trimmed = line.trimStart();
    const kv = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) return idx;
    idx = dispatchKv(lines, idx, out, kv[1], kv[2], curIndent);
  }
  return idx;
}

function parseList(lines, idx, indent, arr) {
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      idx++;
      continue;
    }
    const curIndent = line.length - line.trimStart().length;
    if (curIndent < indent) return idx;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('- ')) return idx;
    const rest = trimmed.slice(2);
    const inlineKv = rest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!inlineKv) {
      // Scalar list item
      arr.push(parseScalar(rest));
      idx++;
      continue;
    }
    const item = {};
    arr.push(item);
    // First kv on the same line as the `- ` marker — parent indent matches
    // the dash position (curIndent), so child indent is curIndent + 2.
    idx = dispatchKv(lines, idx, item, inlineKv[1], inlineKv[2], curIndent);
    // Parse subsequent kvs at child indent (curIndent + 2)
    const childIndent = curIndent + 2;
    while (idx < lines.length) {
      const bl = lines[idx];
      if (bl.trim() === '' || bl.trim().startsWith('#')) {
        idx++;
        continue;
      }
      const bi = bl.length - bl.trimStart().length;
      if (bi < childIndent) break;
      if (bi > childIndent) {
        idx++;
        continue;
      }
      if (bl.trimStart().startsWith('- ')) break;
      const ckv = bl.trimStart().match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!ckv) {
        idx++;
        continue;
      }
      idx = dispatchKv(lines, idx, item, ckv[1], ckv[2], bi);
    }
  }
  return idx;
}

function parseInlineList(s) {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((x) => parseScalar(x.trim()));
}

function parseScalar(s) {
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeYamlDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    // YAML 1.2: only escape inside single-quoted is doubled single-quote.
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

// Double-quoted scalar unescaper that survives reviewer-authored regex
// fragments. `JSON.parse` rejects `"use \d+"` with "Bad escaped character"
// because `\d` is not a JSON escape — that single failure mode previously
// required a manual frontmatter edit before the aggregator could run.
// Here we recognize the conventional escapes via a table-lookup; for anything
// else we preserve the backslash AND the following character verbatim, so
// `"\d+"` round-trips as `\d+` instead of disappearing as `d+`.
const YAML_DQ_ESCAPES = {
  '\\': '\\',
  '"': '"',
  n: '\n',
  t: '\t',
  r: '\r',
  0: '\0',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '/': '/',
};
function unescapeYamlDoubleQuoted(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    i++;
    out += YAML_DQ_ESCAPES[next] ?? `\\${next}`;
  }
  return out;
}

function renderYaml(obj, depth = 0) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else if (typeof v[0] === 'object' && v[0] !== null) {
        lines.push(`${pad}${k}:`);
        for (const it of v) {
          const entries = Object.entries(it);
          if (entries.length === 0) continue;
          lines.push(
            `${pad}  - ${entries[0][0]}: ${renderScalarYaml(entries[0][1], depth + 2)}`,
          );
          for (let i = 1; i < entries.length; i++) {
            lines.push(
              `${pad}    ${entries[i][0]}: ${renderScalarYaml(entries[i][1], depth + 2)}`,
            );
          }
        }
      } else {
        lines.push(
          `${pad}${k}: [${v.map((x) => renderScalarYaml(x, depth)).join(', ')}]`,
        );
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${pad}${k}:`);
      lines.push(renderYaml(v, depth + 1));
    } else {
      lines.push(`${pad}${k}: ${renderScalarYaml(v, depth)}`);
    }
  }
  return lines.join('\n');
}

function renderScalarYaml(v, depth) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v))
    return `[${v.map((x) => renderScalarYaml(x, depth)).join(', ')}]`;
  const s = String(v);
  if (s.includes('\n')) {
    const indent = '  '.repeat(depth + 1);
    return `|\n${s
      .split('\n')
      .map((l) => indent + l)
      .join('\n')}`;
  }
  if (/^[A-Za-z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

// Load the PRD's uxCategory + successMetrics[] for the severity-crossref step.
// Returns null when the PRD is missing or unparseable — the crossref then no-ops
// and findings keep their lane-graded severity. The aggregator MUST NOT fail on
// PRD absence; that path is for resumes against feats whose PRD vanished.
function loadPrdContext(stagingDir) {
  const prdPath = join(stagingDir, 'planning', 'PRD.md');
  if (!existsSync(prdPath)) return null;
  let fm;
  try {
    fm = parseFrontmatter(readFileSync(prdPath, 'utf8'));
  } catch {
    return null;
  }
  if (!fm) return null;
  const metricsById = new Map();
  if (Array.isArray(fm.successMetrics)) {
    for (const m of fm.successMetrics) {
      if (m && typeof m === 'object' && typeof m.id === 'string') {
        metricsById.set(m.id, m);
      }
    }
  }
  // uxCategory may live at top-level (legacy) or nested under `feature:`.
  const uxCategory =
    (typeof fm.uxCategory === 'string' && fm.uxCategory) ||
    (fm.feature && typeof fm.feature.uxCategory === 'string'
      ? fm.feature.uxCategory
      : null);
  return { metricsById, uxCategory };
}

// Heuristic: a metric is "perception-class" when its description / target /
// method names a user-visible surface or a perception keyword. Same regex shape
// as feature-acceptance's anti-soft-override gate so the two stay aligned.
const PERCEPTION_METRIC_REGEX =
  /\b(perceiv|perceive|visible|visibility|render|UI|paint|frame|FCP|LCP|INP|TTI|skeleton|optimistic|instant|feedback|jank|flicker|stale-looking|lag)\b/i;
function isPerceptionMetric(metric) {
  if (!metric || typeof metric !== 'object') return false;
  const haystack = [
    metric.metric,
    metric.description,
    metric.target,
    metric.method,
  ]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return PERCEPTION_METRIC_REGEX.test(haystack);
}

function main() {
  const featureId = process.argv[2];
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: aggregate-findings <featureId>', 2);
  }
  const featDir = resolve(resolveRepoRoot(), 'docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  const reviewLanesDir = join(stagingDir, 'review-lanes');
  if (!existsSync(reviewLanesDir))
    die(
      `review-lanes/ subfolder not found in ${stagingDir}; orchestrator INIT must have created it`,
      2,
    );

  const laneFiles = readdirSync(reviewLanesDir)
    .filter((e) => /^CODE_REVIEW\.[a-z0-9-]+\.md$/.test(e))
    .filter((e) => e !== 'CODE_REVIEW.md');
  if (laneFiles.length === 0)
    die('no CODE_REVIEW.<lane>.md files found in review-lanes/', 3);

  let prdSha = '';
  let diffBase = '';
  let sensitivePathGate = { matched: false, matchedFiles: [] };
  const allFindings = [];
  const laneFilesMap = {};
  const warnings = [];
  const violations = [];
  const laneOrphanCounters = new Map();

  for (const lf of laneFiles) {
    const text = readFileSync(join(reviewLanesDir, lf), 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) {
      process.stderr.write(`warning: ${lf} has no frontmatter — skipping\n`);
      continue;
    }
    const lane = fm.lane || lf.replace(/^CODE_REVIEW\.|\.md$/g, '');
    laneFilesMap[lane] = lf;
    if (fm.prdSha && !prdSha) prdSha = fm.prdSha;
    if (fm.diffBase && !diffBase) diffBase = fm.diffBase;
    if (fm.sensitivePathGate) sensitivePathGate = fm.sensitivePathGate;
    if (Array.isArray(fm.findings)) {
      for (const f of fm.findings) {
        allFindings.push(
          normalizeFinding(f, lane, warnings, violations, laneOrphanCounters),
        );
      }
    }
  }

  // Emit general alias-normalization warnings before the violation gate.
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  if (violations.length > 0) {
    if (!ALLOW_PARTIAL) {
      // Strict default: collect ALL violations, emit one stderr line per, exit 1
      // at the end. Surfacing every defect in a single run avoids the
      // fix-rerun-fix-rerun loop the first-violation-only behavior produced.
      // No merged artifact is written when violations are present.
      for (const v of violations) {
        process.stderr.write(
          `aggregator: rejected ${EM} ${v.lane}/${v.id}: ${v.field} empty\n`,
        );
      }
      process.exit(1);
    }
    // --allow-partial: emit a single count line, then continue to write output.
    process.stderr.write(
      `aggregator: WARN ${EM} ${violations.length} finding(s) template-defaulted\n`,
    );
  }

  // Preserve-all merge: group by (file, ruleId) with ±LINE_FUZZ line tolerance
  const groups = new Map(); // key (representative) → array of findings
  for (const f of allFindings) {
    let match = null;
    for (const [, group] of groups) {
      if (canMerge(group[0], f)) {
        match = group;
        break;
      }
    }
    if (match) {
      match.push(f);
    } else {
      const key = `${f.file}|${f.line ?? 0}|${f.ruleId}`;
      groups.set(key, [f]);
    }
  }
  // Stable order: by smallest mergedFrom id alphabetically, then by file, then by line
  const merged = [];
  let seq = 0;
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const ga = groups.get(a);
    const gb = groups.get(b);
    const ida = ga.map((x) => x.id).sort()[0];
    const idb = gb.map((x) => x.id).sort()[0];
    // Null-safe: even with id-default in normalizeFinding, defend the
    // comparator against any future path that bypasses normalization.
    const sa = ida ?? '';
    const sb = idb ?? '';
    if (sa !== sb) return sa.localeCompare(sb);
    if (ga[0].file !== gb[0].file) return ga[0].file.localeCompare(gb[0].file);
    return (ga[0].line ?? 0) - (gb[0].line ?? 0);
  });
  for (const key of sortedKeys) {
    seq++;
    const group = groups.get(key);
    const sevRank = { high: 3, medium: 2, low: 1 };
    const maxSev = group.reduce(
      (acc, f) => (sevRank[f.severity] > sevRank[acc] ? f.severity : acc),
      'low',
    );
    const pinsTask = unionArrays(group.map((f) => f.pinsTask || []));
    const pinsAcs = unionArrays(group.map((f) => f.pinsAcs || []));
    const pinsFiles = unionArrays(group.map((f) => f.pinsFiles || []));
    const metricImpact = unionArrays(group.map((f) => f.metricImpact || []));
    const firstWithSkill = group.find((f) => f.assignedSkill);
    merged.push({
      id: `F-${String(seq).padStart(3, '0')}`,
      mergedFrom: group.map((f) => f.id).sort(),
      severity: maxSev,
      lane: group[0].lane,
      file: group[0].file,
      ...(group[0].line !== undefined && group[0].line !== null
        ? { line: group[0].line }
        : {}),
      ruleId: group[0].ruleId,
      title: group[0].title,
      description: group
        .map((f) => f.description)
        .filter(Boolean)
        .join('\n\n---\n\n'),
      ...(pinsTask.length ? { pinsTask } : {}),
      ...(pinsAcs.length ? { pinsAcs } : {}),
      ...(metricImpact.length ? { metricImpact } : {}),
      pinsFiles: pinsFiles.length ? pinsFiles : [group[0].file],
      fix: group.find((f) => f.fix)?.fix || '',
      assignedSkill: firstWithSkill ? firstWithSkill.assignedSkill : null,
    });
  }

  // Severity success-metric crossref — auto-promote findings whose metricImpact
  // intersects the PRD's `must`-tier successMetrics. When the PRD declares
  // `uxCategory: perception` AND the impacted metric is a perception-class
  // metric, the floor is `high` (the finding contradicts the deliverable's
  // defining metric). Otherwise `must`-tier matches floor at `medium`. Cosmetic
  // / UX-rather-than-data-integrity rationales are NOT a valid downgrade when
  // uxCategory == perception. Records the promotion in finding.severityPromotion
  // so receiving-code-review's HALT gate can surface auto-promoted entries
  // separately from lane-graded ones.
  const prdContext = loadPrdContext(stagingDir);
  if (prdContext) {
    for (const f of merged) {
      const impacted = (f.metricImpact || [])
        .map((mid) => prdContext.metricsById.get(mid))
        .filter(Boolean);
      if (impacted.length === 0) continue;
      const isMust = impacted.some(
        (m) => (m.priority || m.tier || 'must') === 'must',
      );
      const definesPerceptionCategory =
        prdContext.uxCategory === 'perception' &&
        impacted.some((m) => isPerceptionMetric(m));
      let floor = null;
      if (definesPerceptionCategory) floor = 'high';
      else if (isMust) floor = 'medium';
      if (!floor) continue;
      const sevRank = { high: 3, medium: 2, low: 1 };
      if (sevRank[f.severity] >= sevRank[floor]) continue;
      f.severityPromotion = {
        from: f.severity,
        to: floor,
        reason: definesPerceptionCategory
          ? `auto-promoted: finding contradicts perception-class successMetric (${impacted
              .map((m) => m.id)
              .join(', ')}) while feature.uxCategory == perception`
          : `auto-promoted: finding impacts must-tier successMetric (${impacted
              .map((m) => m.id)
              .join(', ')})`,
      };
      f.severity = floor;
    }
  }

  const severityCounts = merged.reduce(
    (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }),
    { high: 0, medium: 0, low: 0 },
  );
  const severityPromotions = merged.filter((f) => f.severityPromotion).length;

  const fm = {
    featureId,
    diffBase,
    prdSha,
    generatedAt: new Date().toISOString(),
    totalFindings: merged.length,
    severityCounts,
    ...(severityPromotions > 0 ? { severityPromotions } : {}),
    sensitivePathGate,
    laneFiles: laneFilesMap,
    findings: merged,
  };

  // Render existing body or create
  const reviewDir = join(stagingDir, 'review');
  if (!existsSync(reviewDir))
    die(
      `review/ subfolder not found in ${stagingDir}; orchestrator INIT must have created it`,
      2,
    );
  const aggPath = join(reviewDir, 'CODE_REVIEW.md');
  const verdict =
    severityCounts.high > 0
      ? 'block'
      : severityCounts.medium > 0
        ? 'conditional'
        : 'pass';

  const body = [
    '# Code review — aggregate',
    '',
    '## Verdict',
    '',
    `${severityCounts.high} high, ${severityCounts.medium} medium, ${severityCounts.low} low findings — review-gate **${verdict}**.`,
    '',
    '## Sensitive-path gate',
    '',
    `Matched: \`${sensitivePathGate.matched}\``,
    sensitivePathGate.matchedFiles?.length
      ? `Files: ${sensitivePathGate.matchedFiles.map((f) => `\`${f}\``).join(', ')}`
      : '',
    '',
    '## Per-lane summary',
    '',
    Object.entries(laneFilesMap)
      .map(([lane, file]) => {
        const counts = merged
          .filter((f) => f.lane === lane)
          .reduce(
            (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }),
            { high: 0, medium: 0, low: 0 },
          );
        return `- [${lane}](${file}) — ${counts.high}/${counts.medium}/${counts.low} findings`;
      })
      .join('\n'),
    '',
    merged.some((f) => !f.pinsTask || f.pinsTask.length === 0)
      ? `## Orphan findings\n\nFindings without \`pinsTask[]\` (operator triage required):\n\n${merged
          .filter((f) => !f.pinsTask || f.pinsTask.length === 0)
          .map(
            (f) =>
              `- **${f.id}** [\`${f.severity}\`] ${f.title} (\`${f.file}\`)`,
          )
          .join('\n')}\n`
      : '',
    '## Next phase',
    '',
    merged.length > 0
      ? `Run \`/receiving-code-review ${featureId}\` to dispatch per-finding fixes.`
      : `Skip to \`/write-tests ${featureId}\` — no findings to address.`,
    '',
  ].join('\n');

  const out = ['---', renderYaml(fm), '---', '', body, ''].join('\n');
  writeFileSync(aggPath, out, 'utf8');
  console.log(`wrote ${aggPath} (${merged.length} findings)`);
}

function unionArrays(arrs) {
  const seen = new Set();
  const out = [];
  for (const a of arrs) {
    for (const x of a) {
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

main();
