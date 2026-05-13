#!/usr/bin/env node
/**
 * aggregate-findings.mjs
 *
 * Reads:  docs/browzer/<feat>/CODE_REVIEW.<lane>.md (× N lanes)
 * Writes: docs/browzer/<feat>/CODE_REVIEW.md
 *
 * Preserve-all merge algorithm — see
 * ${CLAUDE_PLUGIN_ROOT}/skills/code-review/references/finding-shape.md.
 *
 * Tolerates these shape drifts (aliases normalized before merge):
 *   - `summary:`            → `description:`
 *   - `pin: {path, ...}`    → `pinsFiles: [pin.path]` (when pinsFiles absent)
 *   - `pin.startLine`       → `line:`               (when line absent)
 *   - missing `ruleId:`     → `"general"`           (warns to stderr)
 *   - missing `description:`→ ""                    (warns to stderr)
 *   - missing `fix:`        → ""                    (warns to stderr)
 *
 * Dedup tolerates ±LINE_FUZZ line drift (default 5) when (file, ruleId)
 * matches and either ruleId is non-`general` on both sides OR titles overlap.
 *
 * Usage:
 *   node aggregate-findings.mjs <featureId>
 */

const LINE_FUZZ = 5;

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
function normalizeFinding(raw, lane, warnings) {
  const f = { ...raw, lane };
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
  // description / fix presence warnings (don't drop)
  if (
    f.description === undefined ||
    f.description === null ||
    f.description === ''
  ) {
    warnings.push(
      `${lane}/${f.id || '<no-id>'}: description missing — emitting empty`,
    );
    f.description = '';
  }
  if (f.fix === undefined || f.fix === null || f.fix === '') {
    warnings.push(`${lane}/${f.id || '<no-id>'}: fix missing — emitting empty`);
    f.fix = '';
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
    const key = kv[1];
    const rest = kv[2];
    if (rest === '') {
      // child block — could be map or list of maps
      const next = lines[idx + 1] || '';
      const nextIndent = next.length - next.trimStart().length;
      if (next.trimStart().startsWith('- ')) {
        const arr = [];
        out[key] = arr;
        idx = parseList(lines, idx + 1, nextIndent, arr);
      } else if (nextIndent > curIndent) {
        const map = {};
        out[key] = map;
        idx = parseBlock(lines, idx + 1, nextIndent, map);
      } else {
        out[key] = null;
        idx++;
      }
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = parseInlineList(rest);
      idx++;
    } else {
      out[key] = parseScalar(rest);
      idx++;
    }
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
    if (inlineKv) {
      const item = {};
      arr.push(item);
      // Parse first kv on the same line
      if (inlineKv[2] === '') {
        const next = lines[idx + 1] || '';
        const nextIndent = next.length - next.trimStart().length;
        if (next.trimStart().startsWith('- ')) {
          const inner = [];
          item[inlineKv[1]] = inner;
          idx = parseList(lines, idx + 1, nextIndent, inner);
        } else if (nextIndent > curIndent) {
          const map = {};
          item[inlineKv[1]] = map;
          idx = parseBlock(lines, idx + 1, nextIndent, map);
        } else {
          item[inlineKv[1]] = null;
          idx++;
        }
      } else if (inlineKv[2] === '|') {
        // Block scalar — consume indented lines
        idx++;
        const blockLines = [];
        const blockIndent = curIndent + 2;
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
        item[inlineKv[1]] = blockLines.join('\n').trimEnd();
      } else if (inlineKv[2].startsWith('[') && inlineKv[2].endsWith(']')) {
        item[inlineKv[1]] = parseInlineList(inlineKv[2]);
        idx++;
      } else {
        item[inlineKv[1]] = parseScalar(inlineKv[2]);
        idx++;
      }
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
        if (ckv[2] === '') {
          const next = lines[idx + 1] || '';
          const nextIndent = next.length - next.trimStart().length;
          if (next.trimStart().startsWith('- ')) {
            const inner = [];
            item[ckv[1]] = inner;
            idx = parseList(lines, idx + 1, nextIndent, inner);
          } else if (nextIndent > bi) {
            const map = {};
            item[ckv[1]] = map;
            idx = parseBlock(lines, idx + 1, nextIndent, map);
          } else {
            item[ckv[1]] = null;
            idx++;
          }
        } else if (ckv[2].startsWith('>')) {
          // Folded scalar — consume indented lines and join with spaces.
          idx++;
          const blockLines = [];
          const blockIndent = bi + 2;
          while (idx < lines.length) {
            const bl2 = lines[idx];
            const bi2 = bl2.length - bl2.trimStart().length;
            if (bl2.trim() === '') {
              blockLines.push('');
              idx++;
              continue;
            }
            if (bi2 < blockIndent) break;
            blockLines.push(bl2.slice(blockIndent));
            idx++;
          }
          item[ckv[1]] = blockLines.join(' ').replace(/\s+/g, ' ').trim();
        } else if (ckv[2] === '|') {
          idx++;
          const blockLines = [];
          const blockIndent = bi + 2;
          while (idx < lines.length) {
            const bl2 = lines[idx];
            const bi2 = bl2.length - bl2.trimStart().length;
            if (bl2.trim() === '') {
              blockLines.push('');
              idx++;
              continue;
            }
            if (bi2 < blockIndent) break;
            blockLines.push(bl2.slice(blockIndent));
            idx++;
          }
          item[ckv[1]] = blockLines.join('\n').trimEnd();
        } else if (ckv[2].startsWith('[') && ckv[2].endsWith(']')) {
          item[ckv[1]] = parseInlineList(ckv[2]);
          idx++;
        } else {
          item[ckv[1]] = parseScalar(ckv[2]);
          idx++;
        }
      }
    } else {
      // Scalar list item
      arr.push(parseScalar(rest));
      idx++;
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
// Here we recognize the conventional escapes; for anything else we preserve
// the backslash AND the following character verbatim, so `"\d+"` round-trips
// as `\d+` instead of disappearing as `d+`.
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
    switch (next) {
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '0':
        out += '\0';
        break;
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case '/':
        out += '/';
        break;
      default:
        out += `\\${next}`;
        break;
    }
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

  const laneFiles = readdirSync(stagingDir)
    .filter((e) => /^CODE_REVIEW\.[a-z0-9-]+\.md$/.test(e))
    .filter((e) => e !== 'CODE_REVIEW.md');
  if (laneFiles.length === 0) die('no CODE_REVIEW.<lane>.md files found', 3);

  let prdSha = '';
  let diffBase = '';
  let sensitivePathGate = { matched: false, matchedFiles: [] };
  const allFindings = [];
  const laneFilesMap = {};
  const warnings = [];

  for (const lf of laneFiles) {
    const text = readFileSync(join(stagingDir, lf), 'utf8');
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
        allFindings.push(normalizeFinding(f, lane, warnings));
      }
    }
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
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  // Stable order: by smallest mergedFrom id alphabetically, then by file, then by line
  const merged = [];
  let seq = 0;
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const ga = groups.get(a);
    const gb = groups.get(b);
    const ida = ga.map((x) => x.id).sort()[0];
    const idb = gb.map((x) => x.id).sort()[0];
    if (ida !== idb) return ida.localeCompare(idb);
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
      pinsFiles: pinsFiles.length ? pinsFiles : [group[0].file],
      fix: group.find((f) => f.fix)?.fix || '',
      assignedSkill: firstWithSkill ? firstWithSkill.assignedSkill : null,
    });
  }

  const severityCounts = merged.reduce(
    (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }),
    { high: 0, medium: 0, low: 0 },
  );

  const fm = {
    featureId,
    diffBase,
    prdSha,
    generatedAt: new Date().toISOString(),
    totalFindings: merged.length,
    severityCounts,
    sensitivePathGate,
    laneFiles: laneFilesMap,
    findings: merged,
  };

  // Render existing body or create
  const aggPath = join(stagingDir, 'CODE_REVIEW.md');
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
