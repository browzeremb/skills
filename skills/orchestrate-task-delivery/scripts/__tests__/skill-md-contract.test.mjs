// Contract tests for orchestrate-task-delivery/SKILL.md.
//
// Purpose: progressive-disclosure refactors of this skill body must not
// silently drop routing keys, break references, or strip the state-machine
// loop. The orchestrator is the entry point for every non-trivial feature;
// regressions here are systemic.
//
// What we lock in (must hold in body OR in a referenced doc, since the agent
// follows links lazily):
//   1. Frontmatter integrity — name, description still present; description
//      keeps the canonical orchestrator trigger vocabulary.
//   2. Routing surface — every `nextPhase` token the orchestrator emits
//      (brainstorming, generate-prd, scope-feature, generate-task, execute-task,
//      code-review, receiving-code-review, write-tests, update-docs,
//      feature-acceptance, finalize-feature, commit) is mentioned in the
//      visible-to-the-agent surface (body + first-hop references).
//   3. State-machine loop — `detect-phase.mjs` invocation + exit-code semantics
//      0 / 3 / 4 / 5 are documented in body (these literally drive the loop,
//      so they MUST stay inline — not lazy-loaded).
//   4. Pipeline modes — `full` and `inline-with-review` discoverable somewhere.
//   5. Reference integrity — every `${CLAUDE_SKILL_DIR}/references/*` and
//      `${CLAUDE_PLUGIN_ROOT}/references/*` path mentioned in body resolves
//      on disk.
//   6. Script integrity — `scripts/detect-phase.mjs` and `scripts/append-trace.mjs`
//      exist (the body invokes both directly).
//
// We also emit a structural snapshot to /tmp so progressive-disclosure
// authors can see the body-size delta pre vs post. The snapshot is
// diagnostic only — not asserted — but lets the author confirm the refactor
// actually shrunk the body.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', '..');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');
const PLUGIN_ROOT = resolve(SKILL_ROOT, '..', '..');

const RAW = readFileSync(SKILL_MD, 'utf8');

/** Split frontmatter from body. */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, 'SKILL.md must start with YAML frontmatter');
  return { frontmatter: m[1], body: m[2] };
}

/** Resolve a path that uses ${CLAUDE_SKILL_DIR} or ${CLAUDE_PLUGIN_ROOT}. */
function resolveTokenPath(token) {
  if (token.startsWith('${CLAUDE_SKILL_DIR}/')) {
    return join(SKILL_ROOT, token.replace('${CLAUDE_SKILL_DIR}/', ''));
  }
  if (token.startsWith('${CLAUDE_PLUGIN_ROOT}/')) {
    return join(PLUGIN_ROOT, token.replace('${CLAUDE_PLUGIN_ROOT}/', ''));
  }
  return null;
}

/** Read body + every first-hop reference so we can search "agent's visible surface". */
function gatherVisibleSurface(body) {
  const surface = [body];
  const refTokens = [
    ...body.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/references\/[^\s`)]+/g),
    ...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/references\/[^\s`)]+/g),
  ].map((m) => m[0].replace(/[.,;:]$/, ''));
  const seen = new Set();
  for (const token of refTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const p = resolveTokenPath(token);
    if (p && existsSync(p)) surface.push(readFileSync(p, 'utf8'));
  }
  return { joined: surface.join('\n'), refTokens: [...seen] };
}

const { frontmatter, body } = splitFrontmatter(RAW);
const { joined: VISIBLE, refTokens: REF_TOKENS } = gatherVisibleSurface(body);

