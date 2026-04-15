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
  'fastify', 'express', 'hono', 'koa', 'nestjs', 'nest.js',
  'next', 'next.js', 'nextjs', 'react', 'vue', 'svelte', 'sveltekit', 'remix', 'astro', 'solid.js', 'solidjs',
  // orm / db
  'drizzle', 'prisma', 'kysely', 'typeorm', 'sequelize', 'mongoose',
  'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'neo4j', 'cypher',
  // queues / bg jobs
  'bullmq', 'bull', 'celery', 'sidekiq', 'agenda', 'inngest', 'trigger.dev',
  // auth
  'better-auth', 'betterauth', 'clerk', 'auth0', 'nextauth', 'next-auth', 'lucia', 'supabase',
  // ui
  'tailwind', 'tailwindcss', 'shadcn', 'shadcn/ui', 'radix', 'radix-ui', 'chakra', 'mantine', 'mui', 'material-ui',
  // testing
  'vitest', 'jest', 'mocha', 'chai', 'playwright', 'cypress', 'testing-library',
  // build / tooling
  'turborepo', 'turbo', 'lerna', 'nx', 'rush', 'vite', 'esbuild', 'swc', 'webpack', 'rollup', 'tsup',
  'biome', 'eslint', 'prettier',
  // validation
  'zod', 'yup', 'joi', 'valibot', 'ajv',
  // llm / ai
  'langchain', 'langfuse', 'langgraph', 'llamaindex', 'ai sdk', 'openai sdk', 'anthropic sdk', 'mcp', 'model context protocol',
  // payments
  'stripe', 'paddle', 'lemon squeezy',
  // infra / deploy
  'vercel', 'railway', 'netlify', 'cloudflare workers', 'cloudflare', 'fly.io', 'render', 'aws lambda',
  // observability
  'grafana', 'prometheus', 'datadog', 'sentry', 'opentelemetry', 'otel',
  // state / data
  'react-query', 'tanstack query', 'tanstack', 'swr', 'zustand', 'jotai', 'redux', 'mobx', 'recoil',
  // pkg mgrs (specific, not "npm" alone)
  'pnpm workspaces', 'yarn workspaces',
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
  const input = readHookInput();
  const prompt = (input?.prompt ?? input?.user_prompt ?? input?.message ?? '').toString();

  if (prompt.length < 10) return;
  if (/^\s*\/\w/.test(prompt)) return; // slash commands skip the guard

  // User-extensible vocab via .browzer/search-triggers.json in cwd
  const cwd = input?.cwd ?? process.cwd();
  let vocab = [...DEFAULT_VOCAB];
  try {
    const extra = JSON.parse(readFileSync(join(cwd, '.browzer/search-triggers.json'), 'utf8'));
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
  if (scoped) scoped.forEach((s) => hits.add(s));

  // Install commands
  const installs = prompt.matchAll(/\b(?:npm i(?:nstall)?|pnpm add|yarn add|bun add)\s+([@\w\-/.]+)/gi);
  for (const m of installs) if (m[1]) hits.add(m[1]);

  // Import / require sources (skip relative paths)
  const imports = prompt.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g);
  for (const m of imports) {
    const src = m[1] ?? m[2];
    if (src && !src.startsWith('.') && !src.startsWith('/')) hits.add(src);
  }

  if (hits.size === 0) return;

  const list = [...hits];
  const preview = list.slice(0, 6).map((t) => `"${t}"`).join(', ');
  const seed = list.slice(0, 3).join(' ');

  process.stdout.write(
    `[Browzer search guard] Detected topic(s) in this prompt: ${preview}.\n` +
    `Before answering or writing code that touches these, run:\n` +
    `  browzer search "${seed} <your refined question>" --save /tmp/search.json\n` +
    `The workspace docs index is authoritative for how this project uses these libraries. ` +
    `Your training data may be stale or not match the project's version. ` +
    `If the search returns 0 hits, say so explicitly and proceed with training-data knowledge — ` +
    `do NOT pretend you searched when you didn't. /tmp/search.json is the receipt.\n` +
    `To customize what this guard reacts to in a specific repo, add terms to ` +
    `.browzer/search-triggers.json (array of strings).\n`,
  );
}

main();
process.exit(0);
