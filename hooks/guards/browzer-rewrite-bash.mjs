#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyPath,
  isHookEnabled,
  isInBrowzerWorkspace,
  NEVER_REWRITE_RE,
  readHookInput,
  stripQuoted,
} from './_util.mjs';

if (!isHookEnabled('rewrite-bash')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Bash') process.exit(0);

const cmd = input.tool_input?.command;
if (typeof cmd !== 'string') process.exit(0);

/**
 * Once-per-session sentinel-file dedup for the run-proxy `additionalContext`
 * banner. Same pattern as the BROWZER_LLM banner block below, but a separate
 * sentinel label so the two banners are independent.
 *
 * Without this dedup, every git/vitest/pnpm/biome/tsc rewrite emits ~80
 * chars of "Browzer rewrote ... → ... (run-proxy compression)." prose into
 * the model's context — a typical feature run with 20+ test/lint calls
 * accumulates 1-3 KB of repetitive banner noise. After dedup: one banner
 * per session, subsequent rewrites silent (the model already learned the
 * pattern from the first one and sees the new command via `updatedInput`).
 *
 * Returns true if the banner has already been emitted this session.
 */
function runProxyBannerAlreadyEmitted() {
  const sid = (() => {
    if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    if (projectDir) {
      return crypto
        .createHash('sha1')
        .update(projectDir)
        .digest('hex')
        .slice(0, 12);
    }
    return String(process.ppid);
  })().replace(/[^a-zA-Z0-9_-]/g, '_');
  const tmpBase = process.env.TMPDIR || os.tmpdir();
  const sentinelPath = path.join(
    tmpBase,
    `.browzer-runproxy-banner-${sid}.flag`,
  );
  const exists = fs.existsSync(sentinelPath);
  if (!exists) {
    try {
      fs.writeFileSync(sentinelPath, '', { flag: 'wx' });
    } catch (e) {
      // EEXIST = lost race (another concurrent hook wrote first). Any other
      // error is best-effort — banner will re-emit next call (graceful
      // degradation when TMPDIR is unwritable).
    }
  }
  return exists;
}

// --- BROWZER_LLM=1 injection (WF-SYNC-2, 2026-05-04) ---
// Every `browzer ...` invocation gets BROWZER_LLM=1 prefixed so the per-mutation
// audit line is suppressed in agent shells. Done as a hook (instead of inline
// `export BROWZER_LLM=1` in skill bash) because each Bash tool call in Claude
// Code runs in an isolated shell — `export` in one call does NOT persist to
// the next. The previous `: "${BROWZER_LLM:=1}"; export` blocks (76871ee2 WS-3)
// were inert for this reason. The flag-equivalent --llm and per-call env are
// the only modes that actually work in agent context.
//
// Idempotence guards skip the prefix when:
//   - operator already set BROWZER_LLM=<anything> on this command line,
//   - operator already passed --llm or --llm=<value>,
//   - the command starts with a subshell `(` or brace-group `{` (we can't
//     safely prepend env there without breaking shell parsing),
//   - the leading token isn't `browzer` (compound `cmd && browzer ...` —
//     regex won't match; opt-out is implicit).
//
// Banner suppression: when BROWZER_LLM is already truthy in the incoming
// shell environment, the prefix is still injected (the flag is needed for
// the CLI), but additionalContext is omitted to prevent banner spam on
// every subsequent browzer call within the same session.
{
  const browzerCmdRe = /^\s*browzer(\s|$)/;
  if (browzerCmdRe.test(cmd)) {
    const alreadyHasEnv = /(^|\s)BROWZER_LLM=/.test(cmd);
    const alreadyHasFlag = /(^|\s)--llm(\s|=|$)/.test(cmd);
    const wrappedSubshell = /^\s*[({]/.test(cmd);
    if (!alreadyHasEnv && !alreadyHasFlag && !wrappedSubshell) {
      const newCmd = `BROWZER_LLM=1 ${cmd.replace(/^\s+/, '')}`;

      // Env-based guard (kept as redundant safeguard): suppress banner when
      // BROWZER_LLM is already truthy in the incoming environment. Note:
      // treat '0' and 'false' as falsy (shell convention), not just empty
      // string — Boolean('0') is true in JS, so we check explicitly.
      const rawEnv = process.env.BROWZER_LLM ?? '';
      const envAlreadySet =
        rawEnv.length > 0 && rawEnv !== '0' && rawEnv !== 'false';

      // Sentinel-file-based once-per-session banner suppression. Each Bash
      // tool call runs in an isolated child process — env vars set by one
      // call do NOT propagate back to the hook's parent. A sentinel file in
      // TMPDIR keyed by session-id survives across Bash subshell boundaries
      // and provides reliable once-per-session deduplication.
      //
      // Session key resolution (first wins):
      //   1. CLAUDE_SESSION_ID env var (set by Claude Code in agent context)
      //   2. SHA-1 hash of CLAUDE_PROJECT_DIR (stable within one project session)
      //   3. Parent PID (fallback — less stable across daemon restarts)
      const sessionId = (() => {
        if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
        const projectDir = process.env.CLAUDE_PROJECT_DIR;
        if (projectDir) {
          return crypto
            .createHash('sha1')
            .update(projectDir)
            .digest('hex')
            .slice(0, 12);
        }
        return String(process.ppid);
      })();
      // Sanitize sessionId to prevent path-traversal. CLAUDE_SESSION_ID is
      // set by the Claude Code runtime, not by attacker-controlled input,
      // but treating env vars as untrusted is the correct defensive posture
      // for a plugin distributed across diverse host configurations. Strip
      // any character that is not alphanumeric, dash, or underscore so
      // path.join cannot resolve to an unexpected directory even on unusual
      // host setups.
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const tmpBase = process.env.TMPDIR || os.tmpdir();
      // Sentinel files live in TMPDIR (falling back to os.tmpdir()) and are
      // auto-cleaned by the OS on /tmp pruning (typically on reboot). There
      // is no manual cleanup hook — wiping on every Stop would defeat the
      // once-per-session goal. If TMPDIR is not writable the banner falls
      // back to re-emitting every call (graceful degradation; see try/catch
      // below).
      const sentinelPath = path.join(
        tmpBase,
        `.browzer-llm-banner-${safeSessionId}.flag`,
      );
      // TOCTOU note — concurrent PreToolUse(Bash) hook invocations (e.g.
      // parallel subagent dispatch) may both observe sentinelExists=false
      // and both emit the banner on the truly-first concurrent invocations.
      // Banner-twice is acceptable; banner-never is not. Do not introduce
      // heavier locking — it would blow the ~50ms hook budget. This race is
      // intentionally tolerated.
      const sentinelExists = fs.existsSync(sentinelPath);

      // Suppress banner when: env was already truthy OR a sentinel file
      // shows we already emitted the banner this session.
      const bannerSuppressed = envAlreadySet || sentinelExists;

      const ctx = bannerSuppressed
        ? undefined
        : 'Browzer prefixed BROWZER_LLM=1 to suppress per-mutation audit telemetry and correlate workflow traces (override: BROWZER_LLM=0 or --llm=0).';

      // Mark sentinel on first emission so subsequent calls in the same session
      // skip the banner. Sentinel files in /tmp are auto-cleaned on reboot.
      //
      // Use { flag: 'wx' } (O_EXCL | O_WRONLY) so the create is atomic — if
      // another concurrent hook instance already wrote the sentinel between
      // our existsSync check and this write, the OS returns EEXIST and we
      // treat that as "lost the race; banner already emitted". Banner-twice
      // on the very first concurrent pair is still possible (both pass the
      // existsSync check before either writes) but that is a benign cosmetic
      // duplicate. What 'wx' eliminates is a third hook instance racing a
      // subsequent pair and corrupting the sentinel. Any non-EEXIST error is
      // best-effort: the banner will re-emit next call (graceful degradation).
      if (!bannerSuppressed) {
        try {
          fs.writeFileSync(sentinelPath, '', { flag: 'wx' });
        } catch (e) {
          if (e?.code !== 'EEXIST') {
            // Best-effort — if the write fails for any reason other than a
            // concurrent winner the banner will re-emit next call, which is
            // acceptable (fallback to previous behavior).
          }
          // EEXIST: another concurrent hook instance won the race and already
          // wrote the sentinel. No action needed — the intent is fulfilled.
        }
      }

      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...input.tool_input, command: newCmd },
        },
      };
      if (ctx !== undefined) {
        output.hookSpecificOutput.additionalContext = ctx;
      }
      process.stdout.write(JSON.stringify(output));
      process.exit(0);
    }
    // Leading `browzer` but opted out — exit clean; do not fall through to
    // the cat/head/tail rewrite (it can't match a browzer command anyway).
    process.exit(0);
  }
}

