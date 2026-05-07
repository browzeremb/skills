#!/usr/bin/env node
// SubagentStop: append a one-line JSONL record per subagent termination so
// the operator can later answer "which skills did my agents actually use,
// and at what cost". Lives under ${CLAUDE_PLUGIN_DATA}/telemetry/ when set,
// otherwise ~/.browzer/telemetry/. Best-effort, never blocks.
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

const record = {
  ts: new Date().toISOString(),
  sessionId: input.session_id ?? null,
  agentId: input.agent_id ?? null,
  agentType: input.agent_type ?? null,
  cwd: input.cwd ?? null,
  // The harness payload may include any of these; capture what's there.
  durationMs: input.duration_ms ?? input.durationMs ?? null,
  toolUseCount: input.tool_use_count ?? input.toolUseCount ?? null,
  inputTokens: input.input_tokens ?? input.inputTokens ?? null,
  outputTokens: input.output_tokens ?? input.outputTokens ?? null,
};

try {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
} catch {
  /* swallow — telemetry must never block the agent */
}

process.exit(0);
