import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_JSON = join(HERE, '..', 'hooks.json');

const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));

// ──────────────────────────────────────────────────────────────────
// Matcher / `if` shape (the original consolidation invariants)
// ──────────────────────────────────────────────────────────────────

test('hooks.json: PreToolUse Bash matcher uses tool-name "Bash"', () => {
  const groups = cfg.hooks.PreToolUse.filter((g) => g.matcher === 'Bash');
  assert.equal(
    groups.length,
    1,
    'expected exactly one PreToolUse matcher group with tool-name "Bash"',
  );
});

test('hooks.json: rewrite-bash.sh is registered in PreToolUse:Bash and has no if-clause combinators', () => {
  // The consolidated Go-backed shape has a SINGLE rewrite-bash.sh handler with
  // no per-subcommand `if` expansion. All subcommand dispatch now lives inside
  // `browzer hook rewrite-bash` in the Go CLI.
  const group = cfg.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
  assert.ok(group, 'PreToolUse must have a Bash matcher group');
  const entry = group.hooks.find((h) =>
    /rewrite-bash\.sh/.test(h.command ?? ''),
  );
  assert.ok(entry, 'rewrite-bash.sh must be registered in PreToolUse:Bash');
  // No if-clause on the consolidated handler.
  assert.ok(
    !entry.if || !/[|&]/.test(entry.if),
    `rewrite-bash.sh must not use multi-clause if combinators: ${entry.if}`,
  );
});

test('hooks.json: sync-on-push.sh is registered in PostToolUse:Bash and has no if-clause combinators', () => {
  // The consolidated Go-backed shape has a SINGLE sync-on-push.sh handler with
  // no per-variant `if` expansion. All push-variant dispatch now lives inside
  // `browzer hook sync-on-push` in the Go CLI.
  const group = cfg.hooks.PostToolUse.find((g) => g.matcher === 'Bash');
  assert.ok(group, 'PostToolUse must have a Bash matcher group');
  const entry = group.hooks.find((h) =>
    /sync-on-push\.sh/.test(h.command ?? ''),
  );
  assert.ok(entry, 'sync-on-push.sh must be registered in PostToolUse:Bash');
  // No if-clause on the consolidated handler.
  assert.ok(
    !entry.if || !/[|&]/.test(entry.if),
    `sync-on-push.sh must not use multi-clause if combinators: ${entry.if}`,
  );
});

test('hooks.json: no `if` filter uses multi-clause OR/AND combinators (Claude Code rejects them)', () => {
  // Pin the global invariant: claude-hooks.md:453 — "The `if` field holds
  // exactly one permission rule. There is no `&&`, `||`, or list syntax
  // for combining rules." Multi-clause filters silently fail to match
  // atomic commands; fix them by splitting into one handler per clause.
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        if (typeof h.if !== 'string') continue;
        if (/[|&]/.test(h.if)) {
          offenders.push(
            `[${eventName}/${group.matcher ?? '*'}] ${h.command ?? '<unknown>'} if="${h.if}"`,
          );
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `multi-clause \`if\` filters detected (must be split into one handler per clause):\n  ${offenders.join('\n  ')}`,
  );
});

