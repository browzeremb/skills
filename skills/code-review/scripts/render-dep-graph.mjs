#!/usr/bin/env node
/**
 * render-dep-graph.mjs
 *
 * Generates a Mermaid `graph LR` diagram showing the reverse-dependency
 * blast radius for one or more files.
 *
 * Usage:
 *   node render-dep-graph.mjs --files <comma-separated paths> --out <output-path>
 *
 * Exit codes:
 *   0  full success (or partial success with stderr warnings)
 *   2  --out write failure
 *
 * Test shim: set RENDER_DEP_GRAPH_FIXTURE_DIR to a directory containing JSON
 * fixture files. Each fixture is named after the sanitized input path
 * (same transform as the --save arg) with a .json extension. When the env var
 * is set, `browzer deps` is NOT called; the fixture file is read directly.
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_REVERSE_IMPORTERS = 25;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { files: [], out: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--files' && args[i + 1]) {
      result.files = args[++i]
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
    } else if (args[i] === '--out' && args[i + 1]) {
      result.out = args[++i];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path sanitization (for tmp file names)
// ---------------------------------------------------------------------------

function sanitizePath(filePath) {
  return filePath.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// Resolve reverse importers for a single file
// ---------------------------------------------------------------------------

async function getReverseDeps(filePath) {
  const fixtureDir = process.env.RENDER_DEP_GRAPH_FIXTURE_DIR;
  if (fixtureDir) {
    // Test shim: read fixture instead of calling browzer
    const fixturePath = `${fixtureDir}/${sanitizePath(filePath)}.json`;
    try {
      const raw = readFileSync(fixturePath, 'utf8');
      const data = JSON.parse(raw);
      return data.importedBy ?? [];
    } catch (err) {
      process.stderr.write(
        `render-dep-graph: fixture not found for ${filePath}: ${fixturePath}\n`,
      );
      return null;
    }
  }

  const tmpPath = `/tmp/render-dep-${sanitizePath(filePath)}.json`;
  try {
    await execFileAsync('browzer', [
      'deps',
      filePath,
      '--reverse',
      '--json',
      '--save',
      tmpPath,
    ]);
    const raw = readFileSync(tmpPath, 'utf8');
    const data = JSON.parse(raw);
    return data.importedBy ?? [];
  } catch (err) {
    process.stderr.write(
      `render-dep-graph: browzer deps failed for ${filePath}: ${err.message}\n`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mermaid rendering
// ---------------------------------------------------------------------------

function renderMermaid(entries) {
  const hasStubs = entries.some((e) => e.stub);
  const lines = ['graph LR'];
  // Emit classDef before nodes so all Mermaid renderers (GitHub, MermaidJS
  // live editor, VS Code) can resolve the class before it is referenced.
  // camelCase identifier is universally compatible (kebab-case breaks some
  // renderers that parse identifiers as barewords).
  if (hasStubs) {
    lines.push(
      '  classDef noDepsCoverage stroke:#999,stroke-dasharray:4 4,fill:#fafafa;',
    );
  }
  for (const { index, filePath, importedBy, stub } of entries) {
    const nodeId = `F${index}`;
    if (stub) {
      // FR-12 (R-28): files for which deps resolution failed get a stub node
      // so they are visible in the graph rather than silently absent.
      lines.push(
        `  ${nodeId}["${filePath}\\n[no-deps-coverage]"]:::noDepsCoverage`,
      );
      continue;
    }
    lines.push(`  ${nodeId}["${filePath}"]`);
    const capped = importedBy.slice(0, MAX_REVERSE_IMPORTERS);
    const overflow = importedBy.length - capped.length;
    for (let j = 0; j < capped.length; j++) {
      lines.push(`  ${nodeId} --> ${nodeId}_${j}["${capped[j]}"]`);
    }
    if (overflow > 0) {
      lines.push(`  ${nodeId} --> ${nodeId}_more["... (+${overflow} more)"]`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { files, out } = parseArgs(process.argv);

  if (!files.length || !out) {
    process.stderr.write(
      'Usage: render-dep-graph.mjs --files <comma-separated paths> --out <output-path>\n',
    );
    process.exit(1);
  }

  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const importedBy = await getReverseDeps(filePath);
    if (importedBy === null) {
      // FR-12 (R-28): emit a stub node so non-indexed files are visible in the
      // graph rather than silently absent. The :::no-deps-coverage class marker
      // lets downstream consumers (e.g. Mermaid themes) style stubs differently.
      process.stderr.write(
        `render-dep-graph: stub node for ${filePath} (deps resolution failed)\n`,
      );
      entries.push({ index: i, filePath, importedBy: [], stub: true });
      continue;
    }
    entries.push({ index: i, filePath, importedBy });
  }

  const mermaid = renderMermaid(entries);

  try {
    writeFileSync(out, mermaid, 'utf8');
  } catch (err) {
    process.stderr.write(
      `render-dep-graph: failed to write output file ${out}: ${err.message}\n`,
    );
    process.exit(2);
  }
}

main();
