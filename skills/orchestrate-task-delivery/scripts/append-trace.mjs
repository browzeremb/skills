#!/usr/bin/env node
/**
 * append-trace.mjs — append a transition to DELEGATION_TRACE.md
 *
 * One bullet per orchestrator transition:
 *   - <timestamp> orchestrator → <from-state> → <next-phase> args=<args>
 *
 * Idempotent for the file as a whole (multiple append-trace runs concat;
 * the cycle guard in detect-phase.mjs reads the tail).
 *
 * Usage:
 *   node append-trace.mjs <featureId> --from <state> --to <phase> [--args <comma-list>]
 *   node append-trace.mjs <featureId> --halt <reason>
 *   node append-trace.mjs <featureId> --done
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function die(msg, code = 1) {
  process.stderr.write(`append-trace: ${msg}\n`);
  process.exit(code);
}

function atomicWrite(path, content) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function parseArgs(argv) {
  const out = { args: [] };
  out.featureId = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.fromState = argv[++i];
    else if (a === '--to') out.toPhase = argv[++i];
    else if (a === '--args') out.args = argv[++i].split(',').filter(Boolean);
    else if (a === '--halt') out.halt = argv[++i];
    else if (a === '--done') out.done = true;
    else if (a === '--operator-override') out.override = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(args.featureId)) {
    die(
      'usage: append-trace <featureId> --from <state> --to <phase> [--args <list>] | --halt <reason> | --done | --operator-override <text>',
      2,
    );
  }
  const featDir = resolve('docs', 'browzer', args.featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);

  const tracePath = join(featDir, 'DELEGATION_TRACE.md');
  const prev = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8')
    : '# Delegation trace\n\nAppend-only log of orchestrate-task-delivery transitions. Cycle guard reads the tail.\n\n';

  const ts = new Date().toISOString();
  let entry;
  if (args.done) {
    entry = `- ${ts} orchestrator → DONE`;
  } else if (args.halt) {
    entry = `- ${ts} orchestrator → HALT (${args.halt})`;
  } else if (args.override) {
    entry = `- ${ts} orchestrator → operator-override: ${args.override}`;
  } else if (args.fromState && args.toPhase) {
    const argsStr = args.args.length ? ` args=${args.args.join(',')}` : '';
    entry = `- ${ts} orchestrator → ${args.fromState} → ${args.toPhase}${argsStr}`;
  } else {
    die('must pass --from/--to OR --halt OR --done OR --operator-override', 2);
  }

  const next = prev.trimEnd() + '\n' + entry + '\n';
  atomicWrite(tracePath, next);
  console.log(`appended trace: ${entry}`);
}

main();
