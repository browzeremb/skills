#!/usr/bin/env node
/**
 * expand-task-acs.mjs — expand a slim TASK_NN.md frontmatter into a
 * self-contained acceptance-criteria block by resolving each
 * `bindsTo[].acId` against the feature's PRD.md.
 *
 * Slim frontmatter ships AC pointers but omits the verbatim AC text to
 * keep the task file small for token-economy reasons:
 *
 *   acceptanceCriteria:
 *     - id: <task-ac-id>
 *       bindsTo:
 *         - acId: <prd-ac-id>
 *           frId: <prd-fr-id>
 *
 * Legacy frontmatter inlines `acText` (and optional `frText`) verbatim;
 * execute-task continues to honour those untouched. This script detects
 * which mode is in play and:
 *   - legacy (any `bindsTo[].acText` non-empty) -> echoes the input.
 *   - slim                                       -> rewrites each
 *     `bindsTo[]` row with `acText` / `frText` resolved from PRD.md.
 *
 * Usage:
 *   node expand-task-acs.mjs <TASK_NN.md path>
 *
 * Exit:
 *   0 — printed expanded file body to stdout (or unchanged on legacy).
 *   2 — PRD_NOT_FOUND (or usage / parse error).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

const [, , rawPath] = process.argv;
if (!rawPath) {
  process.stderr.write('Usage: expand-task-acs.mjs <TASK_NN.md>\n');
  process.exit(2);
}
const taskPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);

if (!existsSync(taskPath)) {
  process.stderr.write(`expand-task-acs: file not found: ${taskPath}\n`);
  process.exit(2);
}

const raw = readFileSync(taskPath, 'utf8');
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
if (!fmMatch) {
  process.stderr.write(`expand-task-acs: no YAML frontmatter in ${taskPath}\n`);
  process.exit(2);
}
const [, fmText, body] = fmMatch;

let fm;
try {
  fm = yamlParse(fmText);
} catch (e) {
  process.stderr.write(`expand-task-acs: YAML parse error: ${e.message}\n`);
  process.exit(2);
}

const acs = fm?.task?.acceptanceCriteria ?? fm?.acceptanceCriteria ?? [];
if (!Array.isArray(acs) || acs.length === 0) {
  // Nothing to expand — emit unchanged.
  process.stdout.write(raw);
  process.exit(0);
}

// Legacy detection: any bindsTo entry already carrying non-empty acText.
const isLegacy = acs.some((ac) =>
  Array.isArray(ac?.bindsTo)
    ? ac.bindsTo.some(
        (b) => typeof b?.acText === 'string' && b.acText.trim().length > 0,
      )
    : false,
);
if (isLegacy) {
  process.stdout.write(raw);
  process.exit(0);
}

// Slim path: locate PRD.md.
const prdPath = findPrdMd(taskPath);
if (!prdPath) {
  process.stderr.write(
    'expand-task-acs: PRD_NOT_FOUND — no PRD.md reachable from ' +
      `${taskPath}\n`,
  );
  process.exit(2);
}

const prdRaw = readFileSync(prdPath, 'utf8');
const prdFmMatch = prdRaw.match(/^---\n([\s\S]*?)\n---/);
if (!prdFmMatch) {
  process.stderr.write(
    `expand-task-acs: PRD.md has no frontmatter: ${prdPath}\n`,
  );
  process.exit(2);
}
let prdFm;
try {
  prdFm = yamlParse(prdFmMatch[1]);
} catch (e) {
  process.stderr.write(`expand-task-acs: PRD YAML parse error: ${e.message}\n`);
  process.exit(2);
}

const prdAcs = indexById(prdFm?.acceptanceCriteria ?? []);
const prdFrs = indexById(prdFm?.functionalRequirements ?? []);

// Expand each bindsTo entry.
let touched = 0;
for (const ac of acs) {
  if (!Array.isArray(ac?.bindsTo)) continue;
  for (const bind of ac.bindsTo) {
    if (bind && typeof bind === 'object') {
      if (bind.acId && !bind.acText) {
        const src = prdAcs.get(bind.acId);
        if (src !== undefined) {
          if ('text' in src && src.text !== undefined && src.text !== null) {
            if (src.text === '') {
              process.stderr.write(
                `expand-task-acs: warning — PRD AC "${bind.acId}" has empty text; ` +
                  'expansion will include an empty acText\n',
              );
            }
            bind.acText = src.text;
            touched += 1;
          }
        }
      }
      if (bind.frId && !bind.frText) {
        const src = prdFrs.get(bind.frId);
        if (src !== undefined) {
          if ('text' in src && src.text !== undefined && src.text !== null) {
            if (src.text === '') {
              process.stderr.write(
                `expand-task-acs: warning — PRD FR "${bind.frId}" has empty text; ` +
                  'expansion will include an empty frText\n',
              );
            }
            bind.frText = src.text;
            touched += 1;
          }
        }
      }
    }
  }
}

if (touched === 0) {
  process.stdout.write(raw);
  process.exit(0);
}

const out = ['---', yamlStringify(fm).trimEnd(), '---', '', body].join('\n');
process.stdout.write(out);
process.exit(0);

// ---------- helpers ----------

function findPrdMd(startPath) {
  const sibling = resolve(dirname(startPath), 'PRD.md');
  return existsSync(sibling) ? sibling : null;
}

function indexById(arr) {
  const out = new Map();
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (item && typeof item === 'object' && item.id) {
      out.set(item.id, item);
    }
  }
  return out;
}
