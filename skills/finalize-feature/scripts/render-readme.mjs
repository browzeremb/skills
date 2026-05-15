#!/usr/bin/env node
/**
 * render-readme.mjs — assemble README.md from all phase artefacts
 *
 * Reads every artefact under docs/browzer/<feat>/staging/ (gitignored) and
 * writes the structured README to docs/browzer/<feat>/README.md (the only
 * committed artefact) per ${CLAUDE_SKILL_DIR}/template.md.
 *
 * Usage: node render-readme.mjs <featureId>
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function die(msg, code = 1) {
  process.stderr.write(`render-readme: ${msg}\n`);
  process.exit(code);
}

function atomicWrite(path, content) {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function parseFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

function get(fm, re, def = '') {
  return (fm.match(re) || [])[1] ?? def;
}

// Extract the body of a top-level YAML key from a frontmatter string. Returns
// the lines between `<key>:` and the next column-0 alpha line (or end-of-fm).
// Used in place of regex-with-lookahead to avoid the JS `\Z` non-anchor trap.
function extractYamlBlock(fm, key) {
  const lines = fm.split('\n');
  const startIdx = lines.findIndex((l) => l === `${key}:`);
  if (startIdx === -1) return '';
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^[a-zA-Z]/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

function readPrd(stagingDir) {
  const p = join(stagingDir, 'PRD.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const fm = parseFm(text);
  const title =
    get(fm, /^title:\s*"?([^"\n]+?)"?$/m) ||
    get(fm, /^featureName:\s*"?([^"\n]+?)"?$/m) ||
    'Untitled feature';
  // originalRequest may be a block scalar — try multi-line first
  let originalRequest = '';
  const blockMatch = fm.match(/^originalRequest:\s*\|\n((?:^\s{2,}.*\n?)+)/m);
  if (blockMatch) {
    originalRequest = blockMatch[1]
      .split('\n')
      .map((l) => l.replace(/^ {2}/, ''))
      .join('\n')
      .trim();
  } else {
    originalRequest = get(fm, /^originalRequest:\s*"?([^"\n]+?)"?$/m);
  }
  // Deploy notes / out-of-scope — look in body for sections
  const deployNotes =
    extractListSection(text, /^## Deploy notes$/m) ||
    extractListSection(text, /^## Operational notes$/m) ||
    [];
  const outOfScope =
    extractListSection(text, /^## Out of scope$/m) ||
    extractListSection(text, /^## Non-goals$/m) ||
    [];
  return { title, originalRequest, deployNotes, outOfScope };
}

// Resolve the original-request text via a three-tier fallback. The empty
// `> ` block in RETRO §2.2 / R5 was caused by treating PRD.originalRequest as
// the only source — when its parse silently returned empty, the render
// produced an unreadable block quote with no content. Now: PRD →
// BRIEF.md verbatim → visible sentinel. Always returns a non-empty string.
function resolveOriginalRequest(stagingDir, prdOriginalRequest) {
  const trimmed = (prdOriginalRequest || '').trim();
  if (trimmed.length > 0) return trimmed;
  const briefPath = join(stagingDir, 'BRIEF.md');
  if (existsSync(briefPath)) {
    const briefText = readFileSync(briefPath, 'utf8');
    // Strip frontmatter when present so the block quote isn't poluted by YAML.
    const briefBody = briefText.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    if (briefBody.length > 0) return briefBody;
  }
  return '*(operator did not record an original request)*';
}

function extractListSection(text, headingRe) {
  const m = text.match(headingRe);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const nextHead = rest.search(/^## /m);
  const block = nextHead === -1 ? rest : rest.slice(0, nextHead);
  const items = block
    .split('\n')
    .filter((l) => /^- /.test(l))
    .map((l) => l.replace(/^- /, '').trim());
  return items;
}

// Extract every bullet under a markdown H3 (`### <heading>`) and stop at the
// next H3, the next H2, or end-of-file. Robust to blank lines immediately
// after the heading (which broke the previous regex-based extractor). Strips
// surrounding backticks. Filters out `(none)` sentinels.
function extractH3Bullets(text, heading) {
  const idx = text.indexOf(`### ${heading}`);
  if (idx === -1) return [];
  const after = text.slice(idx + `### ${heading}`.length);
  const nextHead = after.search(/^(### |## )/m);
  const block = nextHead === -1 ? after : after.slice(0, nextHead);
  return block
    .split('\n')
    .filter((l) => /^- /.test(l) && !/^- \(none\b/.test(l))
    .map((l) => (l.match(/^- `?([^`]+?)`?\s*$/) || [])[1])
    .filter(Boolean);
}

function readAcceptance(stagingDir) {
  const p = join(stagingDir, 'ACCEPTANCE.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const fm = parseFm(text);
  const verdict = get(fm, /^verdict:\s*(\S+)/m, 'unknown');
  const mode = get(fm, /^mode:\s*(\S+)/m, 'unknown');
  // Parse perAcVerdict[] roughly — collect acId / verdict / evidence triples
  const acRows = [];
  const acBlock = fm.match(/^perAcVerdict:\n([\s\S]*?)(?=\n[a-z]|\n---$)/m);
  if (acBlock) {
    const lines = acBlock[1].split('\n');
    let cur = null;
    for (const l of lines) {
      const acId = l.match(/^\s*- acId:\s*(AC-\d+)/);
      if (acId) {
        if (cur) acRows.push(cur);
        cur = { acId: acId[1], verdict: '', evidence: '' };
        continue;
      }
      if (cur) {
        const v = l.match(/^\s+verdict:\s*(\S+)/);
        if (v) cur.verdict = v[1];
        const e = l.match(/^\s+evidence:\s*"?(.+?)"?$/);
        if (e) cur.evidence = e[1];
      }
    }
    if (cur) acRows.push(cur);
  }
  return { verdict, mode, acRows };
}

function readCompletedTasks(stagingDir) {
  const out = [];
  for (const e of readdirSync(stagingDir)) {
    if (!/^TASK_\d+\.completed\.md$/.test(e)) continue;
    const text = readFileSync(join(stagingDir, e), 'utf8');
    const fm = parseFm(text);
    const taskId = e.replace('.completed.md', '');
    const title = get(fm, /^title:\s*"?([^"\n]+?)"?$/m) || '(no title)';
    const filesModified = extractH3Bullets(text, 'Files modified');
    const fileCount = filesModified.length;
    const filesTrunc =
      filesModified.slice(0, 3).join(', ') +
      (fileCount > 3 ? ` +${fileCount - 3} more` : '');
    out.push({ taskId, title, filesModified: filesTrunc || '(no files)' });
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function readTechDebt(stagingDir) {
  const out = [];
  for (const e of readdirSync(stagingDir)) {
    if (!/^FIX_F-\d+\.tech_debt\.md$/.test(e)) continue;
    const fm = parseFm(readFileSync(join(stagingDir, e), 'utf8'));
    out.push({
      findingId: get(fm, /^findingId:\s*(\S+)/m),
      severity: get(fm, /^severity:\s*(\S+)/m),
      subtype: get(fm, /^techDebtSubtype:\s*(\S+)/m),
      file: e,
    });
  }
  return out;
}

function readOperatorActions(acceptanceText) {
  if (!acceptanceText) return [];
  const fm = parseFm(acceptanceText);
  const block = fm.match(
    /^operatorActionsRequested:\n([\s\S]*?)(?=\n[a-z]|\n---$)/m,
  );
  if (!block) return [];
  const items = [];
  let cur = null;
  for (const l of block[1].split('\n')) {
    const id = l.match(/^\s*- id:\s*(\S+)/);
    if (id) {
      if (cur) items.push(cur);
      cur = { id: id[1], kind: '', description: '' };
      continue;
    }
    if (cur) {
      const k = l.match(/^\s+kind:\s*(\S+)/);
      if (k) cur.kind = k[1];
      const d = l.match(/^\s+description:\s*"?(.+?)"?$/);
      if (d) cur.description = d[1];
    }
  }
  if (cur) items.push(cur);
  return items;
}

function readExplorationBlast(stagingDir) {
  const p = join(stagingDir, 'EXPLORATION.md');
  if (!existsSync(p)) return [];
  const fm = parseFm(readFileSync(p, 'utf8'));
  const reverseDepsBlock = fm.match(
    /^\s+reverseDeps:\n([\s\S]*?)(?=\n\s{0,4}[a-z]|\n---$)/m,
  );
  if (!reverseDepsBlock) return [];
  const items = [];
  for (const l of reverseDepsBlock[1].split('\n')) {
    const m = l.match(/^\s+-\s+(\S+)/);
    if (m && items.length < 5) items.push(m[1]);
  }
  return items;
}

// Parse the `findings:` array out of CODE_REVIEW.md frontmatter. Each entry
// has id / severity / lane / file / title / fix. Block scalars (`description:
// |`) are intentionally NOT captured — the README only needs the one-line
// title + the per-finding resolution from the matching FIX file.
function readCodeReview(stagingDir) {
  const p = join(stagingDir, 'CODE_REVIEW.md');
  if (!existsSync(p))
    return { findings: [], byId: new Map(), totalFindings: 0, sev: {} };
  const fm = parseFm(readFileSync(p, 'utf8'));
  const totalFindings = parseInt(get(fm, /^totalFindings:\s*(\d+)/m, '0'), 10);
  const sev = {
    high: parseInt(get(fm, /^\s+high:\s*(\d+)/m, '0'), 10),
    medium: parseInt(get(fm, /^\s+medium:\s*(\d+)/m, '0'), 10),
    low: parseInt(get(fm, /^\s+low:\s*(\d+)/m, '0'), 10),
  };
  const body = extractYamlBlock(fm, 'findings');
  if (!body) return { findings: [], byId: new Map(), totalFindings, sev };
  const findings = [];
  let cur = null;
  let inBlock = null;
  for (const line of body.split('\n')) {
    const idMatch = line.match(/^ {2}- id:\s*(F-\d+)/);
    if (idMatch) {
      if (cur) findings.push(cur);
      cur = {
        id: idMatch[1],
        severity: '',
        lane: '',
        file: '',
        line: '',
        title: '',
        fix: '',
      };
      inBlock = null;
      continue;
    }
    if (!cur) continue;
    if (inBlock && /^ {4}[a-zA-Z]+:/.test(line)) inBlock = null;
    const kv = line.match(/^ {4}(\w+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2];
      if (val === '|' || val === '>') {
        inBlock = key;
        continue;
      }
      const cleaned = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (key in cur) cur[key] = cleaned;
    }
  }
  if (cur) findings.push(cur);
  const byId = new Map(findings.map((f) => [f.id, f]));
  return { findings, byId, totalFindings, sev };
}

// Glob FIX_F-*.completed.md and parse frontmatter + `### Files modified`.
function readFixes(stagingDir) {
  const out = [];
  for (const e of readdirSync(stagingDir)) {
    if (!/^FIX_F-\d+\.completed\.md$/.test(e)) continue;
    const text = readFileSync(join(stagingDir, e), 'utf8');
    const fm = parseFm(text);
    const findingId = get(fm, /^findingId:\s*(F-\d+)/m);
    const outcome = get(fm, /^outcome:\s*(\S+)/m);
    const modelAtSuccess = get(fm, /^modelAtSuccess:\s*(\S+)/m);
    const stepsUsed = get(fm, /^stepsUsed:\s*(\d+)/m, '0');
    const filesModified = extractH3Bullets(text, 'Files modified');
    out.push({
      findingId,
      outcome,
      modelAtSuccess,
      stepsUsed,
      filesModified,
    });
  }
  return out.sort((a, b) =>
    a.findingId.localeCompare(b.findingId, undefined, { numeric: true }),
  );
}

// Read TESTS.md frontmatter for the test-counts + kill-rate summary.
function readTests(stagingDir) {
  const p = join(stagingDir, 'TESTS.md');
  if (!existsSync(p)) return null;
  const fm = parseFm(readFileSync(p, 'utf8'));
  const skipped = /^skipped:\s*true/m.test(fm);
  if (skipped)
    return {
      skipped: true,
      skipReason: get(fm, /^skipReason:\s*"?(.+?)"?$/m, ''),
    };
  const runner = get(fm, /^runner:\s*(\S+)/m);
  const totalTests = parseInt(get(fm, /^\s+totalTests:\s*(\d+)/m, '0'), 10);
  const killedMutants = parseInt(
    get(fm, /^\s+killedMutants:\s*(\d+)/m, '0'),
    10,
  );
  const totalMutants = parseInt(get(fm, /^\s+totalMutants:\s*(\d+)/m, '0'), 10);
  const killRate = parseFloat(get(fm, /^\s+killRate:\s*([\d.]+)/m, '0'));
  const coverageGaps = parseInt(get(fm, /^\s+coverageGaps:\s*(\d+)/m, '0'), 10);
  const addedBody = extractYamlBlock(fm, 'testsAdded');
  const testsAddedCount = addedBody
    ? (addedBody.match(/^ {2}- testId:/gm) || []).length
    : 0;
  return {
    skipped: false,
    runner,
    totalTests,
    killedMutants,
    totalMutants,
    killRate,
    coverageGaps,
    testsAddedCount,
  };
}

// Read DOC_PATCHES.md frontmatter for the docsPatched[] list.
function readDocPatches(stagingDir) {
  const p = join(stagingDir, 'DOC_PATCHES.md');
  if (!existsSync(p)) return null;
  const fm = parseFm(readFileSync(p, 'utf8'));
  const skipped = /^skipped:\s*true/m.test(fm);
  if (skipped)
    return {
      skipped: true,
      skipReason: get(fm, /^skipReason:\s*"?(.+?)"?$/m, ''),
      patches: [],
    };
  const body = extractYamlBlock(fm, 'docsPatched');
  const patches = [];
  if (body) {
    let cur = null;
    for (const l of body.split('\n')) {
      const dp = l.match(/^ {2}- docPath:\s*"?([^"\n]+?)"?\s*$/);
      if (dp) {
        if (cur) patches.push(cur);
        cur = { docPath: dp[1], summary: '' };
        continue;
      }
      if (cur) {
        const s = l.match(/^ {4}summary:\s*"?(.+?)"?\s*$/);
        if (s) cur.summary = s[1];
      }
    }
    if (cur) patches.push(cur);
  }
  return { skipped: false, patches };
}

// Glob TASK_*.failed.md for the `## Known issues` section.
function readKnownIssues(stagingDir) {
  const out = [];
  for (const e of readdirSync(stagingDir)) {
    if (!/^TASK_\d+\.failed\.md$/.test(e)) continue;
    const fm = parseFm(readFileSync(join(stagingDir, e), 'utf8'));
    out.push({
      taskId: e.replace('.failed.md', ''),
      title: get(fm, /^title:\s*"?([^"\n]+?)"?$/m, '(no title)'),
      failureReason: get(
        fm,
        /^failureReason:\s*"?(.+?)"?\s*$/m,
        '(no failureReason recorded)',
      ),
    });
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function main() {
  const featureId = process.argv[2];
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: render-readme <featureId>', 2);
  }
  const featDir = resolve('docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  // HALT on failed tasks
  const failed = readdirSync(stagingDir).filter((e) =>
    /^TASK_\d+\.failed\.md$/.test(e),
  );
  if (failed.length > 0) {
    die(
      `HALT — ${failed.length} task(s) failed; finalize-feature requires all .completed.md: ${failed.join(', ')}`,
      3,
    );
  }

  const prd = readPrd(stagingDir) || {
    title: featureId,
    originalRequest: '(no PRD.md found)',
    deployNotes: [],
    outOfScope: [],
  };
  const acceptance = readAcceptance(stagingDir);
  const acceptanceText = existsSync(join(stagingDir, 'ACCEPTANCE.md'))
    ? readFileSync(join(stagingDir, 'ACCEPTANCE.md'), 'utf8')
    : '';
  const tasks = readCompletedTasks(stagingDir);
  const techDebt = readTechDebt(stagingDir);
  const operatorActions = readOperatorActions(acceptanceText);
  const blastRadius = readExplorationBlast(stagingDir);
  const codeReview = readCodeReview(stagingDir);
  const fixes = readFixes(stagingDir);
  const tests = readTests(stagingDir);
  const docPatches = readDocPatches(stagingDir);
  const knownIssues = readKnownIssues(stagingDir);
  const fixesByFindingId = new Map(fixes.map((f) => [f.findingId, f]));

  const verdict = acceptance?.verdict || 'unknown';
  const deferred = operatorActions.filter(
    (a) => a.kind !== 'deferred-post-merge',
  );
  const deployItems = [
    ...new Set([
      ...prd.deployNotes,
      ...operatorActions
        .filter((a) => a.kind === 'deferred-post-merge')
        .map((a) => a.description),
    ]),
  ];
  const notVerified =
    acceptance && acceptance.verdict !== 'accepted'
      ? acceptance.acRows
          .filter((r) => r.verdict !== 'pass')
          .map((r) => `**${r.acId}** [${r.verdict}] — ${r.evidence}`)
      : [];

  const lines = [];
  lines.push(`# ${prd.title}`);
  lines.push('');
  lines.push(`**Feature ID:** ${featureId}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Verdict:** ${verdict}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(
    `This feature delivered ${tasks.length} task(s) with verdict \`${verdict}\`. ${techDebt.length > 0 ? `${techDebt.length} tech-debt entr${techDebt.length === 1 ? 'y' : 'ies'} were recorded.` : 'No tech-debt entries.'} ${deferred.length > 0 ? `${deferred.length} deferred action(s) pending operator review.` : ''}`,
  );
  lines.push('');

  lines.push('## Original request');
  lines.push('');
  // Always non-empty per resolveOriginalRequest's fallback chain.
  const originalRequestText = resolveOriginalRequest(
    stagingDir,
    prd.originalRequest,
  );
  for (const l of originalRequestText.split('\n')) lines.push(`> ${l}`);
  lines.push('');

  lines.push('## Acceptance');
  lines.push('');
  if (acceptance) {
    lines.push(`Verdict: \`${verdict}\` · mode: \`${acceptance.mode}\``);
    lines.push('');
    if (acceptance.acRows.length > 0) {
      lines.push('| AC | Verdict | Evidence |');
      lines.push('| --- | --- | --- |');
      for (const r of acceptance.acRows) {
        lines.push(
          `| ${r.acId} | ${r.verdict} | ${r.evidence || '(see ACCEPTANCE.md)'} |`,
        );
      }
      lines.push('');
    }
    lines.push(
      'For full NFR + metric verdicts, see `ACCEPTANCE.md` in the feat staging folder.',
    );
  } else {
    lines.push('_(ACCEPTANCE.md not found — run /feature-acceptance first)_');
  }
  lines.push('');

  lines.push('## Tasks completed');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('_(no TASK_*.completed.md found)_');
  } else {
    lines.push('| Task | Title | Files modified |');
    lines.push('| --- | --- | --- |');
    for (const t of tasks) {
      lines.push(`| ${t.taskId} | ${t.title} | ${t.filesModified} |`);
    }
  }
  lines.push('');

  // ## Code review — always emit (the lane runs every feature).
  lines.push('## Code review');
  lines.push('');
  if (codeReview.findings.length === 0) {
    lines.push('No findings.');
  } else {
    const sevParts = [];
    if (codeReview.sev.high) sevParts.push(`${codeReview.sev.high} high`);
    if (codeReview.sev.medium) sevParts.push(`${codeReview.sev.medium} medium`);
    if (codeReview.sev.low) sevParts.push(`${codeReview.sev.low} low`);
    const sevSummary = sevParts.length > 0 ? ` (${sevParts.join(', ')})` : '';
    lines.push(
      `${codeReview.findings.length} finding(s)${sevSummary}. Each carries an inline resolution from the matching fix log.`,
    );
    lines.push('');
    for (const f of codeReview.findings) {
      const fix = fixesByFindingId.get(f.id);
      const resolution = fix
        ? `**Resolution:** ${fix.outcome} via ${fix.modelAtSuccess || 'unknown-model'} (step ${fix.stepsUsed}) — ${fix.filesModified.length} file(s) modified.`
        : `**Resolution:** unresolved (no FIX_${f.id}.completed.md present)`;
      const meta = [f.severity, f.lane].filter(Boolean).join('/');
      lines.push(`- **${f.id}** [${meta}] ${f.title}`);
      lines.push(`  - ${resolution}`);
    }
  }
  lines.push('');

  // ## Fixes applied — conditional on at least one FIX_*.completed.md.
  if (fixes.length > 0) {
    lines.push('## Fixes applied');
    lines.push('');
    for (const fix of fixes) {
      const finding = codeReview.byId.get(fix.findingId);
      const title = finding ? finding.title : '(no matching code-review entry)';
      lines.push(`- **${fix.findingId}** — ${title}`);
      const detail = [
        `model: ${fix.modelAtSuccess || 'unknown'}`,
        `step: ${fix.stepsUsed}`,
        `outcome: ${fix.outcome}`,
      ].join(' · ');
      lines.push(`  - ${detail}`);
      if (fix.filesModified.length > 0) {
        const files = fix.filesModified.map((p) => `\`${p}\``).join(', ');
        lines.push(`  - Files modified: ${files}`);
      }
    }
    lines.push('');
  }

  // ## Tests added — conditional on TESTS.md and unskipped.
  if (tests && !tests.skipped) {
    lines.push('## Tests added');
    lines.push('');
    const killPct = (tests.killRate * 100).toFixed(1);
    lines.push(
      `Runner \`${tests.runner}\` · ${tests.testsAddedCount} test entry/entries (${tests.totalTests} total) · ${tests.killedMutants}/${tests.totalMutants} mutants killed (kill rate ${killPct}%) · ${tests.coverageGaps} coverage gap(s).`,
    );
    lines.push('');
  } else if (tests && tests.skipped) {
    lines.push('## Tests added');
    lines.push('');
    lines.push(`Skipped: ${tests.skipReason || '(no skipReason recorded)'}.`);
    lines.push('');
  }

  // ## Docs patched — conditional on DOC_PATCHES.md and unskipped patches > 0.
  if (docPatches && !docPatches.skipped && docPatches.patches.length > 0) {
    lines.push('## Docs patched');
    lines.push('');
    for (const dp of docPatches.patches) {
      lines.push(`- \`${dp.docPath}\` — ${dp.summary}`);
    }
    lines.push('');
  }

  // ## Tech debt — conditional on FIX_*.tech_debt.md entries.
  if (techDebt.length > 0) {
    lines.push('## Tech debt');
    lines.push('');
    for (const t of techDebt) {
      const sub = t.subtype ? `, ${t.subtype}` : '';
      lines.push(
        `- **${t.findingId}** [${t.severity}${sub}] — see \`${t.file}\` in the feat staging folder`,
      );
    }
    lines.push('');
  }

  // ## Known issues — conditional on any TASK_*.failed.md.
  if (knownIssues.length > 0) {
    lines.push('## Known issues');
    lines.push('');
    for (const ki of knownIssues) {
      lines.push(`- **${ki.taskId}** ${ki.title} — ${ki.failureReason}`);
    }
    lines.push('');
  }

  // ## Deploy notes — conditional on operator deferred-post-merge actions or
  // PRD-declared deploy bullets.
  if (deployItems.length > 0) {
    lines.push('## Deploy notes');
    lines.push('');
    for (const d of deployItems) lines.push(`- ${d}`);
    lines.push('');
  }

  // ## Blast radius (top reverse dependencies) — top-5 from
  // EXPLORATION.featureBlastRadius / reverseDeps.
  if (blastRadius.length > 0) {
    lines.push('## Blast radius (top reverse dependencies)');
    lines.push('');
    for (const f of blastRadius) lines.push(`- \`${f}\``);
    lines.push('');
  }

  // ## Deferred actions — conditional on operator pre-commit actions.
  if (deferred.length > 0) {
    lines.push('## Deferred actions');
    lines.push('');
    for (const d of deferred) {
      lines.push(`- **${d.id}** [${d.kind}] — ${d.description}`);
    }
    lines.push('');
  }

  // ## What was NOT verified — last; flattens every non-pass AC row.
  if (notVerified.length > 0) {
    lines.push('## What was NOT verified');
    lines.push('');
    for (const n of notVerified) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '_Generated by `finalize-feature`. Re-running this skill overwrites cleanly._',
  );
  lines.push('');

  const outPath = join(featDir, 'README.md');
  const rendered = lines.join('\n');

  // Self-audit: README MUST NOT contain markdown hyperlinks pointing to
  // anything inside this feat folder. Such links resolve to 404 on a fresh
  // clone because every artefact except README.md lives under `staging/`
  // (gitignored). Plain backtick references (`ACCEPTANCE.md`) are fine
  // because they read as filenames not hyperlinks. See template.md
  // cross-reference invariant #5 + RETRO §2.2 / R5.
  const intraFeatHyperlinks = [];
  const hyperlinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  // Use matchAll() instead of exec() in a while-condition so biome's
  // no-assign-in-expressions rule stays satisfied and the iteration intent
  // reads directly.
  for (const match of rendered.matchAll(hyperlinkRe)) {
    const target = match[2].trim();
    if (target.startsWith('http://') || target.startsWith('https://')) continue;
    if (target.startsWith('#')) continue; // intra-document anchor
    // Anything else is intra-feat-folder relative — forbidden.
    if (
      /\.md(\b|#|$)/.test(target) ||
      /\.(json|yaml|yml|mjs|ts|go|sql)\b/.test(target)
    ) {
      intraFeatHyperlinks.push({ label: match[1], target });
    }
  }
  if (intraFeatHyperlinks.length > 0) {
    const list = intraFeatHyperlinks
      .map((h) => `  - [${h.label}](${h.target})`)
      .join('\n');
    die(
      `intra-feat hyperlinks detected in README — staging/ is gitignored so these resolve to 404 on a fresh clone:\n${list}\n\nInline the referenced content verbatim per template.md §Cross-reference invariants #5.`,
      4,
    );
  }

  // Self-audit: no empty block-quote lines in `## Original request`. A `>`
  // followed by no content is the RETRO §2.2 / R5 signature.
  if (/^## Original request\n\n(?:> *\n)+(?=\n## |\n---|$)/m.test(rendered)) {
    die(
      'Original-request block is empty — fallback chain (PRD.originalRequest → BRIEF.md → sentinel) failed to yield content. Investigate staging/.',
      4,
    );
  }

  atomicWrite(outPath, rendered);
  const docsPatchedCount =
    docPatches && !docPatches.skipped ? docPatches.patches.length : 0;
  console.log(
    `wrote ${outPath} (verdict=${verdict}, ${tasks.length} tasks, ${codeReview.findings.length} findings, ${fixes.length} fixes, ${docsPatchedCount} docs patched, ${techDebt.length} tech-debt)`,
  );
}

// Run main() only when invoked directly (`node render-readme.mjs <feat>`),
// not when imported by the test file.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  main();
}

export {
  extractH3Bullets,
  extractYamlBlock,
  get,
  parseFm,
  readCodeReview,
  readCompletedTasks,
  readDocPatches,
  readFixes,
  readKnownIssues,
  readTests,
};
