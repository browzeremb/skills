#!/usr/bin/env node
/**
 * render-blast.mjs — emit a mermaid blast-radius diagram from a YAML-frontmatter
 * .md file produced by scope-feature (EXPLORATION.md) or generate-task (TASK_NN.md).
 *
 * Usage:
 *   node render-blast.mjs <path-to-md> --scope feature|task
 *
 * Output:
 *   --scope feature → writes EXPLORATION_BLAST.mmd next to the input
 *   --scope task    → writes <basename>_BLAST.mmd next to the input
 *
 * The structured YAML frontmatter is the source of truth consumed by
 * downstream LLMs (execute-task, code-review, write-tests, feature-acceptance).
 * The .mmd sidecar is for HUMAN review — never parsed by LLMs.
 *
 * Caps nodes at NODE_CAP_PER_DIRECTION per file/direction to keep the diagram
 * readable; truncation is flagged in a header comment. Empty blast radius
 * exits 0 silently — a brand-new file legitimately has no graph to draw.
 *
 * Pure Node + the `yaml` dep declared in packages/skills/package.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import yaml from 'yaml';

// ───────────────────────────── entry ─────────────────────────────

const [, , inputPath, ...rest] = process.argv;
const args = parseArgs(rest);

if (!inputPath || !args.scope) {
  console.error('Usage: render-blast.mjs <path-to-md> --scope feature|task');
  process.exit(1);
}
if (!['feature', 'task'].includes(args.scope)) {
  console.error(`Invalid --scope: ${args.scope} (expected: feature | task)`);
  process.exit(1);
}

const NODE_CAP_PER_DIRECTION = 15;

const raw = readFileSync(inputPath, 'utf8');
const fm = parseFrontmatter(raw, inputPath);

const { nodes, edges, truncated } =
  args.scope === 'feature' ? collectFeatureGraph(fm) : collectTaskGraph(fm);

if (nodes.length === 0) {
  console.log(
    `render-blast: ${inputPath} has no blast radius — skipping render.`,
  );
  process.exit(0);
}

const dir = dirname(inputPath);
const inputBase = basename(inputPath, extname(inputPath));
const outName =
  args.scope === 'feature' ? 'EXPLORATION_BLAST.mmd' : `${inputBase}_BLAST.mmd`;
const outPath = join(dir, outName);

writeFileSync(
  outPath,
  renderMermaid({ nodes, edges, truncated, scope: args.scope, fm }),
);
console.log(
  `render-blast: wrote ${outPath} (${nodes.length} nodes, ${edges.length} edges)`,
);

// ──────────────────────────── frontmatter ─────────────────────────

function parseFrontmatter(raw, srcPath) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) {
    console.error(`No YAML frontmatter in ${srcPath}`);
    process.exit(1);
  }
  return yaml.parse(m[1]);
}

function parseArgs(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--scope') out.scope = rest[++i];
  }
  return out;
}

// ──────────────────────────── collection ──────────────────────────

/**
 * Feature scope: union all per-file blast radii under domains[].likelyFiles[].
 * Touched set = union of likelyFiles[].path across every domain.
 */
function collectFeatureGraph(fm) {
  const domains = fm.domains || [];
  const touched = new Set();
  for (const d of domains) {
    for (const f of d.likelyFiles || []) {
      if (f.path) touched.add(f.path);
    }
  }
  return collectFromFiles(
    domains.flatMap((d) => d.likelyFiles || []),
    touched,
  );
}

/**
 * Task scope: scope.files[] is the touched set; each entry carries its own
 * blastRadius. The TASK_NN.md template mirrors the per-file shape exactly so
 * this collector is shared.
 */
function collectTaskGraph(fm) {
  const files = fm.scope?.files || [];
  const touched = new Set();
  for (const f of files) {
    if (f.path) touched.add(f.path);
  }
  return collectFromFiles(files, touched);
}

