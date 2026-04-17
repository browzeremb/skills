#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput } from './_util.mjs';

// Vocabulary of libraries / frameworks / services where training data is
// most likely to lie or drift from the project's actual version. Generic
// language names (typescript, node, python) intentionally omitted — they
// would fire on every prompt and drown the signal.
const DEFAULT_VOCAB = [
  // web frameworks
  'fastify',
  'express',
  'hono',
  'koa',
  'nestjs',
  'nest.js',
  'next',
  'next.js',
  'nextjs',
  'react',
  'vue',
  'svelte',
  'sveltekit',
  'remix',
  'astro',
  'solid.js',
  'solidjs',
  // orm / db
  'drizzle',
  'prisma',
  'kysely',
  'typeorm',
  'sequelize',
  'mongoose',
  'postgres',
  'postgresql',
  'mysql',
  'sqlite',
  'mongodb',
  'redis',
  'neo4j',
  'cypher',
  // queues / bg jobs
  'bullmq',
  'bull',
  'celery',
  'sidekiq',
  'agenda',
  'inngest',
  'trigger.dev',
  // auth
  'better-auth',
  'betterauth',
  'clerk',
  'auth0',
  'nextauth',
  'next-auth',
  'lucia',
  'supabase',
  // ui
  'tailwind',
  'tailwindcss',
  'shadcn',
  'shadcn/ui',
  'radix',
  'radix-ui',
  'chakra',
  'mantine',
  'mui',
  'material-ui',
  // testing
  'vitest',
  'jest',
  'mocha',
  'chai',
  'playwright',
  'cypress',
  'testing-library',
  // build / tooling
  'turborepo',
  'turbo',
  'lerna',
  'nx',
  'rush',
  'vite',
  'esbuild',
  'swc',
  'webpack',
  'rollup',
  'tsup',
  'biome',
  'eslint',
  'prettier',
  // validation
  'zod',
  'yup',
  'joi',
  'valibot',
  'ajv',
  // llm / ai
  'langchain',
  'langfuse',
  'langgraph',
  'llamaindex',
  'ai sdk',
  'openai sdk',
  'anthropic sdk',
  'mcp',
  'model context protocol',
  // payments
  'stripe',
  'paddle',
  'lemon squeezy',
  // infra / deploy
  'vercel',
  'railway',
  'netlify',
  'cloudflare workers',
  'cloudflare',
  'fly.io',
  'render',
  'aws lambda',
  // observability
  'grafana',
  'prometheus',
  'datadog',
  'sentry',
  'opentelemetry',
  'otel',
  // state / data
  'react-query',
  'tanstack query',
  'tanstack',
  'swr',
  'zustand',
  'jotai',
  'redux',
  'mobx',
  'recoil',
  // pkg mgrs (specific, not "npm" alone)
  'pnpm workspaces',
  'yarn workspaces',
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Plan-mode trigger phrases. When the user's prompt contains any of these,
// redirect them to the structured `prd` / `task` workflow skills instead of
// letting Claude Code's native plan mode take over. The native plan mode
// emits a single freeform plan file and `ExitPlanMode`; the workflow skills
// emit structured PRDs + per-task acceptance criteria + verification plans.
// (2026-04-16 retro §2.2 + §3.4.)
const PLAN_TRIGGERS = [
  // English
  /\bbreak (?:this|it|the(?:m|se))? (?:into|down) (?:tasks?|prs?|chunks?)\b/i,
  /\bdecompose (?:this|the) (?:spec|prd|requirements?|feature)\b/i,
  /\bsplit (?:this|the)? ?(?:into|by) prs?\b/i,
  /\bwrite (?:a|the) prd\b/i,
  /\bdraft (?:a|the) (?:prd|requirements? doc|spec)\b/i,
  /\bplan (?:mode|the implementation|out the work)\b/i,
  /\b(?:create|build|generate) a roadmap\b/i,
  // Portuguese
  /\b(?:vamos? )?planejar?\b/i,
  /\b(?:fazer|escrever|criar) um (?:planejamento|plano|prd|roadmap)\b/i,
  /\bplan(?:o|ejamento) para (?:matar|resolver|corrigir)\b/i,
  /\bquebrar (?:em|por|nas?) tarefas?\b/i,
  /\bdividir (?:em|nas?) prs?\b/i,
  /\b(?:transformar|converter) (?:em|num?) (?:prd|tarefas?)\b/i,
];

function main() {
  const input = readHookInput();
  const prompt = (
    input?.prompt ??
    input?.user_prompt ??
    input?.message ??
    ''
  ).toString();

  if (prompt.length < 10) return;
  if (/^\s*\/\w/.test(prompt)) return; // slash commands skip the guard

  // Plan-mode redirect: if the prompt asks for planning/decomposition,
  // route to the workflow skills instead of falling into Claude Code's
  // native plan mode. Returns early so we don't also fire the search
  // suggestion (double-prompting hurts signal).
  const planMatch = PLAN_TRIGGERS.find((re) => re.test(prompt));
  if (planMatch) {
    const message =
      'This prompt asks for planning/decomposition. The Browzer plugin ships two ' +
      'workflow skills that do this with structured output:\n' +
      '  • `Skill(skill: "browzer:prd")` — emits a Product Requirements Document inline ' +
      '(problem, scope, requirements, acceptance criteria, repo invariants).\n' +
      '  • `Skill(skill: "browzer:task")` — decomposes a PRD into ordered, ' +
      'mergeable, PR-sized engineering tasks with per-task verification plans.\n' +
      "Prefer these over Claude Code's native plan mode — they ground in " +
      '`browzer explore`/`search`/`deps`, surface repo invariants from CLAUDE.md, ' +
      'and emit artifacts the next phase (`execute`) consumes directly.';
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: message,
        },
      }),
    );
    return;
  }

  // User-extensible vocab via .browzer/search-triggers.json in cwd
  const cwd = input?.cwd ?? process.cwd();
  const vocab = [...DEFAULT_VOCAB];
  try {
    const extra = JSON.parse(
      readFileSync(join(cwd, '.browzer/search-triggers.json'), 'utf8'),
    );
    if (Array.isArray(extra)) vocab.push(...extra.map(String));
  } catch {}

  const hits = new Set();

  // Vocab match (word boundary for single tokens; substring for multi-token)
  for (const term of vocab) {
    const t = term.toLowerCase();
    if (/[ /.]/.test(t)) {
      if (prompt.toLowerCase().includes(t)) hits.add(term);
    } else {
      const re = new RegExp(`\\b${escapeRe(t)}\\b`, 'i');
      if (re.test(prompt)) hits.add(term);
    }
  }

  // Scoped npm packages: @scope/name
  const scoped = prompt.match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi);
  if (scoped) for (const s of scoped) hits.add(s);

  // Install commands
  const installs = prompt.matchAll(
    /\b(?:npm i(?:nstall)?|pnpm add|yarn add|bun add)\s+([@\w\-/.]+)/gi,
  );
  for (const m of installs) if (m[1]) hits.add(m[1]);

  // Import / require sources (skip relative paths)
  const imports = prompt.matchAll(
    /\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  );
  for (const m of imports) {
    const src = m[1] ?? m[2];
    if (src && !src.startsWith('.') && !src.startsWith('/')) hits.add(src);
  }

  if (hits.size === 0) return;

  const list = [...hits];
  const preview = list
    .slice(0, 6)
    .map((t) => `"${t}"`)
    .join(', ');

  // @-scoped package paths (e.g. @browzer/core, @packages/skills) make poor vector
  // search seeds — the embedding model treats them as noise and produces misleading
  // cosine scores. Strip them from the seed; fall back to just the package name part
  // if the entire hit list is scoped references.
  const nonScoped = list.filter((t) => !t.startsWith('@'));
  const seed = (
    nonScoped.length > 0
      ? nonScoped
      : list.map((t) => t.replace(/^@[^/]+\//, ''))
  ) // @browzer/core → core
    .slice(0, 3)
    .join(' ');

  const scopedStripped =
    list.some((t) => t.startsWith('@')) && nonScoped.length < list.length;

  const text =
    `[Browzer search guard] Detected topic(s) in this prompt: ${preview}.\n` +
    `Before answering or writing code that touches these, run:\n` +
    `  browzer search "${seed} <your refined question>" --json --save /tmp/search.json\n` +
    (scopedStripped
      ? `NOTE: @-scoped package paths were stripped from the search seed — ` +
        `translate them to natural-language concepts when refining the query.\n`
      : '') +
    `The workspace docs index is authoritative for how this project uses these libraries. ` +
    `Your training data may be stale or not match the project's version. ` +
    `If the search returns 0 hits, say so explicitly and proceed with training-data knowledge — ` +
    `do NOT pretend you searched when you didn't. /tmp/search.json is the receipt.\n` +
    `To customize what this guard reacts to in a specific repo, add terms to ` +
    `.browzer/search-triggers.json (array of strings).`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: text,
      },
    }),
  );
}

main();
process.exit(0);
