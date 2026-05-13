#!/usr/bin/env node
/**
 * render-user-stories.mjs — Generate USER_STORIES.md from PRD.md frontmatter.
 *
 * Usage:
 *   node scripts/render-user-stories.mjs <path-to-PRD.md>
 *
 * Output:
 *   <same-dir-as-input>/USER_STORIES.md
 *
 * Reads `userStories.diagramType` and `userStories.stories[]` from frontmatter
 * and produces a mermaid diagram + binding tables. Mermaid syntax is generated
 * by construction — the LLM never authors raw mermaid.
 *
 * Supports diagramType: journey | sequence | state | mindmap.
 *
 * Dependency: `yaml` (declared in packages/skills/package.json).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import yaml from 'yaml';

// ───────────────────────────── entry ─────────────────────────────

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error('Usage: render-user-stories.mjs <path-to-PRD.md>');
  process.exit(1);
}

const raw = readFileSync(inputPath, 'utf8');
const fm = parseFrontmatter(raw, inputPath);
const us = fm.userStories;

if (!us?.stories?.length) {
  console.error(`No userStories.stories[] in ${inputPath}`);
  process.exit(1);
}

const renderers = { journey, sequence, state, mindmap };
const renderer = renderers[us.diagramType] || journey;
const mermaid = renderer(us, fm);

const outPath = join(dirname(inputPath), 'USER_STORIES.md');
const body = compose({ fm, mermaid, prdName: basename(inputPath) });
writeFileSync(outPath, body);

console.log(`render-user-stories: wrote ${outPath}`);

// ──────────────────────────── frontmatter ─────────────────────────

function parseFrontmatter(raw, srcPath) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) {
    console.error(`No YAML frontmatter in ${srcPath}`);
    process.exit(1);
  }
  return yaml.parse(m[1]);
}

// ──────────────────────────── compose ─────────────────────────────

function compose({ fm, mermaid, prdName }) {
  const us = fm.userStories;
  const title = us.diagramTitle || fm.title || fm.featureId;
  const personasById = new Map((fm.personas || []).map((p) => [p.id, p]));

  const storiesList = us.stories.map((s) => s.id).join(', ');
  const personasList = unique(us.stories.map((s) => s.persona))
    .map((pid) => `${pid} (${shortDesc(personasById.get(pid))})`)
    .join(', ');
  const acsList =
    unique(us.stories.flatMap((s) => s.bindsAcceptance || [])).join(', ') ||
    '(none)';

  const storyTable = renderStoryTable(us.stories);
  const stepTable =
    us.diagramType === 'journey' ? renderStepTable(us.stories) : '';

  return [
    `# User Stories — ${fm.featureId}`,
    ``,
    `> Auto-generated from \`${prdName}\` userStories[]. Edit the source, not this file.`,
    ``,
    `**Title**: ${title}  `,
    `**Stories**: ${storiesList}  `,
    `**Personas**: ${personasList}  `,
    `**Bound ACs**: ${acsList}`,
    ``,
    '```mermaid',
    mermaid,
    '```',
    ``,
    `## Story ↔ AC binding`,
    ``,
    storyTable,
    ...(stepTable ? [``, `## Journey step ↔ Story`, ``, stepTable] : []),
    ``,
  ].join('\n');
}

function renderStoryTable(stories) {
  // Tables are the structured handoff for downstream LLM consumers
  // (finalize-feature, future agents). Do not truncate `wants` —
  // information loss in the handoff degrades downstream precision.
  // Markdown tables wrap visually in GitHub/VS Code renderers, so width
  // is a non-issue for humans.
  const rows = stories.map((s) => {
    const wants = s.wants || '';
    const acs = (s.bindsAcceptance || []).join(', ') || '—';
    return `| ${s.id} | ${s.persona} | ${escapePipe(wants)} | ${acs} |`;
  });
  return [
    `| Story | Persona | Wants | ACs |`,
    `|---|---|---|---|`,
    ...rows,
  ].join('\n');
}

function renderStepTable(stories) {
  // Same rationale as renderStoryTable: do not truncate. The step text
  // here is the canonical structured form for downstream consumers; the
  // mermaid block above already has a sanitized/abbreviated view for
  // visual rendering.
  const rows = [];
  for (const s of stories) {
    for (const step of s.journeySteps || []) {
      const text = step.step || '';
      const sentiment = step.sentiment ?? '—';
      const actors = (step.actors || []).join(', ') || '—';
      rows.push(`| ${escapePipe(text)} | ${s.id} | ${sentiment} | ${actors} |`);
    }
  }
  if (!rows.length) return '';
  return [
    `| Step | Story | Sentiment | Actors |`,
    `|---|---|---|---|`,
    ...rows,
  ].join('\n');
}

// ──────────────────────────── renderers ───────────────────────────

/**
 * journey — Linear user flow. One mermaid `section` per story.
 * If a story has journeySteps, each step becomes a row with sentiment + actors.
 * Otherwise, fall back to a single step derived from `wants`.
 */
