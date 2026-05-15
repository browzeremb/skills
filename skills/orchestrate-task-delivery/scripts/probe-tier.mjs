#!/usr/bin/env node

/**
 * probe-tier.mjs — composes a structured prompt for the haiku tier-classifier
 * sub-agent and persists its return value into staging/CONFIG.md.
 *
 * The script does NOT spawn the sub-agent itself — sub-agent dispatch is the
 * orchestrator's responsibility (it owns the `Agent` tool). The orchestrator
 * runs this script in two modes:
 *
 *   1. `--render` — read the BRIEF (or operator $ARGUMENTS when brainstorming
 *      was skipped) and the pre-computed `browzer deps --reverse` JSON
 *      receipts; emit the dispatch prompt body on stdout. The orchestrator
 *      pipes this into its `Agent(subagent_type: "general-purpose",
 *      model: haiku-4-5, effort: low)` call.
 *
 *   2. `--persist` — given the sub-agent's structured return value on stdin
 *      (or via `--input <path>`), validate the shape and write
 *      staging/CONFIG.md atomically.
 *
 * The two-step split keeps the script side-effect-free in `--render` mode
 * (deterministic, testable) and atomic in `--persist` mode (single
 * filesystem write).
 *
 * Usage:
 *   node probe-tier.mjs <featureId> --render
 *   node probe-tier.mjs <featureId> --persist [--input /tmp/probe-result.json]
 *
 * Exit codes:
 *   0   success (prompt emitted on stdout, or CONFIG.md updated)
 *   2   bad usage
 *   3   malformed sub-agent return (shape violation)
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function die(msg, code = 1) {
  process.stderr.write(`probe-tier: ${msg}\n`);
  process.exit(code);
}

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function atomicWrite(path, content) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function parseFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

function getFmKv(fm, key) {
  const re = new RegExp(`^${key}:\\s*"?(.+?)"?$`, 'm');
  return (fm.match(re) || [])[1] ?? null;
}

function setFmKv(fm, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  const v = renderScalar(value);
  if (re.test(fm)) return fm.replace(re, `${key}: ${v}`);
  return `${fm}\n${key}: ${v}`;
}

function renderScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (/^[A-Za-z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function readBrief(stagingDir) {
  const briefPath = join(stagingDir, 'planning', 'BRIEF.md');
  if (fileExists(briefPath)) return readFileSync(briefPath, 'utf8');
  // express-fast-path: no BRIEF — orchestrator passes $ARGUMENTS via --request
  return null;
}

function readDepsReceipts() {
  // Convention: orchestrator pre-computes `browzer deps --reverse <candidate>`
  // for every candidate path and saves to /tmp/probe-deps-<i>.json. The script
  // collects all of them.
  const out = [];
  try {
    const files = execSync('ls /tmp/probe-deps-*.json 2>/dev/null || true', {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    for (const f of files) {
      try {
        out.push(JSON.parse(readFileSync(f, 'utf8')));
      } catch {
        /* skip malformed receipts */
      }
    }
  } catch {
    /* no receipts */
  }
  return out;
}

function renderPrompt(featureId, brief, depsReceipts, requestOverride) {
  const briefBody = brief
    ? `\n## BRIEF.md\n\n\`\`\`markdown\n${brief}\n\`\`\`\n`
    : requestOverride
      ? `\n## Operator request\n\n${requestOverride}\n`
      : `\n## (no BRIEF found, no operator request supplied)\n`;

  const depsBody = depsReceipts.length
    ? `\n## browzer deps --reverse — pre-computed receipts\n\n\`\`\`json\n${JSON.stringify(depsReceipts, null, 2)}\n\`\`\`\n`
    : '\n## browzer deps --reverse — (no receipts pre-computed)\n';

  return [
    `# Tier classification probe — feature ${featureId}`,
    '',
    'You are a tier-classifier. Read the BRIEF and the `browzer deps --reverse`',
    'receipts below and pick ONE of `{express, standard, full}` per the rubric.',
    '',
    '## Rubric',
    '',
    '| Signal | express | standard | full |',
    '|---|---|---|---|',
    '| Files touched (estimate) | ≤3 | 4–10 | >10 |',
    '| Blast radius (reverse-importers per file) | ≤5 | 5–15 | >15 OR critical import graph |',
    '| Public surfaces touched | ≤1 | ≤2 | >2 |',
    '| Domains crossed | 1 | 1–2 | ≥3 OR cross-cutting concern |',
    '| BRIEF clarity (persona + success + scope) | all 3 present | 1 missing | ≥2 missing OR brainstorm requested |',
    '| Sensitive path hit (per references/sensitive-paths.md) | none | 1 hit | hit in critical path |',
    '| Risk keywords | "fix typo", "rename", "add log", "remove unused" | "feature", "refactor" | "migrate", "rewrite", "breaking change" |',
    '',
    '**Escalation rule**: pick the highest tier any signal hits. Any `full`',
    'signal forces `full`; any `standard` signal upgrades `express → standard`.',
    '',
    '## Output format',
    '',
    'Return STRICT JSON matching this shape — no prose, no markdown fence:',
    '',
    '```json',
    '{',
    '  "tier": "express | standard | full",',
    '  "rationale": "<one sentence>",',
    '  "candidateFiles": ["<repo-relative path>", "..."],',
    '  "expectedAC": [',
    '    { "id": "T-AC-01", "description": "<verifiable criterion>" }',
    '  ]',
    '}',
    '```',
    '',
    'Constraints:',
    '- `candidateFiles[]` lists files you expect the work to touch (1–10 paths).',
    '- `expectedAC[]` lists 1–3 verifiable acceptance criteria for the feature.',
    '- No nested objects beyond what is shown.',
    briefBody,
    depsBody,
  ].join('\n');
}

