#!/usr/bin/env node
/**
 * render-task-graph.mjs — emit TASK_GRAPH.md from per-task TASK_NN.md files.
 *
 * Usage:
 *   node render-task-graph.mjs <featureId>
 *
 * Behaviour:
 *   - Globs `docs/browzer/<featureId>/staging/tasks/TASK_*.md` (excludes the
 *     `.completed` variant introduced post-execute-task).
 *   - Parses each TASK_NN.md frontmatter — taskId, title, dependsOn,
 *     scope.files[].path, granularityNote.
 *   - Topologically orders tasks (Kahn). Reports `tasksOrder[]` in that order.
 *   - Computes parallelizable groups by scanning each topological layer for
 *     pairs/groups with disjoint `scope.files[].path` sets.
 *   - Emits `docs/browzer/<featureId>/staging/tasks/TASK_GRAPH.md` with:
 *     · YAML frontmatter manifest (featureId, totalTasks, tasksOrder,
 *       dependencyGraph, parallelizable, generatedAt).
 *     · Mermaid `graph TD` body with subgraph clustering per parallel group.
 *     · A summary table of all non-`ok` granularityNote entries.
 *
 * Determinism: pure over inputs. Re-running with unchanged TASK_NN.md files
 * produces byte-identical output (except `generatedAt` — see --static flag).
 *
 * Pure Node + the `yaml` dep declared in packages/skills/package.json.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import yaml from 'yaml';

// ───────────────────────────── entry ─────────────────────────────

const [, , featureId, ...rest] = process.argv;
if (!featureId || !/^feat-[0-9]{8}-[a-z0-9-]+$/.test(featureId)) {
  console.error('Usage: render-task-graph.mjs <featureId>');
  console.error('featureId must match ^feat-[0-9]{8}-[a-z0-9-]+$');
  process.exit(1);
}
const staticMode = rest.includes('--static');

const featDir = join('docs', 'browzer', featureId);
if (!existsSync(featDir)) {
  console.error(`render-task-graph: feature directory not found: ${featDir}`);
  process.exit(1);
}
const stagingDir = join(featDir, 'staging');
if (!existsSync(stagingDir)) {
  console.error(
    `render-task-graph: staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
  );
  process.exit(1);
}

const TASK_RE = /^TASK_[0-9]{2}\.md$/;
const taskFiles = readdirSync(stagingDir)
  .filter((n) => TASK_RE.test(n))
  .sort();

if (taskFiles.length === 0) {
  console.error(`render-task-graph: no TASK_NN.md files in ${stagingDir}.`);
  process.exit(1);
}

const tasks = taskFiles.map((name) => {
  const full = join(stagingDir, name);
  const raw = readFileSync(full, 'utf8');
  const fm = parseFrontmatter(raw, full);
  return {
    file: name,
    taskId: fm.taskId,
    title: fm.title || '(untitled)',
    role: fm.role || '',
    dependsOn: Array.isArray(fm.dependsOn) ? fm.dependsOn : [],
    scopeFiles: (fm.scope?.files || [])
      .map((f) => f?.path)
      .filter((p) => typeof p === 'string'),
    granularityNote: fm.granularityNote || null,
  };
});

const order = topologicalOrder(tasks);
const dependencyGraph = buildDependencyGraph(tasks);
const parallelizable = computeParallelGroups(tasks, order);

const generatedAt = staticMode ? '<RFC3339>' : new Date().toISOString();
const outPath = join(stagingDir, 'TASK_GRAPH.md');
writeFileSync(
  outPath,
  renderGraphDoc({
    featureId,
    tasks,
    order,
    dependencyGraph,
    parallelizable,
    generatedAt,
  }),
);
console.log(
  `render-task-graph: wrote ${outPath} (${tasks.length} tasks, ${parallelizable.length} parallelizable groups)`,
);

// ──────────────────────────── parsing ─────────────────────────────

function parseFrontmatter(raw, srcPath) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) {
    console.error(`No YAML frontmatter in ${srcPath}`);
    process.exit(1);
  }
  return yaml.parse(m[1]) || {};
}

// ──────────────────────────── topological order ──────────────────

/**
 * Kahn's algorithm. When ties exist (multiple tasks with no remaining deps),
 * sort by taskId ascending so the output is deterministic. Cycles fail loud —
 * task plans should be DAGs.
 */
function topologicalOrder(tasks) {
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const remaining = new Map();
  for (const t of tasks) remaining.set(t.taskId, new Set(t.dependsOn));

  const out = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      const stuck = [...remaining.keys()].sort().join(', ');
      console.error(
        `render-task-graph: dependency cycle detected involving: ${stuck}`,
      );
      process.exit(1);
    }
    for (const id of ready) {
      out.push(id);
      remaining.delete(id);
      for (const [other, deps] of remaining) deps.delete(id);
      void taskById; // (referenced for clarity; not needed at this step)
    }
  }
  return out;
}

