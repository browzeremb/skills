// Feed the `hook-saved-tokens` tracker bucket exposed by the CLI.
// Existing hooks talk to the daemon over JSON-RPC `Track` via the
// `trackEvent` helper in guards/_util.mjs; this thin wrapper just stamps
// the canonical `source` and ensures the call never blocks the host hook.
//
// Public surface:
//   emitHookDelta({ hook, savedTokens, ...meta }) -> Promise<void>
//
// The CLI tracker aggregates events whose `source === "hook-saved-tokens"`
// and groups by `command` (= the hook name) when answering
// `browzer gain --hooks --json`.

// Cross-folder import (guards/ → hooks/): temporary boundary exception.
// guards/_util.mjs owns the trackEvent helper and is the correct call site.
// Planned consolidation: move trackEvent to hooks/_tracker-client.mjs so both
// this module and any future hooks-level consumers share one import root.
// Deferred — tracked in TECHNICAL_DEBTS.md under "tracker-client-consolidation".
import { trackEvent } from './guards/_util.mjs';

const BUCKET = 'hook-saved-tokens';

/**
 * @param {object} args
 * @param {string} args.hook         logical hook name, written to the
 *                                   tracker's `command` column.
 * @param {number} args.savedTokens  delta to record; integer tokens.
 * @param {string} [args.sessionId]  optional pass-through.
 * @param {string} [args.pathHash]   optional 12-char path digest.
 * @param {number} [args.execMs]
 * @param {string} [args.estimationMethod]  default 'estimated'.
 */
export async function emitHookDelta(args) {
  if (!args || typeof args !== 'object') return;
  const hook = String(args.hook ?? '').trim();
  const savedTokens = Number.isFinite(args.savedTokens)
    ? Math.round(args.savedTokens)
    : 0;
  if (!hook || savedTokens === 0) return;

  const payload = {
    ts: new Date().toISOString(),
    source: BUCKET,
    command: hook,
    inputBytes: Number(args.inputBytes) || 0,
    outputBytes: Number(args.outputBytes) || 0,
    savedTokens,
    savingsPct: Number(args.savingsPct) || 0,
    filterLevel: args.filterLevel ?? null,
    filterFailed: Boolean(args.filterFailed) || false,
    execMs: Number(args.execMs) || 0,
    sessionId: args.sessionId ?? null,
    pathHash: args.pathHash ?? null,
    estimationMethod: args.estimationMethod ?? 'estimated',
  };

  try {
    await trackEvent(payload);
  } catch {
    // trackEvent already has its own fallback path; swallow here so the
    // host hook returns within its ~50ms budget no matter what.
  }
}

export const HOOK_SAVED_TOKENS_BUCKET = BUCKET;