function journey(us, fm) {
  const title = us.diagramTitle || fm.title || fm.featureId;
  const lines = [`journey`, `    title ${sanitize(title)}`];
  for (const s of us.stories) {
    lines.push(`    section ${sanitize(`${s.id} — ${s.wants || ''}`)}`);
    const steps = s.journeySteps?.length
      ? s.journeySteps
      : [{ step: s.wants, sentiment: 3, actors: [s.persona] }];
    for (const step of steps) {
      const text = sanitize(step.step || '(unnamed)');
      const sentiment = step.sentiment ?? 3;
      const actors = (step.actors?.length ? step.actors : [s.persona]).join(
        ', ',
      );
      lines.push(`      ${text}: ${sentiment}: ${actors}`);
    }
  }
  return lines.join('\n');
}

/**
 * sequence — Multi-actor interactions. Each persona becomes a participant;
 * each story is a request/response pair against a generic `System` actor.
 */
function sequence(us, fm) {
  const personasInUse = unique(us.stories.map((s) => s.persona));
  const personasById = new Map((fm.personas || []).map((p) => [p.id, p]));
  const lines = [`sequenceDiagram`];
  for (const pid of personasInUse) {
    // Sequence participant labels render alongside the lifeline; long
    // labels distort the diagram. Cap at 30 chars — visual context only.
    const label = shortDesc(personasById.get(pid), 30) || pid;
    lines.push(`    participant ${pid} as ${sanitize(label)}`);
  }
  lines.push(`    participant System`);
  for (const s of us.stories) {
    lines.push(`    ${s.persona}->>+System: ${sanitize(s.wants || s.id)}`);
    lines.push(
      `    System-->>-${s.persona}: ${sanitize(s.benefit || 'delivered')}`,
    );
  }
  return lines.join('\n');
}

/**
 * state — Linear state machine where each story is a state. Useful for
 * feature flows with clear progression. Dashes in IDs are replaced with
 * underscores because mermaid stateDiagram-v2 disallows dashes in state names.
 */
function state(us) {
  const lines = [`stateDiagram-v2`, `    [*] --> Start`];
  let prev = 'Start';
  for (const s of us.stories) {
    const node = s.id.replace(/-/g, '_');
    lines.push(`    ${prev} --> ${node}: ${sanitize(s.wants || '')}`);
    prev = node;
  }
  lines.push(`    ${prev} --> [*]`);
  return lines.join('\n');
}

/**
 * mindmap — Hierarchical: feature → personas → stories.
 * Useful for capability decomposition across multiple personas.
 */
function mindmap(us, fm) {
  const personasById = new Map((fm.personas || []).map((p) => [p.id, p]));
  const byPersona = new Map();
  for (const s of us.stories) {
    if (!byPersona.has(s.persona)) byPersona.set(s.persona, []);
    byPersona.get(s.persona).push(s);
  }
  const title = us.diagramTitle || fm.title || fm.featureId;
  const lines = [`mindmap`, `  root((${sanitize(title)}))`];
  for (const [pid, stories] of byPersona) {
    // Mindmap nodes accept slightly longer labels than sequence
    // participants; cap at 80 for legibility without overflowing.
    const plabel = shortDesc(personasById.get(pid), 80) || pid;
    lines.push(`    ${pid}: ${sanitize(plabel)}`);
    for (const s of stories) {
      lines.push(`      ${s.id}: ${sanitize(s.wants || '')}`);
    }
  }
  return lines.join('\n');
}

// ──────────────────────────── utils ───────────────────────────────

/**
 * Sanitize a string for embedding in mermaid syntax.
 * - Collapse newlines and runs of whitespace.
 * - Replace colons (which separate mermaid journey/sequence fields).
 * - Strip angle brackets (some mermaid parsers misinterpret them).
 * - Truncate to 80 chars to keep diagrams readable.
 */
function sanitize(s) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/:/g, ' —')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

function unique(arr) {
  return Array.from(new Set(arr));
}

/**
 * Return the first line of a persona's description.
 *
 * @param {object} persona — persona object from PRD frontmatter
 * @param {number} [max] — optional character cap; when provided, truncates
 *   with an ellipsis. The header gloss in compose() omits `max` to preserve
 *   full information for downstream LLM consumers; mermaid renderers pass a
 *   tight cap because diagram readability degrades past ~30–80 chars.
 */
function shortDesc(persona, max) {
  if (!persona) return '';
  const first = persona.description?.split('\n')[0] || persona.id || '';
  if (max != null && first.length > max) {
    return `${first.slice(0, max - 1)}…`;
  }
  return first;
}