describe('SKILL.md — frontmatter integrity', () => {
  it('declares name = orchestrate-task-delivery', () => {
    assert.match(frontmatter, /^name:\s*orchestrate-task-delivery\s*$/m);
  });

  it('keeps canonical orchestrator trigger vocabulary in description', () => {
    // These are the trigger phrases the harness/operator routes on.
    // If we drop ANY of them we lose orchestrator triggering coverage.
    const required = [
      'Master orchestrator',
      'markdown-chains',
      'state machine',
      'resume',
    ];
    for (const phrase of required) {
      assert.ok(
        frontmatter.includes(phrase),
        `frontmatter.description must mention "${phrase}"`,
      );
    }
  });

  it('declares argument-hint with featureId placeholder', () => {
    assert.match(frontmatter, /^argument-hint:\s*"?<featureId/m);
  });
});

describe('SKILL.md — state-machine loop stays inline', () => {
  // These bytes literally drive the loop. If they move to a reference,
  // the orchestrator does not know how to execute the loop on iteration 1
  // (it cannot lazy-load what it does not know exists). So they MUST be
  // in the body, not behind a Read.
  it('invokes detect-phase.mjs in body', () => {
    assert.ok(
      /detect-phase\.mjs/.test(body),
      'body must invoke detect-phase.mjs (the loop driver)',
    );
  });

  it('invokes append-trace.mjs in body', () => {
    assert.ok(
      /append-trace\.mjs/.test(body),
      'body must invoke append-trace.mjs (trace appender)',
    );
  });

  it('documents exit-code semantics 0 / 3 / 4 / 5 in body', () => {
    // Each exit code is a different orchestrator action. The agent uses
    // the body's mapping in real time — these cannot lazy-load.
    for (const code of ['0', '3', '4', '5']) {
      // Match either a table row or a shell test on the code.
      const re = new RegExp(
        `(?:\\|\\s*${code}\\s*\\||EXIT.*=.*"?${code}"?|exit code ${code})`,
      );
      assert.ok(
        re.test(body),
        `body must document detect-phase exit code ${code}`,
      );
    }
  });

  it('documents HALT and DONE terminal states in body', () => {
    assert.ok(/HALT/.test(body), 'body must mention HALT terminal');
    assert.ok(/DONE/.test(body), 'body must mention DONE terminal');
  });
});

describe('SKILL.md — every routing key stays discoverable', () => {
  // Source of truth: the state-machine.md transition table. We probe
  // against the "visible surface" (body + first-hop refs) because some
  // routing details may be lazy-loaded — but at minimum, the dispatch
  // mapping has to exist where the agent can reach it without recursion.
  const ROUTING_KEYS = [
    'brainstorming',
    'generate-prd',
    'scope-feature',
    'generate-task',
    'execute-task',
    'code-review',
    'receiving-code-review',
    'write-tests',
    'update-docs',
    'feature-acceptance',
    'finalize-feature',
    'commit',
  ];

  for (const key of ROUTING_KEYS) {
    it(`mentions routing key "${key}"`, () => {
      assert.ok(
        VISIBLE.includes(key),
        `routing key "${key}" missing from body + first-hop refs — orchestrator cannot dispatch it`,
      );
    });
  }

  it('mentions pipeline modes "full" and "inline-with-review"', () => {
    assert.ok(
      /\bfull\b/.test(VISIBLE) && /inline-with-review/.test(VISIBLE),
      'both pipeline modes must remain discoverable on the visible surface',
    );
  });
});

describe('SKILL.md — every referenced path resolves', () => {
  for (const token of REF_TOKENS) {
    it(`reference exists: ${token}`, () => {
      const p = resolveTokenPath(token);
      assert.ok(p, `unrecognised reference token: ${token}`);
      assert.ok(
        existsSync(p),
        `reference points to a missing file: ${token} -> ${p}`,
      );
    });
  }

  it('expected first-hop references are still listed', () => {
    // These are the cross-skill anchors the orchestrator points to.
    // If we drop any, downstream skills lose their canonical contract.
    const required = [
      '${CLAUDE_SKILL_DIR}/references/state-machine.md',
      '${CLAUDE_SKILL_DIR}/references/intent-detection.md',
      '${CLAUDE_PLUGIN_ROOT}/references/feature-folder-layout.md',
      '${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md',
      '${CLAUDE_PLUGIN_ROOT}/references/receipts-protocol.md',
      '${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md',
      '${CLAUDE_PLUGIN_ROOT}/references/dispatch-prompt-template.md',
      '${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md',
      '${CLAUDE_PLUGIN_ROOT}/references/skills-discovery-limits.md',
    ];
    for (const ref of required) {
      assert.ok(
        body.includes(ref),
        `body must keep canonical reference: ${ref}`,
      );
    }
  });
});

describe('SKILL.md — driver scripts on disk', () => {
  for (const script of ['detect-phase.mjs', 'append-trace.mjs']) {
    it(`scripts/${script} exists`, () => {
      assert.ok(
        existsSync(join(SKILL_ROOT, 'scripts', script)),
        `scripts/${script} must exist — body invokes it`,
      );
    });
  }
});

describe('SKILL.md — structural snapshot (diagnostic only)', () => {
  it('emits a snapshot for pre/post-refactor comparison', () => {
    const lines = RAW.split('\n');
    const bodyLines = body.split('\n');
    const h2 = (bodyLines.filter((l) => /^##\s+/.test(l)) || []).length;
    const h3 = (bodyLines.filter((l) => /^###\s+/.test(l)) || []).length;
    const codeFences = (body.match(/```/g) || []).length / 2;
    const tableRows = (body.match(/^\|/gm) || []).length;
    const refCount = REF_TOKENS.length;

    const snapshot = {
      capturedAt: new Date().toISOString(),
      totalLines: lines.length,
      bodyLines: bodyLines.length,
      h2Sections: h2,
      h3Sections: h3,
      codeFences,
      tableRows,
      referenceCount: refCount,
      bodyByteSize: Buffer.byteLength(body, 'utf8'),
    };

    const out = join(
      tmpdir(),
      'orchestrate-task-delivery-skill-md-snapshot.json',
    );
    writeFileSync(out, JSON.stringify(snapshot, null, 2));
    // Always passes — this exists so a CI run can diff snapshots across
    // refactors. The author reads /tmp/...snapshot.json after each run.
    assert.ok(snapshot.bodyLines > 0);
    // Soft floor — body should never collapse to nothing.
    assert.ok(
      snapshot.bodyLines >= 60,
      `body collapsed to ${snapshot.bodyLines} lines — too aggressive a cut`,
    );
  });
});