// --- Run-proxy compression ---
// Rewrites common shell tool invocations to `browzer run <cmd>` so the CLI
// can apply output compression, token-economy filters, and structured
// result formatting. Only simple (non-compound) commands are rewritten;
// pipes, redirects, and chain operators are left untouched.
{
  const RUN_REWRITE_PATTERNS = [
    // git subcommands worth compressing
    {
      re: /^\s*(git\s+(status|log|diff|push|pull|add|commit))\b/,
      label: 'git',
    },
    // vitest (standalone or via npx)
    { re: /^\s*(npx\s+)?vitest\b/, label: 'vitest' },
    // pnpm turbo (must come before generic pnpm)
    { re: /^\s*pnpm\s+turbo\b/, label: 'pnpm-turbo' },
    // go test
    { re: /^\s*go\s+test\b/, label: 'go-test' },
    // cargo test
    { re: /^\s*cargo\s+test\b/, label: 'cargo-test' },
    // biome check/lint/format (standalone, npx, or pnpm exec)
    {
      re: /^\s*(npx\s+|pnpm\s+exec\s+)?biome\s+(check|lint|format)\b/,
      label: 'biome',
    },
    // tsc (standalone, npx, or pnpm exec)
    { re: /^\s*(npx\s+|pnpm\s+exec\s+)?tsc\b/, label: 'tsc' },
    // pnpm run / pnpm exec vitest (not turbo — turbo already handled above)
    {
      re: /^\s*pnpm\s+(run\s+|exec\s+|--filter\s+\S+\s+)?vitest\b/,
      label: 'vitest',
    },
  ];

  // Compute the shell skeleton (quoted bodies stripped) once.
  const skeleton = stripQuoted(cmd);

  // Already rewritten — skip to avoid double-wrapping.
  if (!/^\s*browzer\s+run\b/.test(cmd)) {
    for (const { re } of RUN_REWRITE_PATTERNS) {
      if (!re.test(skeleton)) continue;

      // Skip compound commands — pipes, redirects, semicolons, chain operators.
      if (/[|;&<>]/.test(skeleton)) {
        // For simple pipe/redirect cases (no chain operators like && / || / ;),
        // emit a one-line additionalContext so the model knows why compression was
        // bypassed. Chain-operator compounds (e.g. "git status && browzer ...") are
        // silently skipped to avoid suggesting a misleading `browzer run` wrapper.
        if (!/[;&]/.test(skeleton)) {
          process.stdout.write(
            JSON.stringify({
              additionalContext: `[browzer] Skipped run-proxy rewrite for \`${cmd.trim()}\` (compound command with pipe/redirect). To compress output manually: \`browzer run ${cmd.trim()}\`.`,
            }),
          );
        }
        break;
      }

      // Skip if NEVER_REWRITE_RE matches the whole command (e.g. config files).
      if (NEVER_REWRITE_RE.test(cmd)) break;

      const newCmd = `browzer run ${cmd.trim()}`;
      const bannerEmittedBefore = runProxyBannerAlreadyEmitted();
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...input.tool_input, command: newCmd },
        },
      };
      if (!bannerEmittedBefore) {
        output.hookSpecificOutput.additionalContext = `Browzer rewrote \`${cmd.trim()}\` → \`${newCmd}\` (run-proxy compression). Subsequent rewrites this session emit silently — the agent already learned the pattern.`;
      }
      process.stdout.write(JSON.stringify(output));
      process.exit(0);
    }
  }
}

// Match exactly: <verb> <single-token-path>; reject pipes, redirects, chains, flags.
const m = cmd.match(/^\s*(cat|head|tail|less|more)\s+([^\s|;&<>]+)\s*$/);
if (!m) process.exit(0);

const filePath = m[2];
if (classifyPath(filePath) !== 'code') process.exit(0);
if (NEVER_REWRITE_RE.test(filePath)) process.exit(0);

// Skip files small enough that the rewrite round-trip costs more than it saves.
// 500 lines is roughly 2-3k tokens — below this the daemon adds overhead with
// negligible savings, and the rewritten output would force the model to
// re-parse "Browzer optimized..." prose for raw content it could read directly.
try {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) process.exit(0);
  // Cheap heuristic: average line length ~80 bytes; skip if <40KB.
  // Avoids reading the whole file just to count lines.
  if (stat.size < 40 * 1024) process.exit(0);
} catch {
  process.exit(0);
}

const newCmd = `browzer read ${JSON.stringify(filePath)} --filter=auto`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input.tool_input, command: newCmd },
      additionalContext: `Browzer rewrote \`${cmd.trim()}\` → \`${newCmd}\` (token-economy filter applied).`,
    },
  }),
);
process.exit(0);
