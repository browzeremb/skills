#!/usr/bin/env node
// _auto-save-step.mjs — PostToolUse(Write) hook entrypoint.
//
// Reads the Claude Code hook payload from stdin, looks for a Write into
// docs/browzer/<feat>/staging/<PHASE>.{md,json}, and execs `browzer
// save-step <PHASE> --id <feat> --from <abs-path>` to validate + persist
// the artefact into workflow.json.
//
// Exit semantics (asyncRewake-friendly):
//   0  silent — non-matching path, autosave disabled, or success
//   2  CLI failure — stderr is a structured one-liner so the agent wakes
//      with the error
//
// Environment toggles:
//   BROWZER_AUTOSAVE=0   bypass entirely (debug)
//   BROWZER_LLM=1        forwarded to the CLI for quiet success path

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

// load-bearing: do not add a leading ^ anchor — see packages/skills/CLAUDE.md "Autosave matcher invariant"
const STAGING_RE = /docs\/browzer\/([^/]+)\/staging\/([A-Z_0-9]+)\.(md|json)$/;

async function readStdinAsync() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function findBrowzerBin() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const candidate = `${home}/.local/bin/browzer`;
    if (existsSync(candidate)) return candidate;
  }
  // Fallback to PATH lookup.
  const which = spawnSync('which', ['browzer'], { encoding: 'utf8' });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) return found;
  }
  return 'browzer';
}

// FR-6: Synthesize signals[] entries for UPDATE_DOCS when the field is
// missing/empty and twoPassRun is fully green.
// Reads update-docs-<feat-id>-*.json receipts scoped to the current feat-id
// (SE-F-4: checks os.tmpdir() first, then /tmp as back-compat fallback);
// never fabricates data.
// If no receipts exist AND twoPassRun is green, signals[] is left unchanged
// (AC-6 / SE-F-1: we do NOT emit a null-receipt sentinel — the judge flags
// empty signals[] as a genuine contract issue rather than a forged-compliance
// value). Rewrites the staging file in-place before save-step (SE-F-5).

// SE-F-3: extracted helpers ------------------------------------------------

function shouldEnrich(staging) {
  // Only enrich when signals is missing or empty.
  const signals = staging.signals;
  if (Array.isArray(signals) && signals.length > 0) return false;

  // twoPassRun must exist and be fully green (all boolean values === true).
  const tpr = staging.twoPassRun;
  if (!tpr || typeof tpr !== 'object') return false;
  const values = Object.values(tpr);
  if (values.length === 0) return false;
  if (!values.every((v) => v === true)) return false;

  // changedFiles must be non-empty.
  const changedFiles = staging.changedFiles;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;

  return true;
}

function collectReceipts(featId) {
  // SE-F-4: search os.tmpdir() first; fall back to literal /tmp for receipts
  // written by skills that hard-code the /tmp path.
  const prefix = `update-docs-${featId}-`;
  const dirs = [tmpdir()];
  if (tmpdir() !== '/tmp') dirs.push('/tmp');

  const seen = new Set();
  const receipts = [];

  for (const dir of dirs) {
    try {
      const files = readdirSync(dir).filter(
        (f) => f.startsWith(prefix) && f.endsWith('.json'),
      );
      for (const f of files) {
        const fullPath = `${dir}/${f}`;
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        try {
          const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
          if (parsed && typeof parsed === 'object') {
            receipts.push(parsed);
          }
        } catch {
          // Malformed receipt — skip.
        }
      }
    } catch {
      // Directory not readable — skip.
    }
  }

  return receipts;
}

function coerceSignal(receipt) {
  // SE-F-6: skip the signal entirely when kind is non-string.
  const rawKind = receipt.kind ?? receipt.type;
  const kind = typeof rawKind === 'string' ? rawKind : null;
  if (kind === null) return null;

  const receiptRef = receipt.receipt ?? receipt.path ?? receipt.file ?? null;

  // SE-F-2 / F-14: omit observedAt when the receipt has none — never fabricate.
  const rawObservedAt = receipt.observedAt ?? receipt.timestamp;
  const signal = { kind, receipt: receiptRef };
  if (typeof rawObservedAt === 'string' && rawObservedAt.length > 0) {
    signal.observedAt = rawObservedAt;
  }

  return signal;
}