function buildDependencyGraph(tasks) {
  const out = {};
  for (const t of tasks) {
    if (t.dependsOn.length > 0) out[t.taskId] = [...t.dependsOn];
  }
  return out;
}

// ──────────────────────────── parallel groups ───────────────────

/**
 * Within each topological layer (tasks whose deps are all satisfied at the
 * same level), find subsets with pairwise disjoint scope.files[].path sets.
 *
 * Greedy: walk the layer in taskId order; place each task into the first
 * existing group that remains disjoint after the merge, else start a new
 * group. Singleton groups are dropped — a parallelizable group must have
 * ≥2 tasks to be useful for the orchestrator.
 */
function computeParallelGroups(tasks, order) {
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const depDepth = new Map();
  for (const id of order) {
    const t = taskById.get(id);
    const max = t.dependsOn.reduce(
      (acc, d) => Math.max(acc, (depDepth.get(d) ?? -1) + 1),
      0,
    );
    depDepth.set(id, max);
  }

  const layers = new Map();
  for (const [id, depth] of depDepth) {
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth).push(id);
  }

  const groups = [];
  for (const ids of layers.values()) {
    const sorted = ids.slice().sort();
    const localGroups = [];
    for (const id of sorted) {
      const t = taskById.get(id);
      const scope = new Set(t.scopeFiles);
      let placed = false;
      for (const group of localGroups) {
        const conflict = group.some((peerId) => {
          const peer = taskById.get(peerId);
          return peer.scopeFiles.some((p) => scope.has(p));
        });
        if (!conflict) {
          group.push(id);
          placed = true;
          break;
        }
      }
      if (!placed) localGroups.push([id]);
    }
    for (const g of localGroups) {
      if (g.length >= 2) groups.push(g);
    }
  }
  return groups;
}

// ──────────────────────────── rendering ──────────────────────────

function renderGraphDoc({
  featureId,
  tasks,
  order,
  dependencyGraph,
  parallelizable,
  generatedAt,
}) {
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const fm = yaml.stringify(
    {
      featureId,
      totalTasks: tasks.length,
      tasksOrder: order,
      dependencyGraph,
      parallelizable,
      generatedAt,
    },
    { lineWidth: 0 },
  );

  const mermaid = renderMermaid({ tasks, taskById, order, parallelizable });
  const granularityTable = renderGranularityTable(tasks);

  const lines = [
    '---',
    fm.trimEnd(),
    '---',
    '',
    `# Task graph — ${featureId}`,
    '',
    `> Auto-generated from per-task TASK_*.md files. Do not edit by hand — re-run \`scripts/render-task-graph.mjs ${featureId}\` after editing tasks.`,
    '',
    '```mermaid',
    mermaid,
    '```',
    '',
  ];

  if (granularityTable) {
    lines.push('## Granularity notes (non-ok)', '', granularityTable, '');
  }

  return lines.join('\n');
}

function renderMermaid({ tasks, taskById, order, parallelizable }) {
  const lines = [
    'graph TD',
    '  classDef parallel fill:#dcfce7,stroke:#10b981,color:#000',
    '  classDef serial fill:#fef3c7,stroke:#f59e0b,color:#000',
    '',
  ];

  const inGroup = new Map();
  parallelizable.forEach((group, idx) => {
    for (const id of group) inGroup.set(id, idx);
  });

  for (const id of order) {
    const t = taskById.get(id);
    const label = sanitize(`${t.taskId} — ${t.title}`);
    const cls = inGroup.has(id) ? 'parallel' : 'serial';
    lines.push(`  ${t.taskId}["${label}"]:::${cls}`);
  }

  if (parallelizable.length > 0) {
    lines.push('');
    parallelizable.forEach((group, idx) => {
      lines.push(`  subgraph P${idx}["parallel group ${idx + 1}"]`);
      lines.push('    direction LR');
      for (const id of group) lines.push(`    ${id}`);
      lines.push('  end');
    });
  }

  if (tasks.some((t) => t.dependsOn.length > 0)) lines.push('');
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      lines.push(`  ${dep} --> ${t.taskId}`);
    }
  }

  return lines.join('\n');
}

function renderGranularityTable(tasks) {
  const flagged = tasks.filter(
    (t) => t.granularityNote && t.granularityNote.verdict !== 'ok',
  );
  if (flagged.length === 0) return '';
  const rows = flagged.map((t) => {
    const v = t.granularityNote || {};
    return `| ${t.taskId} | ${v.verdict || '—'} | ${escapePipe(v.rationale || '')} |`;
  });
  return ['| Task | Verdict | Rationale |', '|---|---|---|', ...rows].join(
    '\n',
  );
}

// ──────────────────────────── utils ───────────────────────────────

/**
 * Sanitize a string for embedding in a mermaid node label. Long titles get
 * truncated; the structured `title` field on the TASK_NN.md frontmatter
 * remains the precise source LLMs read downstream.
 */
function sanitize(s) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '\\"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|');
}
