#!/usr/bin/env node
// render-deps.mjs — turn a `browzer deps --json` document into a Mermaid
// flowchart so the operator can see the blast radius at a glance instead of
// reading 50 paths in a chat message.
//
// Why this exists:
//   `browzer deps` already emits structured JSON ({file, imports[], importedBy[]}).
//   The dependency-graph skill currently relays the JSON path back to the
//   operator and stops there. Mermaid is text-based, ships in every Markdown
//   renderer (GitHub, VS Code preview, Claude Code chat), and matches the
//   Anthropic Skill docs' "generate visual output" guidance: the agent
//   shouldn't redraw a graph from tokens — a script should produce the
//   diagram once, deterministically.
//
// Usage:
//   node scripts/render-deps.mjs --input /tmp/deps.json [--output /tmp/deps.mmd]
//   node scripts/render-deps.mjs /tmp/deps.json                 (positional alias)
//
// Output:
//   - When --output is set: writes the Mermaid source to that path and prints
//     `render-deps: wrote <path> (<N> nodes, <M> edges)` to stdout.
//   - When --output is omitted: prints the Mermaid source to stdout.
//
// Exit codes: 0 success, 1 usage error, 2 IO/parse error.

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

function parseArgs(raw) {
  const out = { input: null, output: null };
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--input') out.input = raw[++i];
    else if (a === '--output') out.output = raw[++i];
    else pos.push(a);
  }
  if (!out.input && pos[0]) out.input = pos[0];
  if (!out.output && pos[1]) out.output = pos[1];
  return out;
}

const args = parseArgs(argv.slice(2));
if (!args.input) {
  stderr.write(
    'usage: render-deps.mjs --input <deps.json> [--output <deps.mmd>]\n',
  );
  exit(1);
}

let doc;
try {
  doc = JSON.parse(readFileSync(args.input, 'utf8'));
} catch (err) {
  stderr.write(`read/parse failed: ${args.input}: ${err.message}\n`);
  exit(2);
}

const center = doc.file;
if (!center || typeof center !== 'string') {
  stderr.write(`invalid deps document: missing "file"\n`);
  exit(2);
}
const imports = Array.isArray(doc.imports) ? doc.imports : [];
const importedBy = Array.isArray(doc.importedBy) ? doc.importedBy : [];

// Mermaid node ids must match [A-Za-z0-9_]; the path label goes in [].
let nextId = 0;
const ids = new Map();
function id(path) {
  if (!ids.has(path)) ids.set(path, `n${nextId++}`);
  return ids.get(path);
}

const lines = ['graph LR'];
// Center node — emphasised so the eye lands on the file under analysis.
lines.push(`  ${id(center)}["**${center}**"]:::center`);

// Emit each unique path as a node line ONCE. A path can appear in both
// imports[] and importedBy[] (cycle) or twice within one list (the CLI
// occasionally returns duplicates when an entry is reachable via multiple
// import statements) — duplicating the node line still parses but clutters
// the diagram and inflates the node count.
const declared = new Set([center]);
for (const dep of [...imports, ...importedBy]) {
  if (declared.has(dep)) continue;
  declared.add(dep);
  lines.push(`  ${id(dep)}["${dep}"]`);
}

// Forward edges (file imports …) — also dedupe per direction so a duplicated
// entry in imports[] doesn't draw the same arrow twice.
const seenForward = new Set();
for (const dep of imports) {
  if (seenForward.has(dep)) continue;
  seenForward.add(dep);
  lines.push(`  ${id(center)} --> ${id(dep)}`);
}
const seenReverse = new Set();
for (const dep of importedBy) {
  if (seenReverse.has(dep)) continue;
  seenReverse.add(dep);
  lines.push(`  ${id(dep)} --> ${id(center)}`);
}

lines.push('  classDef center fill:#fde68a,stroke:#92400e,stroke-width:2px;');

const totalNodes = ids.size;
const totalEdges = seenForward.size + seenReverse.size;
const mmd = lines.join('\n') + '\n';

if (args.output) {
  try {
    writeFileSync(args.output, mmd);
  } catch (err) {
    stderr.write(`write failed: ${args.output}: ${err.message}\n`);
    exit(2);
  }
  stdout.write(
    `render-deps: wrote ${args.output} (${totalNodes} nodes, ${totalEdges} edges)\n`,
  );
} else {
  stdout.write(mmd);
}