test('hooks.json: every `if` filter references a tool name supported by its event matcher', () => {
  const visit = (events) => {
    for (const [eventName, groups] of Object.entries(events ?? {})) {
      for (const group of groups ?? []) {
        const matcher = group.matcher ?? '*';
        for (const h of group.hooks ?? []) {
          if (!h.if) continue;
          const toolsInIf = [...h.if.matchAll(/(\w+)\(/g)].map((m) => m[1]);
          for (const tool of toolsInIf) {
            if (matcher === '*' || matcher === '') continue;
            const matcherTools = matcher.split('|');
            assert.ok(
              matcherTools.some((mt) => mt === tool || mt.includes(tool)),
              `[${eventName}] hook with if="${h.if}" references tool "${tool}" but its matcher is "${matcher}"`,
            );
          }
        }
      }
    }
  };
  visit(cfg.hooks);
});

// ──────────────────────────────────────────────────────────────────
// async: true on pure-telemetry / fire-and-forget hooks
// ──────────────────────────────────────────────────────────────────

const ASYNC_REQUIRED = [
  // PostToolUse(Bash) — pure telemetry, no decision output
  ['PostToolUse', 'Bash', 'sync-on-push.sh'],
  ['PostToolUse', 'Bash', 'track-cli.sh'],
  ['PostToolUse', 'Bash', 'track-wasted.sh'],
  // PostToolUse(Edit|Write) — sync re-indexer is detached
  ['PostToolUse', 'Edit|Write', 'incremental-sync.sh'],
  // PostToolUse(Read|Grep|Glob) — pure trackEvent telemetry, fires every call
  ['PostToolUse', 'Read', 'postuse-read.sh'],
  ['PostToolUse', 'Grep', 'postuse-grep.sh'],
  ['PostToolUse', 'Glob', 'postuse-glob.sh'],
  // SubagentStop — telemetry-only file append
  ['SubagentStop', null, 'subagent-stop.sh'],
];

for (const [event, matcher, script] of ASYNC_REQUIRED) {
  test(`hooks.json: ${event}${matcher ? `(${matcher})` : ''} → ${script} declares async: true`, () => {
    const groups = cfg.hooks[event] ?? [];
    const group = matcher
      ? groups.find((g) => g.matcher === matcher)
      : groups[0];
    assert.ok(group, `event group not found: ${event} matcher=${matcher}`);
    const entry = group.hooks.find((h) =>
      new RegExp(script.replace('.', '\\.')).test(h.command ?? ''),
    );
    assert.ok(entry, `${script} not found in ${event} group`);
    assert.equal(
      entry.async,
      true,
      `${script} must declare async: true (telemetry / fire-and-forget — must not block the tool loop)`,
    );
  });
}

// ──────────────────────────────────────────────────────────────────
// timeout declared on every hook (bound worst-case wall time)
// ──────────────────────────────────────────────────────────────────

test('hooks.json: every hook handler declares an explicit timeout', () => {
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        if (typeof h.timeout !== 'number' || !Number.isFinite(h.timeout)) {
          offenders.push(
            `[${eventName}/${group.matcher ?? '*'}] ${h.command ?? '<unknown>'}`,
          );
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `hooks without timeout (must declare one to bound runaway guards):\n  ${offenders.join('\n  ')}`,
  );
});

test('hooks.json: timeouts are within sane bounds (1..120s)', () => {
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        if (typeof h.timeout !== 'number') continue;
        if (h.timeout < 1 || h.timeout > 120) {
          offenders.push(
            `[${eventName}/${group.matcher ?? '*'}] ${h.command ?? '<unknown>'} timeout=${h.timeout}`,
          );
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `timeouts must be within 1..120s (Claude Code default is 600s — too lax for fast guards):\n  ${offenders.join('\n  ')}`,
  );
});

// ──────────────────────────────────────────────────────────────────
// Stop event uses a single matcher group (cosmetic — fewer parser passes)
// ──────────────────────────────────────────────────────────────────

test('hooks.json: Stop event uses a single consolidated matcher group', () => {
  assert.equal(
    cfg.hooks.Stop?.length,
    1,
    'Stop should have one matcher group hosting browzer-session-summary',
  );
});

// ──────────────────────────────────────────────────────────────────
// .sh shape invariants (regression guards for the Go-delegator migration)
// ──────────────────────────────────────────────────────────────────

test('hooks.json: every command ends with .sh (no .mjs or node invocations)', () => {
  // All hook commands must be shell wrappers (.sh). Direct node <script>.mjs
  // invocations were retired when guards moved to `browzer hook <name>`.
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        const cmd = h.command ?? '';
        if (
          !cmd.endsWith('.sh"') &&
          !cmd.endsWith(".sh'") &&
          !cmd.endsWith('.sh')
        ) {
          offenders.push(`[${eventName}/${group.matcher ?? '*'}] ${cmd}`);
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `hook commands must end with .sh (Go-delegator shape):\n  ${offenders.join('\n  ')}`,
  );
});

test('hooks.json: no command contains "node " (regression guard — no direct node invocations)', () => {
  // Direct `node <script>` invocations were retired. Commands delegate to
  // shell wrappers which in turn call `browzer hook <name>`.
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        const cmd = h.command ?? '';
        if (cmd.includes('node ')) {
          offenders.push(`[${eventName}/${group.matcher ?? '*'}] ${cmd}`);
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `hook commands must not use direct "node " invocations:\n  ${offenders.join('\n  ')}`,
  );
});

test('hooks.json: no command contains ".mjs" (regression guard — no direct .mjs references)', () => {
  // ESM guard scripts (.mjs) are no longer invoked directly from hooks.json.
  // Commands must reference .sh wrappers only.
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        const cmd = h.command ?? '';
        if (cmd.includes('.mjs')) {
          offenders.push(`[${eventName}/${group.matcher ?? '*'}] ${cmd}`);
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `hook commands must not reference .mjs scripts directly:\n  ${offenders.join('\n  ')}`,
  );
});

test('hooks.json: every command starts with "${CLAUDE_PLUGIN_ROOT}/hooks/" prefix', () => {
  // All hooks must be addressed relative to ${CLAUDE_PLUGIN_ROOT}/hooks/ so
  // they resolve correctly regardless of where the plugin is installed.
  const PREFIX = '${CLAUDE_PLUGIN_ROOT}/hooks/';
  const offenders = [];
  for (const [eventName, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        const cmd = h.command ?? '';
        // Strip surrounding quotes (the harness wraps the path in double-quotes).
        const bare = cmd.replace(/^"/, '').replace(/"$/, '');
        if (!bare.startsWith(PREFIX)) {
          offenders.push(`[${eventName}/${group.matcher ?? '*'}] ${cmd}`);
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `hook commands must start with "${PREFIX}":\n  ${offenders.join('\n  ')}`,
  );
});
