// UserPromptSubmit context injector: surfaces the most recent gate receipt as
// `additionalContext` on the next agent turn so the model sees pass/fail
// signal before deciding what to do.
//
// Always exits 0. Emits at most ~400 chars of context. No JSON output when
// no fresh receipt exists — silent no-op.
//
// FR-2: pre-existing failures (captured in the session baseline on the first
// gate run) are filtered from the failure surface so the model does not treat
// regressions from before the session as actionable.

import { listValidReceipts } from '../_gate-receipts.mjs';
import { getEffectiveConfig } from '../_gate-resolve.mjs';
// F-18: import from the dedicated peer module, not from quality-gate-stop.mjs.
import { readSessionBaseline } from '../_session-baseline.mjs';
import { isHookEnabled, readHookInput, workspaceRootFor } from './_util.mjs';

const MAX_CONTEXT_CHARS = 400;
const MAX_TAIL_CHARS = 200;

function exit0() {
  process.exit(0);
}

function clip(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s ?? '';
  return s.slice(0, n - 1) + '…';
}

function emit(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    })}\n`,
  );
}

if (!isHookEnabled('quality-gate-context')) exit0();

const input = readHookInput();
const sessionId = input?.session_id ?? input?.sessionId ?? null;

const cwd = process.cwd();
const wsRoot = workspaceRootFor(cwd) ?? cwd;
const cfg = getEffectiveConfig(wsRoot);
const dirRel =
  cfg?.hooks?.qualityGate?.receipt?.directory ?? '.browzer/.gate-receipts';

const receipts = listValidReceipts({ cwd: wsRoot, dirRel });
if (receipts.length === 0) exit0();

const r = receipts[0];

const headerParts = [`[browzer] quality gate ${r.status}`];
if (r.command) headerParts.push(`(cmd: ${r.command})`);
if (typeof r.durationMs === 'number') {
  headerParts.push(`took ${(r.durationMs / 1000).toFixed(1)}s`);
}
if (r.status !== 'passed' && typeof r.exitCode === 'number') {
  headerParts.push(`exit=${r.exitCode}`);
}
const header = headerParts.join(' ');

let body = '';
if (r.status === 'failed') {
  // Bias toward stderr tail since failures usually surface there; fall back
  // to stdout if stderr is empty.
  const rawTail = (r.stderrTail && r.stderrTail.trim()) || r.stdoutTail || '';

  // F-16: read the session baseline only on the failed path — the common
  // pass-path never touches disk for the baseline file.
  // readSessionBaseline is safe when sessionId is null (returns []).
  const baselineFailures = new Set(readSessionBaseline(sessionId));

  // FR-2: filter out lines that exclusively mention a pre-existing (baseline)
  // failure so the model only sees regressions introduced in this session.
  //
  // F-5: use word-boundary regex instead of substring includes() to avoid
  // over-suppressing lines that contain the baseline test name as a substring
  // of a different, genuinely new failure name.  For example, a baseline entry
  // "foo bar" must not suppress a line reporting "foo bar baz" as a new
  // failure.  The word-boundary regex anchors the match so only standalone
  // occurrences of the baseline name trigger suppression.
  let filteredTail = rawTail;
  if (baselineFailures.size > 0) {
    // Pre-compile one regex per baseline entry (escape regex specials first).
    const baselinePatterns = [...baselineFailures].filter(Boolean).map((bf) => {
      const escaped = bf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // \b does not work well across all Unicode word chars; use a lookahead/
      // lookbehind that checks for a non-word char (or start/end of string)
      // on both sides so partial-word matches do not suppress the line.
      // F-5 over-match-prevention: also forbid a trailing space followed by
      // more content (e.g. baseline "foo bar" must not suppress "foo bar baz").
      return new RegExp(`(?<![\\w])${escaped}(?![\\w ])`); // no trailing word or space+word
    });

    const lines = rawTail.split(/\r?\n/);
    const kept = lines.filter((line) => {
      // Retain the line unless it exclusively mentions a baseline failure.
      for (const pattern of baselinePatterns) {
        if (pattern.test(line)) return false;
      }
      return true;
    });
    filteredTail = kept.join('\n').trim();
    // If every failure was pre-existing and there is nothing left, note it.
    if (!filteredTail && rawTail) {
      filteredTail = '[all failures are pre-existing from session baseline]';
    }
  }

  if (filteredTail) body = `\n${clip(filteredTail, MAX_TAIL_CHARS)}`;
} else if (r.status === 'pending') {
  body = ' (running in background — wait or proceed)';
}

const out = clip(`${header}${body}`, MAX_CONTEXT_CHARS);
emit(out);

exit0();