// ---------------------------------------------------------------------------

function enrichUpdateDocsSignals(absPath, featId) {
  let staging;
  try {
    staging = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    // Cannot parse — leave file untouched; save-step will surface the error.
    return;
  }

  if (!shouldEnrich(staging)) return;

  const receipts = collectReceipts(featId);
  const synthesized = receipts.map(coerceSignal).filter(Boolean);

  // F-13 / SE-F-1: when no scoped receipts exist, do NOT emit a null-receipt
  // sentinel. Leave signals[] unchanged so the judge can flag the contract
  // violation accurately rather than hiding it behind a forged value.
  if (synthesized.length === 0) return;

  staging.signals = synthesized;

  // SE-F-5: in-place rewrite. Log on failure and proceed — save-step will
  // validate the original file and surface any schema errors.
  // F-2: log WARN on write failure instead of silently swallowing it.
  try {
    writeFileSync(absPath, JSON.stringify(staging, null, 2));
  } catch (err) {
    process.stderr.write(
      `[auto-save-step] WARN: signals[] enrichment write failed: ${err?.message ?? err}\n`,
    );
  }
}

async function main() {
  if (process.env.BROWZER_AUTOSAVE === '0') {
    process.exit(0);
  }

  const raw = await readStdinAsync();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    // Malformed payload — silent no-op (don't fail the surrounding tool call).
    process.exit(0);
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    process.exit(0);
  }

  const m = STAGING_RE.exec(filePath);
  if (!m) {
    process.exit(0);
  }
  const feat = m[1];
  const phase = m[2];

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

  // FR-4: if the staging file does not exist on disk, emit an additionalContext
  // nudge and exit 0 (non-blocking). The check runs within the existing
  // asyncRewake 15s budget — it is a synchronous fs.existsSync call.
  if (!existsSync(absPath)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `Your staging artifact at \`${absPath}\` was not found. ` +
            'Write it now — your turn is not complete until this file exists.',
        },
      }),
    );
    process.exit(0);
  }

  // FR-6: UPDATE_DOCS signals[] enrichment.
  // When the phase is UPDATE_DOCS and the staging JSON has an empty/missing
  // signals[] while twoPassRun is fully green, synthesize signals from real
  // /tmp/update-docs-*.json receipts before invoking save-step.
  // Short-circuit cheaply (single string compare) for all other phases — NFR-2.
  if (phase === 'UPDATE_DOCS') {
    enrichUpdateDocsSignals(absPath, feat);
  }

  const bin = findBrowzerBin();
  // Honor caller's BROWZER_LLM setting (opt-in toggle from the header docs);
  // do not unconditionally force '1'.
  const env = { ...process.env };
  const result = spawnSync(
    bin,
    ['save-step', phase, '--id', feat, '--from', absPath, '--await'],
    { encoding: 'utf8', env, cwd },
  );

  if (result.error) {
    const msg = `auto-save-step failed: phase=${phase} feat=${feat} exitCode=spawn-error stderr=${result.error.message}`;
    process.stderr.write(
      `[autosave] save-step ${phase}: spawn failed: ${result.error.message}\n`,
    );
    // FR-7: emit subagent-context failure JSON to stdout on failure.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext: msg } }),
    );
    process.exit(2);
  }

  if (result.status !== 0) {
    const rawStderr = (result.stderr || '').trim();
    const exitCode = result.signal
      ? `signal-${result.signal}`
      : String(result.status);
    const exitDesc = result.signal
      ? `signal ${result.signal}`
      : `exit ${result.status}`;
    // Truncate stderr to 512 chars per FR-7 spec.
    const truncatedStderr =
      rawStderr.length > 512 ? `${rawStderr.slice(0, 512)}…` : rawStderr;
    const msg = `auto-save-step failed: phase=${phase} feat=${feat} exitCode=${exitCode} stderr=${truncatedStderr}`;
    process.stderr.write(
      `[autosave] save-step ${phase}: ${rawStderr || exitDesc}\n`,
    );
    // FR-7: emit subagent-context failure JSON to stdout on failure.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext: msg } }),
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[autosave] internal error: ${err?.message || err}\n`);
  process.exit(2);
});
