#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyPath,
  isHookEnabled,
  isInBrowzerWorkspace,
  NEVER_REWRITE_RE,
  readHookInput,
} from './_util.mjs';

if (!isHookEnabled('rewrite-bash')) process.exit(0);
if (!isInBrowzerWorkspace()) process.exit(0);

const input = readHookInput();
if (input?.tool_name !== 'Bash') process.exit(0);

const cmd = input.tool_input?.command;
if (typeof cmd !== 'string') process.exit(0);

// --- Workflow correlation env injection (RETRO §C8) ---
// Reads BROWZER_WORKFLOW_STEP_ID from the live workflow.json instead of the
// orchestrator's `export` block, which is invisible across Claude Code's
// per-Bash subshell isolation. Best-effort; absent step id silently skips.
//
// Status gate (2026-05-05, retro item 3.4): when a workflow finishes a run
// the file's `currentStepId` keeps pointing at the last step (typically
// `STEP_NN_COMMIT` in COMPLETED status). The mtime-latest selector then
// happily picks that workflow up across unrelated sessions and stamps every
// `browzer` invocation with a step-id that has nothing to do with the
// caller's actual context — Langfuse traces accumulate against the wrong
// step. The terminal-status gate suppresses the stamp once the step the
// workflow is "currently on" has finished; an active workflow stamps
// normally because its currentStepId points at a non-terminal status.
//
// Forward-compat contract (RETRO §C3, 2026-05-05): unknown future statuses
// (e.g. a `WAITING_FOR_DEPLOY` added by a later schema version) FAIL OPEN —
// they fall through and the step-id is stamped. The conservative default
// keeps telemetry correlated to the last-known step rather than silently
// dropping correlation the moment a new status ships. Pinned by
// `integration.test.mjs::rewrite-bash stamps unknown future status`. If
// the desired behaviour ever flips to fail-closed, that test must be
// updated deliberately so the change is visible in code review.
const TERMINAL_STEP_STATUSES = new Set(['COMPLETED', 'SKIPPED', 'STOPPED']);

function readWorkflowConfig(cwd) {
  // Discover workflow path layout via .browzer/config.json `workflow.featRoot`
  // + `workflow.featPrefix`. Defaults preserve the legacy convention
  // (docs/browzer/feat-*) so existing repos keep working without config.
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const cfgPath = path.join(dir, '.browzer', 'config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const wf = cfg?.workflow ?? {};
        return {
          root: dir,
          featRoot: wf.featRoot ?? 'docs/browzer',
          featPrefix: wf.featPrefix ?? 'feat-',
        };
      } catch {
        return { root: dir, featRoot: 'docs/browzer', featPrefix: 'feat-' };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readCurrentStepId(cwd) {
  try {
    const wfCfg = readWorkflowConfig(cwd);
    if (!wfCfg) return '';
    const featRoot = path.join(wfCfg.root, wfCfg.featRoot);
    if (!fs.existsSync(featRoot)) return '';
    const entries = fs
      .readdirSync(featRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(wfCfg.featPrefix));
    let latest = null;
    for (const e of entries) {
      const wf = path.join(featRoot, e.name, 'workflow.json');
      try {
        const stat = fs.statSync(wf);
        if (!latest || stat.mtimeMs > latest.mtimeMs)
          latest = { wf, mtimeMs: stat.mtimeMs };
      } catch {}
    }
    if (!latest) return '';
    const data = JSON.parse(fs.readFileSync(latest.wf, 'utf8'));
    const stepId = String(
      data?.currentStepId ?? data?.config?.currentStepId ?? '',
    ).trim();
    if (!stepId) return '';

    // Resolve the step's status. If the currentStepId points at a step
    // that no longer exists (out-of-band edit) OR at a terminal-status
    // step (workflow finished), suppress the stamp so cross-session
    // traffic doesn't get tagged with a stale step-id.
    const steps = Array.isArray(data?.steps) ? data.steps : [];
    const step = steps.find((s) => s?.stepId === stepId);
    if (!step) return '';
    if (TERMINAL_STEP_STATUSES.has(String(step?.status ?? ''))) return '';

    return stepId;
  } catch {
    return '';
  }
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
// Banner suppression (R-13): when BROWZER_LLM is already truthy in the
// incoming shell environment, the prefix is still injected (the flag is
// needed for the CLI), but additionalContext is omitted to prevent banner
// spam on every subsequent browzer call within the same session.
{
  const browzerCmdRe = /^\s*browzer(\s|$)/;
  if (browzerCmdRe.test(cmd)) {
    const alreadyHasEnv = /(^|\s)BROWZER_LLM=/.test(cmd);
    const alreadyHasFlag = /(^|\s)--llm(\s|=|$)/.test(cmd);
    const wrappedSubshell = /^\s*[({]/.test(cmd);
    if (!alreadyHasEnv && !alreadyHasFlag && !wrappedSubshell) {
      const stepId = readCurrentStepId(input?.cwd ?? process.cwd());
      const alreadyHasStepEnv = /(^|\s)BROWZER_WORKFLOW_STEP_ID=/.test(cmd);
      const stepPrefix =
        stepId && !alreadyHasStepEnv
          ? `BROWZER_WORKFLOW_STEP_ID=${stepId} `
          : '';
      const newCmd = `BROWZER_LLM=1 ${stepPrefix}${cmd.replace(/^\s+/, '')}`;

      // R-13: suppress banner when BROWZER_LLM is already truthy in the
      // incoming environment — the rewrite still happens (the CLI needs the
      // flag on every isolated shell call) but the context line is omitted
      // so repeated browzer invocations don't spam the conversation.
      // Note: treat '0' and 'false' as falsy (shell convention), not just
      // empty string. Boolean('0') is true in JS, so we check explicitly.
      const rawEnv = process.env.BROWZER_LLM ?? '';
      const envAlreadySet =
        rawEnv.length > 0 && rawEnv !== '0' && rawEnv !== 'false';
      const ctx = envAlreadySet
        ? undefined
        : 'Browzer prefixed BROWZER_LLM=1 to suppress per-mutation audit telemetry and correlate workflow traces (override: BROWZER_LLM=0 or --llm=0).';

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
