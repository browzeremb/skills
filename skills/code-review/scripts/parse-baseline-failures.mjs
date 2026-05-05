#!/usr/bin/env node
// parse-baseline-failures.mjs — convert a per-test runner log into the
// `baseline.failures[]` shape the code-review step expects.
//
// Why this exists:
//   The code-review skill mandates per-test enumeration of baseline failures
//   ("vitest --reporter=json", "pytest --report-log=...", "go test -json") but
//   never provided a parser. Each invocation re-implemented it inline, which
//   produced inconsistent shapes and lumped counts that the schema rejects.
//
// Usage:
//   node scripts/parse-baseline-failures.mjs --tool <tool> --log <path>
//   node scripts/parse-baseline-failures.mjs <tool> <path>      (positional alias)
//
// Tools supported:
//   vitest    — JSON reporter output (`vitest --reporter=json` >> log)
//   jest      — JSON reporter output (`jest --json` >> log)
//   pytest    — `pytest --report-log=path` (newline-delimited JSON)
//   go-test   — `go test -json ./...` (newline-delimited JSON)
//
// Output (stdout, single JSON document):
//   [
//     { "id":   "<package>::<test-name>",
//       "tool": "<tool>",
//       "name": "<test-name>",
//       "file": "<path>" | null,
//       "package": "<pkg>" | null,
//       "message": "<single-line failure summary>" }
//   ]
//
// Exit codes:
//   0 — log parsed (failures[] may be empty when the run was green)
//   1 — usage error
//   2 — IO / parse error

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

function parseArgs(raw) {
  const out = { tool: null, log: null };
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--tool') out.tool = raw[++i];
    else if (a === '--log') out.log = raw[++i];
    else pos.push(a);
  }
  if (!out.tool && pos[0]) out.tool = pos[0];
  if (!out.log && pos[1]) out.log = pos[1];
  return out;
}

const SUPPORTED = new Set(['vitest', 'jest', 'pytest', 'go-test']);

function singleLine(s) {
  return String(s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' — ')
    .slice(0, 500);
}

function parseVitestOrJest(raw, tool) {
  const doc = JSON.parse(raw);
  const out = [];
  const suites = Array.isArray(doc.testResults) ? doc.testResults : [];
  for (const suite of suites) {
    const file = suite.name || suite.testFilePath || null;
    const tests = Array.isArray(suite.assertionResults)
      ? suite.assertionResults
      : [];
    for (const t of tests) {
      if (t.status !== 'failed') continue;
      const name = (t.fullName || t.title || 'unknown').trim();
      const message = singleLine((t.failureMessages || []).join('\n'));
      out.push({
        id: `${file || 'unknown'}::${name}`,
        tool,
        name,
        file,
        package: null,
        message,
      });
    }
  }
  return out;
}

function parsePytest(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.$report_type !== 'TestReport') continue;
    if (rec.outcome !== 'failed') continue;
    if (rec.when && rec.when !== 'call') continue;
    const nodeid = rec.nodeid || 'unknown';
    const file = rec.location && rec.location[0] ? rec.location[0] : null;
    const message = singleLine(
      (rec.longrepr && (rec.longrepr.reprcrash?.message || rec.longrepr)) ||
        nodeid,
    );
    out.push({
      id: nodeid,
      tool: 'pytest',
      name: nodeid,
      file,
      package: null,
      message,
    });
  }
  return out;
}

function parseGoTest(raw) {
  const failed = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec.Test) continue;
    const id = `${rec.Package || 'unknown'}::${rec.Test}`;
    if (rec.Action === 'output') {
      const buf = failed.get(id) || { outputs: [] };
      buf.outputs.push(rec.Output || '');
      failed.set(id, buf);
    } else if (rec.Action === 'fail') {
      const buf = failed.get(id) || { outputs: [] };
      buf.failed = true;
      buf.package = rec.Package || null;
      buf.test = rec.Test;
      failed.set(id, buf);
    }
  }
  const out = [];
  for (const [id, buf] of failed) {
    if (!buf.failed) continue;
    out.push({
      id,
      tool: 'go-test',
      name: buf.test,
      file: null,
      package: buf.package,
      message: singleLine((buf.outputs || []).join('')),
    });
  }
  return out;
}

const args = parseArgs(argv.slice(2));
if (!args.tool || !args.log) {
  stderr.write(
    'usage: parse-baseline-failures.mjs --tool <vitest|jest|pytest|go-test> --log <path>\n',
  );
  exit(1);
}
if (!SUPPORTED.has(args.tool)) {
  stderr.write(
    `unsupported --tool "${args.tool}" (expected one of: ${[...SUPPORTED].join(', ')})\n`,
  );
  exit(1);
}

let raw;
try {
  raw = readFileSync(args.log, 'utf8');
} catch (err) {
  stderr.write(`read failed: ${args.log}: ${err.message}\n`);
  exit(2);
}

let result;
try {
  if (args.tool === 'vitest' || args.tool === 'jest')
    result = parseVitestOrJest(raw, args.tool);
  else if (args.tool === 'pytest') result = parsePytest(raw);
  else result = parseGoTest(raw);
} catch (err) {
  stderr.write(`parse failed: ${err.message}\n`);
  exit(2);
}

stdout.write(JSON.stringify(result));
stdout.write('\n');
