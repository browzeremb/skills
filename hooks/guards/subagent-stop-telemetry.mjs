#!/usr/bin/env node
// SubagentStop: append a one-line JSONL record per subagent termination so
// the operator can later answer "which subagents did my session spawn".
// Lives under ${CLAUDE_PLUGIN_DATA}/telemetry/ when set, otherwise
// ~/.browzer/telemetry/. Best-effort, never blocks.
//
// Design — per RETRO §15.1 ("stop emitting null-masked fields"):
//
// The Claude Code harness's SubagentStop event payload does NOT include
// cost-shaped fields (durationMs, toolUseCount, inputTokens, outputTokens).
// Earlier revisions of this hook recorded them as JSON `null` placeholders,
// which (a) made `subagent-<date>.jsonl` schema dishonest — the keys were
// always present, never populated — and (b) misled downstream consumers
// (jq queries, ad-hoc audits) into thinking the hook had "lost" data
// rather than that the harness never produced it.
//
// Resolution chosen here is RETRO §15.1 OPTION 2: stop mentioning nulls
// for the OPTIONAL (cost-shaped) fields — durationMs, toolUseCount,
// inputTokens, outputTokens are dropped entirely when the harness did
// not provide a finite number.
//
// F-13: the FIVE ALWAYS-AVAILABLE fields (ts, sessionId, agentId,
// agentType, cwd) intentionally use `?? ''` to keep the JSONL schema
// FIXED-SHAPE — every record carries the same five keys regardless of
// whether the harness omitted one. This is a different contract from
// the optional-numeric branch (drop on absence) and the difference is
// deliberate: downstream consumers can rely on schema stability for
// the always-on fields without null-checking each one. Empty-string
// fallback documents "harness omitted" without polluting the schema
// with nulls. Cross-correlation with the langfuse_hook.py cost stream
// (RETRO §15.1 options 1 & 3) is explicitly out of scope for this hook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHookEnabled, readHookInput } from './_util.mjs';

if (!isHookEnabled('subagent-stop-telemetry')) process.exit(0);

const input = readHookInput();
if (!input) process.exit(0);

function dataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA)
    return path.join(process.env.CLAUDE_PLUGIN_DATA, 'telemetry');
  return path.join(os.homedir(), '.browzer', 'telemetry');
}

const dir = dataDir();
try {
  fs.mkdirSync(dir, { recursive: true });
} catch {
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const file = path.join(dir, `subagent-${today}.jsonl`);

// Always-available fields. The harness reliably provides these (or omits
// the whole event). They are emitted verbatim — `undefined` becomes
// dropped by JSON.stringify, but we keep the keys present-with-empty-string
// rather than null so the schema stays honest and predictable.
const record = {
  ts: new Date().toISOString(),
  sessionId: input.session_id ?? '',
  agentId: input.agent_id ?? '',
  agentType: input.agent_type ?? '',
  cwd: input.cwd ?? '',
};

// Optional cost-shaped fields. Per RETRO §15.1 option 2: ONLY include the
// key if the harness actually provided a defined number. If the field is
// absent or non-numeric (including null), drop the key entirely rather
// than masking it as JSON null.
const optionalNumericFields = [
  ['durationMs', input.duration_ms ?? input.durationMs],
  ['toolUseCount', input.tool_use_count ?? input.toolUseCount],
  ['inputTokens', input.input_tokens ?? input.inputTokens],
  ['outputTokens', input.output_tokens ?? input.outputTokens],
];
for (const [key, value] of optionalNumericFields) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    record[key] = value;
  }
}

try {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
} catch {
  /* swallow — telemetry must never block the agent */
}

process.exit(0);
