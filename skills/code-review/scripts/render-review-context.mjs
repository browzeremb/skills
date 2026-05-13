#!/usr/bin/env node
/**
 * render-review-context.mjs
 *
 * Reads:
 *   - git diff <merge-base>..HEAD (the authoritative diff)
 *   - docs/browzer/<feat>/TASK_*.completed.md execution logs (regex-strict
 *     parsing of `### Files modified` / `### Files created` / `### Symbols changed`
 *     per ${CLAUDE_PLUGIN_ROOT}/references/markdown-chain-output-contract.md)
 *   - browzer deps <file> --reverse --json for every changed file
 *
 * Writes:
 *   - docs/browzer/<feat>/REVIEW_CONTEXT.md
 *
 * Usage:
 *   node render-review-context.mjs <featureId>
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BLOCK_REGEX = {
  filesModified: /^- (\S+) \(\+(\d+)\/-(\d+)\)$/,
  filesCreated: /^- (\S+) \(\+(\d+)\)$/,
  symbolsChanged:
    /^- (exported|internal) (function|method|type|const|var|interface|class|struct|enum) (\S+)::(\S+) (added|removed|signature-changed|semantics-changed)$/,
  emptySentinel: /^- \(none\)$/,
};

function die(msg, code = 1) {
  process.stderr.write(`render-review-context: ${msg}\n`);
  process.exit(code);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    die(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function resolveMainBranch() {
  const r = sh('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
    allowFail: true,
  });
  if (r.status === 0) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    const probe = sh('git', ['rev-parse', '--verify', `refs/heads/${b}`], {
      allowFail: true,
    });
    if (probe.status === 0) return b;
  }
  return 'main';
}

function parseExecutionLog(body) {
  const out = { filesModified: [], filesCreated: [], symbolsChanged: [] };
  const sections = {
    'Files modified': 'filesModified',
    'Files created': 'filesCreated',
    'Symbols changed': 'symbolsChanged',
  };
  const lines = body.split('\n');
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^### (.+)$/);
    if (h) {
      cur = sections[h[1]] ?? null;
      continue;
    }
    if (!cur || !line.startsWith('- ')) continue;
    if (BLOCK_REGEX.emptySentinel.test(line)) continue;
    if (cur === 'filesModified') {
      const m = line.match(BLOCK_REGEX.filesModified);
      if (m)
        out.filesModified.push({ path: m[1], added: +m[2], removed: +m[3] });
    } else if (cur === 'filesCreated') {
      const m = line.match(BLOCK_REGEX.filesCreated);
      if (m) out.filesCreated.push({ path: m[1], lineCount: +m[2] });
    } else if (cur === 'symbolsChanged') {
      const m = line.match(BLOCK_REGEX.symbolsChanged);
      if (m)
        out.symbolsChanged.push({
          scope: m[1],
          kind: m[2],
          path: m[3],
          dottedName: m[4],
          change: m[5],
        });
    }
  }
  return out;
}

function readCompletedTasks(featDir) {
  const out = [];
  for (const e of readdirSync(featDir)) {
    if (!/^TASK_\d+\.completed\.md$/.test(e)) continue;
    const body = readFileSync(join(featDir, e), 'utf8');
    out.push({
      taskId: e.replace('.completed.md', ''),
      ...parseExecutionLog(body),
    });
  }
  return out;
}

// Minimal regex-driven scan of EXPLORATION.md frontmatter looking for the
// nested `domains[].skillsFound[].{name, relevance, installedAt}` shape.
// Returns a flat de-duplicated list. Tolerates missing file silently.
function extractSkillsFound(explorationPath) {
  if (!existsSync(explorationPath)) return [];
  const text = readFileSync(explorationPath, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const out = [];
  const seen = new Set();
  // Scan for blocks shaped `- name: <foo>` followed by relevance / installedAt
  // siblings; the YAML parser in scope-feature produces deterministic indent.
  const lines = fm[1].split('\n');
  let inSkills = false;
  let cur = null;
  for (const line of lines) {
    if (
      /^\s*skillsFound:\s*$/.test(line) ||
      /^\s*skillsFound:\s*\[\]\s*$/.test(line)
    ) {
      inSkills = /skillsFound:\s*$/.test(line); // empty inline list closes
      cur = null;
      continue;
    }
    if (!inSkills) continue;
    // A non-skill key at any indent ends the block.
    if (
      /^\s*[A-Za-z_][\w-]*:\s*/.test(line) &&
      !/^\s*-/.test(line) &&
      !/^\s+(name|relevance|installedAt):/.test(line)
    ) {
      inSkills = false;
      cur = null;
      continue;
    }
    const nameM = line.match(/^\s*-\s*name:\s*(.+)$/);
    if (nameM) {
      if (cur && !seen.has(cur.name)) {
        seen.add(cur.name);
        out.push(cur);
      }
      cur = {
        name: nameM[1].trim().replace(/^"|"$/g, ''),
        relevance: null,
        installedAt: null,
      };
      continue;
    }
    const relM = line.match(/^\s*relevance:\s*(.+)$/);
    if (relM && cur) {
      cur.relevance = relM[1].trim();
      continue;
    }
    const instM = line.match(/^\s*installedAt:\s*(.+)$/);
    if (instM && cur) {
      cur.installedAt = instM[1].trim();
      continue;
    }
  }
  if (cur && !seen.has(cur.name)) {
    seen.add(cur.name);
    out.push(cur);
  }
  return out;
}

