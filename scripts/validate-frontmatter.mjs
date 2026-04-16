#!/usr/bin/env node
// validate-frontmatter.mjs
// Validates YAML frontmatter in all SKILL.md and agents/*.md files under packages/skills/.
// Node v22 stdlib only — no npm dependencies.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the package root regardless of cwd (works from repo root or packages/skills/).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

// ── Frontmatter parser ────────────────────────────────────────────────────────
// Handles the three shapes found in this package:
//   1. Single-line quoted   description: "..."
//   2. Single-line unquoted description: Some text...
//   3. Block scalar         description: |\n  multi-line...
//
// Returns null if the file does not start with a valid frontmatter block.
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;

  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) return null;

  const raw = content.slice(4, endIndex);
  const result = {};

  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and comment lines.
    if (line.trim() === '' || line.startsWith('#')) {
      i++;
      continue;
    }

    // Top-level key: value
    const keyMatch = line.match(/^([A-Za-z][\w-]*):\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2].trim();

    // Block scalar — `|` or `|-` or `|+`
    if (rest === '|' || rest === '|-' || rest === '|+') {
      i++;
      const blockLines = [];
      while (
        i < lines.length &&
        (lines[i].startsWith('  ') || lines[i] === '')
      ) {
        blockLines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '');
        i++;
      }
      result[key] = blockLines.join('\n').trim();
      continue;
    }

    // Quoted string — strip surrounding `"` or `'`
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      result[key] = rest.slice(1, -1);
      i++;
      continue;
    }

    // Plain / unquoted scalar
    result[key] = rest;
    i++;
  }

  return result;
}

// ── File discovery ────────────────────────────────────────────────────────────
function collectFiles() {
  const files = [];

  // agents/*.md  (direct children only; basename without .md = skill name)
  const agentsDir = join(PKG_ROOT, 'agents');
  for (const entry of readdirSync(agentsDir)) {
    const full = join(agentsDir, entry);
    if (statSync(full).isFile() && entry.endsWith('.md')) {
      files.push({
        path: full,
        nameSource: 'basename',
        expectedName: basename(entry, '.md'),
      });
    }
  }

  // */*/SKILL.md  (two-level: category/skill-name/SKILL.md)
  // Exclude: examples/, node_modules/, agents/, scripts/
  const EXCLUDED = new Set([
    'examples',
    'node_modules',
    'agents',
    'scripts',
    '.claude-plugin',
  ]);
  for (const category of readdirSync(PKG_ROOT)) {
    if (EXCLUDED.has(category)) continue;
    const categoryPath = join(PKG_ROOT, category);
    if (!statSync(categoryPath).isDirectory()) continue;

    for (const skillDir of readdirSync(categoryPath)) {
      if (EXCLUDED.has(skillDir)) continue;
      const skillPath = join(categoryPath, skillDir);
      if (!statSync(skillPath).isDirectory()) continue;

      const skillMd = join(skillPath, 'SKILL.md');
      try {
        statSync(skillMd);
        files.push({
          path: skillMd,
          nameSource: 'parent-dir',
          expectedName: skillDir,
        });
      } catch {
        // No SKILL.md in this directory — skip.
      }
    }
  }

  return files;
}

// ── Validation ────────────────────────────────────────────────────────────────
function validate(file) {
  const { path, expectedName } = file;
  const failures = [];

  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    failures.push({ rule: 1, reason: `Cannot read file: ${err.message}` });
    return failures;
  }

  // Rule 1: must start with --- frontmatter block
  if (!content.startsWith('---\n')) {
    failures.push({ rule: 1, reason: 'File does not start with ---' });
    return failures; // can't parse further
  }
  const hasClosure = content.indexOf('\n---\n', 4) !== -1;
  if (!hasClosure) {
    failures.push({ rule: 1, reason: 'Frontmatter closing --- not found' });
    return failures;
  }

  const fm = parseFrontmatter(content);
  if (fm === null) {
    failures.push({ rule: 1, reason: 'Could not parse frontmatter block' });
    return failures;
  }

  // Rule 2: name — present and non-empty
  if (!fm.name || fm.name.trim() === '') {
    failures.push({ rule: 2, reason: '`name` key is missing or empty' });
  }

  // Rule 3: description — present and non-empty
  if (!fm.description || fm.description.trim() === '') {
    failures.push({ rule: 3, reason: '`description` key is missing or empty' });
  }

  // Rule 4: name value must equal expected name (parent dir or basename)
  if (fm.name && fm.name.trim() !== '' && fm.name.trim() !== expectedName) {
    failures.push({
      rule: 4,
      reason: `\`name\` is "${fm.name.trim()}" but expected "${expectedName}"`,
    });
  }

  // Rule 5: if allowed-tools is present, it must be a non-empty string
  if ('allowed-tools' in fm) {
    if (!fm['allowed-tools'] || fm['allowed-tools'].trim() === '') {
      failures.push({
        rule: 5,
        reason: '`allowed-tools` is present but empty',
      });
    }
  }

  return failures;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const files = collectFiles();
const allFailures = [];

for (const file of files) {
  const failures = validate(file);
  if (failures.length > 0) {
    const rel = relative(PKG_ROOT, file.path);
    for (const { rule, reason } of failures) {
      allFailures.push({ rel, rule, reason });
      console.error(`✗ ${rel}: rule ${rule}: ${reason}`);
    }
  }
}

if (allFailures.length > 0) {
  console.error(
    `\n${allFailures.length} validation error(s) across ${files.length} file(s).`,
  );
  process.exit(1);
}

console.log(`✓ ${files.length} SKILL.md files passed frontmatter validation`);