function validateProbeOutput(obj) {
  if (!obj || typeof obj !== 'object') return 'expected object';
  if (!['express', 'standard', 'full'].includes(obj.tier))
    return `tier must be one of express|standard|full (got ${obj.tier})`;
  if (typeof obj.rationale !== 'string' || obj.rationale.trim() === '')
    return 'rationale must be a non-empty string';
  if (!Array.isArray(obj.candidateFiles))
    return 'candidateFiles must be an array';
  if (!Array.isArray(obj.expectedAC) || obj.expectedAC.length === 0)
    return 'expectedAC must be a non-empty array';
  for (const ac of obj.expectedAC) {
    if (!ac || typeof ac !== 'object')
      return 'expectedAC[].entry must be an object';
    if (typeof ac.id !== 'string') return 'expectedAC[].id must be string';
    if (typeof ac.description !== 'string')
      return 'expectedAC[].description must be string';
  }
  return null;
}

function persistConfig(stagingDir, probe) {
  const configPath = join(stagingDir, 'CONFIG.md');
  if (!fileExists(configPath))
    die(
      `CONFIG.md missing at ${configPath}; orchestrator INIT must run first`,
      2,
    );

  const text = readFileSync(configPath, 'utf8');
  const fm = parseFm(text);
  if (!fm) die('CONFIG.md has no frontmatter', 2);

  let newFm = setFmKv(fm, 'tier', probe.tier);
  newFm = setFmKv(newFm, 'tierRationale', probe.rationale);
  // Embed candidateFiles and expectedAC as one-line YAML arrays so the
  // round-trip stays predictable. Downstream inline-writes parse this.
  newFm = setFmKv(
    newFm,
    'tierCandidateFiles',
    `[${probe.candidateFiles.map((p) => JSON.stringify(p)).join(', ')}]`,
  );
  // expectedAC is multi-line; render as a block and append.
  const acBlock = ['tierExpectedAC:'];
  for (const ac of probe.expectedAC) {
    acBlock.push(`  - id: ${ac.id}`);
    acBlock.push(`    description: ${JSON.stringify(ac.description)}`);
  }
  // Strip any prior tierExpectedAC block before re-appending
  newFm = newFm.replace(
    /^tierExpectedAC:\s*\n(?:\s+- [\s\S]*?(?=^\S|z))?/m,
    '',
  );
  newFm = `${newFm.trim()}\n${acBlock.join('\n')}\n`;

  const body = text.replace(/^---\n[\s\S]*?\n---/, '').trimStart();
  const out = `---\n${newFm}---\n\n${body}`;
  atomicWrite(configPath, out);
}

function main() {
  const args = process.argv.slice(2);
  const featureId = args.find((a) => /^feat-\d{8}-[a-z0-9-]+$/.test(a));
  if (!featureId)
    die(
      'usage: probe-tier <featureId> --render | --persist [--input <path>] [--request "..."]',
      2,
    );

  const mode = args.includes('--render')
    ? 'render'
    : args.includes('--persist')
      ? 'persist'
      : null;
  if (!mode) die('mode required: --render | --persist', 2);

  const featDir = resolve('docs', 'browzer', featureId);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ not found at ${stagingDir}; orchestrator INIT must run first`,
      2,
    );

  if (mode === 'render') {
    const requestIdx = args.indexOf('--request');
    const requestOverride =
      requestIdx >= 0 && args[requestIdx + 1] ? args[requestIdx + 1] : null;
    const brief = readBrief(stagingDir);
    const deps = readDepsReceipts();
    process.stdout.write(renderPrompt(featureId, brief, deps, requestOverride));
    process.exit(0);
  }

  // persist mode
  const inputIdx = args.indexOf('--input');
  const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : null;
  let raw = '';
  if (inputPath) {
    if (!fileExists(inputPath)) die(`--input file not found: ${inputPath}`, 2);
    raw = readFileSync(inputPath, 'utf8');
  } else {
    raw = readFileSync(0, 'utf8'); // stdin
  }
  raw = raw.trim();
  if (!raw) die('persist mode requires JSON input on stdin or via --input', 2);

  // Allow a fenced ```json … ``` block in case the sub-agent over-decorates.
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const payload = fenced ? fenced[1] : raw;

  let probe;
  try {
    probe = JSON.parse(payload);
  } catch (err) {
    die(`failed to parse JSON: ${err.message}`, 3);
  }
  const err = validateProbeOutput(probe);
  if (err) die(`probe shape violation: ${err}`, 3);

  persistConfig(stagingDir, probe);
  process.stdout.write(
    `probe-tier: persisted tier=${probe.tier} into ${join(stagingDir, 'CONFIG.md')}\n`,
  );
  process.exit(0);
}

main();