function browzerReverseDeps(file) {
  const r = sh('browzer', ['deps', file, '--reverse', '--json'], {
    allowFail: true,
  });
  if (r.status !== 0) return { forward: [], reverse: [], reverseCount: 0 };
  try {
    const j = JSON.parse(r.stdout);
    return {
      forward: j.forward || j.imports || [],
      reverse: j.reverse || j.importedBy || [],
      reverseCount: (j.reverse || j.importedBy || []).length,
    };
  } catch {
    return { forward: [], reverse: [], reverseCount: 0 };
  }
}

function main() {
  const featureId = process.argv[2];
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die(`usage: render-review-context <featureId>`, 2);
  }
  const featDir = resolve('docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);

  const mainBranch = resolveMainBranch();
  const diffBase = sh('git', ['merge-base', 'HEAD', mainBranch]).stdout.trim();
  if (!diffBase) die('cannot resolve merge-base', 1);
  const headSha = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  // When HEAD == merge-base the feature work lives in the working tree
  // (single-branch / monorepo-on-main flow). Fall back to working-tree diff
  // instead of dying — execution logs remain the authoritative source.
  const workingTreeMode = diffBase === headSha;

  // Halt on .failed.md
  const failed = readdirSync(featDir).filter((e) =>
    /^TASK_\d+\.failed\.md$/.test(e),
  );
  if (failed.length > 0) {
    die(
      `HALT — ${failed.length} task(s) failed; triage before review: ${failed.join(', ')}`,
      3,
    );
  }

  // PRD sha drift check
  const prdPath = join(featDir, 'PRD.md');
  let currentPrdSha = '';
  if (existsSync(prdPath)) {
    currentPrdSha = sh('git', ['hash-object', prdPath]).stdout.trim();
  }
  const completed = readCompletedTasks(featDir);
  if (completed.length === 0) die('no TASK_*.completed.md found', 3);

  // Skills carry-over: extract domains[].skillsFound[] from EXPLORATION.md
  // and inject into REVIEW_CONTEXT.md so the code-review SKILL body never
  // has to read EXPLORATION.md directly (closure cross-file invariant).
  // Best-effort: an absent or unparseable EXPLORATION.md yields an empty list.
  const skillsFound = extractSkillsFound(join(featDir, 'EXPLORATION.md'));

  // Aggregate changed files from execution logs (preferred) AND git diff (sanity check)
  const changedFromLogs = new Map(); // path → { added, removed, isNew }
  const createdFromLogs = new Map(); // path → { lineCount }
  const symbolsFromLogs = []; // accumulated per change
  for (const t of completed) {
    for (const f of t.filesModified) {
      const existing = changedFromLogs.get(f.path) || {
        added: 0,
        removed: 0,
        isNew: false,
      };
      changedFromLogs.set(f.path, {
        added: existing.added + f.added,
        removed: existing.removed + f.removed,
        isNew: false,
      });
    }
    for (const f of t.filesCreated) {
      createdFromLogs.set(f.path, { lineCount: f.lineCount });
    }
    for (const s of t.symbolsChanged) {
      symbolsFromLogs.push({ ...s, sourceTask: t.taskId });
    }
  }

  // workingTreeMode: diff index+working tree against HEAD, plus untracked files.
  // Otherwise: classic branch diff against the merge-base.
  const gitChangedRaw = workingTreeMode
    ? sh('git', ['diff', '--name-only', 'HEAD']).stdout.trim()
    : sh('git', ['diff', '--name-only', `${diffBase}..HEAD`]).stdout.trim();
  const untrackedRaw = workingTreeMode
    ? sh('git', ['ls-files', '--others', '--exclude-standard']).stdout.trim()
    : '';
  const gitChanged = [
    ...(gitChangedRaw ? gitChangedRaw.split('\n') : []),
    ...(untrackedRaw ? untrackedRaw.split('\n') : []),
  ];

  // Compute reverse-deps for every changed file
  const changedFiles = [];
  for (const [p, meta] of changedFromLogs) {
    const deps = browzerReverseDeps(p);
    changedFiles.push({
      path: p,
      added: meta.added,
      removed: meta.removed,
      ...deps,
    });
  }
  const createdFiles = [];
  for (const [p, meta] of createdFromLogs) {
    createdFiles.push({ path: p, lineCount: meta.lineCount });
  }

  // Render frontmatter
  const fm = {
    featureId,
    diffBase,
    mainBranch,
    prdSha: currentPrdSha,
    generatedAt: new Date().toISOString(),
    sourceTasks: completed.map((t) => t.taskId),
    changedFiles: changedFiles.map((f) => ({
      path: f.path,
      added: f.added,
      removed: f.removed,
      reverseCount: f.reverseCount,
    })),
    createdFiles,
    changedSymbols: symbolsFromLogs.map(({ sourceTask, ...rest }) => rest),
    diffOnlyFiles: gitChanged.filter(
      (p) => !changedFromLogs.has(p) && !createdFromLogs.has(p),
    ),
    skillsFound,
  };

  // Sanity warning when logs miss files git sees
  const warnings = [];
  if (fm.diffOnlyFiles.length > 0) {
    warnings.push(
      `${fm.diffOnlyFiles.length} file(s) in git diff are absent from TASK_*.completed.md execution logs — possible drift`,
    );
  }
  fm.warnings = warnings;

  // Render body
  const body = [
    '# Review context',
    '',
    workingTreeMode
      ? `Diff base: working tree vs \`HEAD\` (single-branch mode; HEAD == merge-base with \`${mainBranch}\`)`
      : `Diff base: \`${diffBase}\` (merge-base with \`${mainBranch}\`)`,
    `Generated: ${fm.generatedAt}`,
    `Source tasks: ${fm.sourceTasks.join(', ')}`,
    '',
    '## Changed files (from execution logs)',
    '',
    changedFiles.length === 0
      ? '_(none)_'
      : changedFiles
          .map(
            (f) =>
              `- \`${f.path}\` (+${f.added}/-${f.removed}) — ${f.reverseCount} reverse importer(s)`,
          )
          .join('\n'),
    '',
    '## Created files (from execution logs)',
    '',
    createdFiles.length === 0
      ? '_(none)_'
      : createdFiles
          .map((f) => `- \`${f.path}\` (+${f.lineCount} lines)`)
          .join('\n'),
    '',
    '## Changed symbols (filtered for qa-lane butterfly probe)',
    '',
    symbolsFromLogs.length === 0
      ? '_(none)_'
      : symbolsFromLogs
          .map(
            (s) =>
              `- \`${s.scope}\` \`${s.kind}\` \`${s.path}::${s.dottedName}\` — ${s.change}`,
          )
          .join('\n'),
    '',
    warnings.length > 0
      ? `## Warnings\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n`
      : '',
  ].join('\n');

  const fmYaml = ['---', renderYaml(fm), '---', '', body, ''].join('\n');
  const outPath = join(featDir, 'REVIEW_CONTEXT.md');
  writeFileSync(outPath, fmYaml, 'utf8');
  console.log(`wrote ${outPath}`);
}

function renderYaml(obj, depth = 0) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else if (typeof v[0] === 'object') {
        lines.push(`${pad}${k}:`);
        for (const it of v) {
          const entries = Object.entries(it);
          if (entries.length === 0) continue;
          lines.push(
            `${pad}  - ${entries[0][0]}: ${renderScalar(entries[0][1])}`,
          );
          for (let i = 1; i < entries.length; i++) {
            lines.push(
              `${pad}    ${entries[i][0]}: ${renderScalar(entries[i][1])}`,
            );
          }
        }
      } else {
        lines.push(`${pad}${k}: [${v.map(renderScalar).join(', ')}]`);
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${pad}${k}:`);
      lines.push(renderYaml(v, depth + 1));
    } else {
      lines.push(`${pad}${k}: ${renderScalar(v)}`);
    }
  }
  return lines.join('\n');
}

function renderScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

main();
