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

test('hooks.json: browzer-rewrite-bash declares an `if` filter to avoid Node spawns on unrelated commands', () => {
  const group = cfg.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
  const entry = group.hooks.find((h) =>
    /browzer-rewrite-bash\.mjs/.test(h.command ?? ''),
  );
  assert.ok(entry, 'browzer-rewrite-bash entry must exist in PreToolUse:Bash');
  assert.ok(
    typeof entry.if === 'string' && entry.if.length > 0,
    'browzer-rewrite-bash must declare `if` so the host skips spawn for ls/mkdir/rm/cp/echo/find/grep/rg/curl/cd/etc.',
  );

  const required = [
    'Bash(browzer *)', // BROWZER_LLM=1 injection
    'Bash(git *)', // run-proxy compression
    'Bash(pnpm *)',
    'Bash(npx *)',
    'Bash(vitest *)',
    'Bash(go test*)',
    'Bash(cargo test*)',
    'Bash(biome *)',
    'Bash(tsc *)',
    'Bash(cat *)', // read-proxy for large files
    'Bash(head *)',
    'Bash(tail *)',
    'Bash(less *)',
    'Bash(more *)',
  ];
  for (const trigger of required) {
    assert.ok(
      entry.if.includes(trigger),
      `browzer-rewrite-bash \`if\` must include ${trigger}; got: ${entry.if}`,
    );
  }
});

test('hooks.json: browzer-sync-on-push is registered exactly once with all push variants', () => {
  const group = cfg.hooks.PostToolUse.find((g) => g.matcher === 'Bash');
  const entries = group.hooks.filter((h) =>
    /browzer-sync-on-push\.mjs/.test(h.command ?? ''),
  );
  assert.equal(
    entries.length,
    1,
    'browzer-sync-on-push must be a single consolidated entry (was 7 — collapsed via `|`-alternated `if`)',
  );

  const required = [
    'Bash(git push*)',
    'Bash(gh pr create*)',
    'Bash(gh pr push*)',
    'Bash(gh repo sync*)',
    'Bash(glab mr create*)',
    'Bash(glab mr push*)',
    'Bash(glab repo push*)',
  ];
  const if_ = entries[0].if ?? '';
  for (const trigger of required) {
    assert.ok(
      if_.includes(trigger),
      `browzer-sync-on-push \`if\` must include ${trigger}; got: ${if_}`,
    );
  }
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
  ['PostToolUse', 'Bash', 'browzer-sync-on-push.mjs'],
  ['PostToolUse', 'Bash', 'browzer-track-cli.mjs'],
  ['PostToolUse', 'Bash', 'browzer-track-wasted.mjs'],
  // PostToolUse(Edit|Write) — auto-format blocks up to 10s; sync re-indexer is detached
  ['PostToolUse', 'Edit|Write', 'auto-format.mjs'],
  ['PostToolUse', 'Edit|Write', 'incremental-sync.mjs'],
  // SubagentStop — telemetry-only file append
  ['SubagentStop', null, 'subagent-stop-telemetry.mjs'],
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
    'Stop should have one matcher group with both quality-gate-stop and browzer-session-summary (was 2 — collapsed)',
  );
});
