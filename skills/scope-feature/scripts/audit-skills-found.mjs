#!/usr/bin/env node
/**
 * audit-skills-found.mjs — post-write validator for scope-feature.
 *
 * Reads docs/browzer/<featureId>/staging/EXPLORATION.md and flags the
 * "all-empty skillsFound across every domain" matrix as a probable
 * contract violation rather than a valid zero-result signal.
 *
 * Heuristic:
 *   - findSkillsRan must be true (otherwise the scoper bypassed the
 *     non-optional contract; exit 2).
 *   - When findSkillsRan == true AND every domain reports an empty or
 *     absent skillsFound[], assume `find-skills` parsing failed or the
 *     marketplace lookup degraded. Exit 1 with a structured error so
 *     the orchestrator can surface the gap.
 *   - Otherwise exit 0.
 *
 * Usage:
 *   node audit-skills-found.mjs <featureId>
 *
 * Uses the `yaml` package (workspace dep, already required by sibling
 * scripts) to parse frontmatter — handles both the flow-sequence form
 * (skillsFound: []) and the implicit-null form (skillsFound:) correctly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { argv, exit, stderr } from 'node:process';
import yaml from 'yaml';

const featureId = argv[2];
if (!featureId) {
  stderr.write('audit-skills-found: missing <featureId> argument\n');
  exit(2);
}

const explorationPath = `docs/browzer/${featureId}/staging/EXPLORATION.md`;
if (!existsSync(explorationPath)) {
  stderr.write(`audit-skills-found: ${explorationPath} not found\n`);
  exit(2);
}

const body = readFileSync(explorationPath, 'utf8');
const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  stderr.write('audit-skills-found: EXPLORATION.md has no YAML frontmatter\n');
  exit(2);
}

let fm;
try {
  fm = yaml.parse(fmMatch[1]);
} catch (err) {
  stderr.write(
    `audit-skills-found: failed to parse YAML frontmatter: ${err.message}\n`,
  );
  exit(2);
}

if (!fm.findSkillsRan) {
  stderr.write(
    'audit-skills-found: findSkillsRan != true — scoper bypassed non-optional contract.\n',
  );
  exit(2);
}

const domains = fm.domains ?? [];
if (domains.length === 0) {
  stderr.write('audit-skills-found: no domains found in EXPLORATION.md\n');
  exit(2);
}

const domainNames = domains.map((d) => d.name ?? '(unnamed)');

// A domain is empty when skillsFound is absent, null, or a zero-length array.
// yaml.parse maps both `skillsFound:` (implicit-null) and `skillsFound: []`
// (flow-sequence) correctly — no regex required.
const emptyCount = domains.filter(
  (d) => !d.skillsFound || d.skillsFound.length === 0,
).length;

if (emptyCount === domains.length && domains.length >= 2) {
  stderr.write(
    `audit-skills-found: ALL ${domains.length} domains report skillsFound: [] — probable find-skills parsing/marketplace failure.\n` +
      `  Domains: ${domainNames.join(', ')}\n` +
      `  Required action: re-probe ~/.claude/skills/ and .claude/plugins/**/skills/ directly, then patch EXPLORATION.md with the fallback resolution + record assumptions[] entry per agents/scoper.md §Empty-everywhere defence.\n`,
  );
  exit(1);
}

process.stdout.write(
  `audit-skills-found: ok — ${domains.length - emptyCount}/${domains.length} domains carry skillsFound entries.\n`,
);
exit(0);
