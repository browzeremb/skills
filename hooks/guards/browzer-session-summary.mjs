#!/usr/bin/env node
// Stop-event hook: spawns `browzer gain --adoption --json --since 1h` with a
// 200 ms wall-clock timeout and emits a compact token-economy summary as
// additionalContext so the operator sees per-session savings at turn end.
//
// Boundary contract:
//   - Never blocks the agent (exit 0 fast on every code path).
//   - Never re-triggers itself (input.stop_hook_active guard).
//   - On spawn failure, parse failure, or timeout → exit 0 silently.
//   - Plugin-agnostic: no monorepo paths.
//
// JSON contract (matches the `runAdoptionReport` shape emitted by
// `browzer gain --adoption --json`):
//   { since, adoption, savedTotal, wastedTotal,
//     topWasted: { source, command, savedTokens, suggestion } | null,
//     byPattern: { savedFromCli, savedFromHooks, wasted, other } }

import { execFileSync } from 'node:child_process';
import { readHookInput } from './_util.mjs';

const TIMEOUT_MS = 200;

function exit0() {
  process.exit(0);
}

function emitFallback() {
  process.stdout.write(
    JSON.stringify({
      additionalContext: '[browzer] Session summary unavailable.',
    }) + '\n',
  );
  exit0();
}

const input = readHookInput();
if (input && input.stop_hook_active === true) exit0();

// Test seam: BROWZER_GAIN_OUTPUT bypasses the actual browzer spawn so unit
// tests can exercise the parsing/formatting path without a real binary.
// Gated behind NODE_ENV === 'test' so the env var cannot silently override
// real telemetry in production. Set to a JSON string to simulate gain output.
const _isTestEnv = process.env.NODE_ENV === 'test';
const _testOutput = _isTestEnv
  ? (process.env.BROWZER_GAIN_OUTPUT ?? null)
  : null;

let raw;
if (_testOutput !== null) {
  raw = _testOutput;
} else {
  try {
    raw = execFileSync(
      'browzer',
      ['gain', '--adoption', '--json', '--since', '1h'],
      {
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      },
    );
  } catch {
    // browzer not on PATH, non-zero exit, or timeout — exit silently.
    exit0();
  }
}

if (!raw || raw.trim().length === 0) exit0();

let parsed;
try {
  parsed = JSON.parse(raw.trim());
} catch {
  // Non-JSON output — emit safe fallback. This can only happen if the
  // CLI's `--adoption --json` contract regresses, since the production
  // codepath always passes `--json`.
  emitFallback();
}

try {
  // Real CLI emits `savedTotal` / `wastedTotal` / `adoption` / `topWasted`.
  // Accept snake_case aliases too so downstream contract drift is tolerated.
  const savedTokens =
    parsed?.savedTotal ?? parsed?.saved_total ?? parsed?.saved_tokens ?? null;
  const wastedTotal = parsed?.wastedTotal ?? parsed?.wasted_total ?? null;
  // `adoption` is a ratio (savedTotal / wastedTotal), null when wastedTotal=0.
  const adoptionRatio =
    parsed?.adoption ??
    parsed?.adoptionMultiplier ??
    parsed?.adoption_multiplier ??
    null;

  // Top wasted source: real CLI emits `topWasted: {source, savedTokens, …}`.
  let topSource = null;
  let topWastedTokens = null;
  const tw = parsed?.topWasted ?? parsed?.top_wasted ?? null;
  if (tw && typeof tw === 'object') {
    topSource = tw.source ?? tw.command ?? tw.name ?? null;
    // `savedTokens` on a wasted bucket is a NEGATIVE int; report magnitude.
    const tok = tw.savedTokens ?? tw.saved_tokens ?? tw.tokens ?? null;
    topWastedTokens = tok === null ? null : Math.abs(Number(tok));
  } else {
    // Tolerate older `wasted[]` array shape if a future CLI re-introduces it.
    const wastedArr = parsed?.wasted ?? null;
    if (Array.isArray(wastedArr) && wastedArr.length > 0) {
      const top = wastedArr[0];
      topSource = top?.source ?? top?.name ?? null;
      const tok = top?.tokens ?? top?.savedTokens ?? top?.saved_tokens ?? null;
      topWastedTokens = tok === null ? null : Math.abs(Number(tok));
    }
  }

  if (savedTokens === null && wastedTotal === null) {
    emitFallback();
  }

  const k = (n) => Math.round(Number(n) / 1000);
  const savedK = savedTokens === null ? 0 : k(savedTokens);
  const adoptionPart =
    adoptionRatio !== null && Number.isFinite(Number(adoptionRatio))
      ? ` (adoption ${Number(adoptionRatio).toFixed(1)}x)`
      : '';
  const wastedPart =
    topSource !== null && topWastedTokens !== null
      ? ` Top wasted: ${topSource} (${k(topWastedTokens)}k).`
      : '';

  const msg = `[browzer] Session saved ${savedK}k tokens${adoptionPart}.${wastedPart}`;
  process.stdout.write(JSON.stringify({ additionalContext: msg }) + '\n');
} catch {
  emitFallback();
}

exit0();