function collectFromFiles(files, touched) {
  // Node order is insertion order: touched files first (in array order),
  // then external/test nodes as edges are processed.
  const nodes = new Map(); // path -> { kind: touched|external|test }
  const edges = []; // { from, to, kind }
  let truncated = false;

  // Seed touched nodes so they keep stable IDs (F0…Fn-1) regardless of edge order.
  for (const file of files) {
    if (file?.path && !nodes.has(file.path)) {
      nodes.set(file.path, { kind: 'touched' });
    }
  }

  for (const file of files) {
    const from = file?.path;
    if (!from) continue;
    const br = file.blastRadius || {};
    const fwdAll = Array.isArray(br.forward) ? br.forward : [];
    const revAll = Array.isArray(br.reverse) ? br.reverse : [];
    const fwd = fwdAll.slice(0, NODE_CAP_PER_DIRECTION);
    const rev = revAll.slice(0, NODE_CAP_PER_DIRECTION);
    if (fwdAll.length > NODE_CAP_PER_DIRECTION) truncated = true;
    if (revAll.length > NODE_CAP_PER_DIRECTION) truncated = true;
    if (br.truncatedAt != null) truncated = true;

    for (const f of fwd) {
      const target = f?.target;
      if (!target) continue;
      if (!nodes.has(target))
        nodes.set(target, { kind: classify(target, touched) });
      edges.push({ from, to: target, kind: f.kind || 'imports' });
    }
    for (const r of rev) {
      const source = r?.source;
      if (!source) continue;
      if (!nodes.has(source))
        nodes.set(source, { kind: classify(source, touched) });
      edges.push({ from: source, to: from, kind: r.kind || 'imported-by' });
    }
  }

  return {
    nodes: [...nodes.entries()].map(([path, meta]) => ({ path, ...meta })),
    edges,
    truncated,
  };
}

function classify(path, touched) {
  if (touched.has(path)) return 'touched';
  if (/(?:__tests__|\.test\.|\.spec\.|_test\.go|_spec\.rb)/.test(path))
    return 'test';
  return 'external';
}

// ──────────────────────────── render ──────────────────────────────

function renderMermaid({ nodes, edges, truncated, scope, fm }) {
  const idForPath = new Map();
  nodes.forEach((n, i) => idForPath.set(n.path, `F${i}`));

  const header =
    scope === 'feature'
      ? `Feature blast radius — ${fm.featureId || '(unknown)'}`
      : `Task blast radius — ${fm.taskId || '(unknown)'}`;

  const preface = [
    `%% ${header}`,
    `%% Auto-generated by scope-feature/scripts/render-blast.mjs.`,
    `%% Source of truth: YAML frontmatter on the sibling .md file. Do not edit.`,
  ];
  if (truncated) {
    preface.push(
      `%% NOTE: truncated to ${NODE_CAP_PER_DIRECTION}/direction — see frontmatter for full lists.`,
    );
  }

  const lines = [
    ...preface,
    '',
    'graph LR',
    `  classDef touched fill:#fef3c7,stroke:#f59e0b,color:#000`,
    `  classDef external fill:#dbeafe,stroke:#3b82f6,color:#000`,
    `  classDef test fill:#dcfce7,stroke:#10b981,color:#000`,
    '',
  ];

  for (const n of nodes) {
    const id = idForPath.get(n.path);
    lines.push(`  ${id}["${sanitize(n.path)}"]:::${n.kind}`);
  }

  if (edges.length > 0) lines.push('');
  for (const e of edges) {
    const from = idForPath.get(e.from);
    const to = idForPath.get(e.to);
    if (!from || !to) continue;
    lines.push(`  ${from} -->|${sanitizeLabel(e.kind)}| ${to}`);
  }

  return lines.join('\n') + '\n';
}

// ──────────────────────────── utils ───────────────────────────────

/**
 * Sanitize a path for embedding in a mermaid node label.
 * - Strip CR/LF.
 * - Escape embedded double quotes (label is wrapped in `"…"`).
 * - Collapse runs of whitespace.
 * - Cap at 80 chars; mermaid renderers wrap visually past that.
 */
function sanitize(s) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '\\"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Sanitize an edge kind for the `-->|<kind>|` syntax.
 * Pipe characters would close the label early; cap at 30 chars.
 */
function sanitizeLabel(s) {
  return String(s || '')
    .replace(/[|]/g, '/')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 30);
}
