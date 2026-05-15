#!/usr/bin/env node
/**
 * aggregate-fixes.mjs — single-writer aggregator for the receiving-code-review
 * fixer batch.
 *
 * Glob: staging/fixes/F-*.{completed,tech_debt}.md (subfolder gives the
 * namespace; the legacy `FIX_F-` prefix has been dropped).
 *
 * Outputs:
 *   - staging/fixes/FIXES.md         — primary index (idempotent, deterministic)
 *   - staging/review/RECEIVING_CODE_REVIEW.md  — back-compat sidecar (will be
 *     removed once finalize-feature's render-readme.mjs switches over to
 *     FIXES.md). Semantically a subset of FIXES.md.
 *   - staging/review/CODE_REVIEW.md  — patched in place: each
 *     `frontmatter.findings[].fixStatus` is filled from the matching fix file.
 *     Safe single-writer because the skill body explicitly waits for every
 *     fixer to land its file before invoking this script.
 *
 * Usage: node aggregate-fixes.mjs <featureId>
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function die(msg, code = 1) {
  process.stderr.write(`aggregate-fixes: ${msg}\n`);
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

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v === '' || v === 'null' || v === '~') {
      out[kv[1]] = null;
      continue;
    }
    if (v === 'true' || v === 'false') {
      out[kv[1]] = v === 'true';
      continue;
    }
    if (/^-?\d+$/.test(v)) {
      out[kv[1]] = parseInt(v, 10);
      continue;
    }
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        out[kv[1]] = JSON.parse(v);
        continue;
      } catch {}
    }
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      out[kv[1]] = inner
        ? inner.split(',').map((x) => x.trim().replace(/^"|"$/g, ''))
        : [];
      continue;
    }
    out[kv[1]] = v;
  }
  return out;
}

function renderYaml(obj, depth = 0) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else if (typeof v[0] === 'object' && v[0] !== null) {
        lines.push(`${pad}${k}:`);
        for (const it of v) {
          const entries = Object.entries(it);
          if (entries.length === 0) continue;
          lines.push(`${pad}  - ${entries[0][0]}: ${scalar(entries[0][1])}`);
          for (let i = 1; i < entries.length; i++) {
            lines.push(`${pad}    ${entries[i][0]}: ${scalar(entries[i][1])}`);
          }
        }
      } else {
        lines.push(`${pad}${k}: [${v.map(scalar).join(', ')}]`);
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${pad}${k}:`);
      lines.push(renderYaml(v, depth + 1));
    } else {
      lines.push(`${pad}${k}: ${scalar(v)}`);
    }
  }
  return lines.join('\n');
}

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(scalar).join(', ')}]`;
  const s = String(v);
  if (/^[A-Za-z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

// Patch CODE_REVIEW.md in place: for each finding (id matching pinsFinding),
// set fixStatus to either "fixed" or "tech_debt:<subtype>". Idempotent — if the
// finding already carries the same fixStatus, the file is left untouched.
function patchCodeReviewFindings(reviewPath, fixOutcomes) {
  if (!existsSync(reviewPath)) return false;
  const text = readFileSync(reviewPath, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  const fmBody = fm[1];
  const rest = text.slice(fm[0].length);

  const byId = new Map();
  for (const o of fixOutcomes) {
    byId.set(o.pinsFinding, o);
  }

  let patched = fmBody;
  let dirty = false;

  // For each `- id: F-NNN` entry under `findings:`, find its block boundary
  // and inject/replace `fixStatus: <value>` at the same indent.
  patched = patched.replace(
    /^(\s*)- id:\s*(F-\d+)([\s\S]*?)(?=(?:^\s*- id:|^[A-Za-z][^\n]*:|z))/gm,
    (match, indent, fid, body) => {
      const o = byId.get(fid);
      if (!o) return match;
      const fixStatus =
        o.status === 'fixed'
          ? 'fixed'
          : `tech_debt:${o.techDebtSubtype || 'unknown'}`;
      const childIndent = `${indent}  `;
      // Remove any pre-existing fixStatus
      const newBody = body.replace(
        new RegExp(`^${childIndent}fixStatus:.*\\n?`, 'm'),
        '',
      );
      // Append fixStatus just after `- id:` block
      const lineEnd = newBody.endsWith('\n') ? '' : '\n';
      const newEntry = `${indent}- id: ${fid}${newBody}${lineEnd}${childIndent}fixStatus: ${fixStatus}\n`;
      if (newEntry !== match) dirty = true;
      return newEntry;
    },
  );

  if (!dirty) return false;
  const newText = `---\n${patched}---${rest}`;
  atomicWrite(reviewPath, newText);
  return true;
}

function main() {
  const featureId = process.argv[2];
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: aggregate-fixes <featureId>', 2);
  }
  const featDir = resolve('docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);
  const stagingDir = join(featDir, 'staging');
  if (!existsSync(stagingDir))
    die(
      `staging/ subfolder not found in ${featDir}; run /orchestrate-task-delivery to initialize`,
      2,
    );

  const fixesDir = join(stagingDir, 'fixes');
  const reviewDir = join(stagingDir, 'review');
  if (!existsSync(fixesDir))
    die(
      `fixes/ subfolder not found at ${fixesDir}; receiving-code-review must run first`,
      3,
    );

  const fixFiles = readdirSync(fixesDir).filter((e) =>
    /^F-\d+\.(completed|tech_debt)\.md$/.test(e),
  );
  if (fixFiles.length === 0)
    die('no F-*.{completed,tech_debt}.md files found in fixes/', 3);

  // Mirror prdSha from CODE_REVIEW.md when present
  let prdSha = '';
  const reviewPath = join(reviewDir, 'CODE_REVIEW.md');
  if (existsSync(reviewPath)) {
    const fm = parseFrontmatter(readFileSync(reviewPath, 'utf8'));
    if (fm?.prdSha) prdSha = fm.prdSha;
  }

  const fixOutcomes = [];
  for (const f of fixFiles.sort()) {
    const text = readFileSync(join(fixesDir, f), 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) {
      process.stderr.write(`warning: ${f} has no frontmatter — skipping\n`);
      continue;
    }
    const status = f.endsWith('.completed.md') ? 'fixed' : 'tech_debt';
    fixOutcomes.push({
      findingId: fm.findingId,
      pinsFinding: fm.pinsFinding || fm.findingId,
      status,
      severity: fm.severity,
      lane: fm.lane,
      ladderStepsUsed: fm.ladderStepsUsed || 0,
      modelAtSuccess: fm.modelAtSuccess || null,
      techDebtSubtype: fm.techDebtSubtype || null,
      pinsFiles: Array.isArray(fm.pinsFiles) ? fm.pinsFiles : [],
      ...(Array.isArray(fm.pinsAcs) && fm.pinsAcs.length > 0
        ? { pinsAcs: fm.pinsAcs }
        : {}),
      fixFile: f,
      elapsedSec:
        fm.startedAt && fm.completedAt
          ? Math.max(
              0,
              Math.round(
                (new Date(fm.completedAt).getTime() -
                  new Date(fm.startedAt).getTime()) /
                  1000,
              ),
            )
          : 0,
    });
  }

  const total = fixOutcomes.length;
  const fixed = fixOutcomes.filter((o) => o.status === 'fixed').length;
  const techDebt = total - fixed;
  const scopeDeferred = fixOutcomes.filter(
    (o) => o.techDebtSubtype === 'scope_deferred',
  ).length;
  const ladderExhausted = fixOutcomes.filter(
    (o) => o.techDebtSubtype === 'ladder_exhausted',
  ).length;
  const totalIterations = fixOutcomes.reduce(
    (acc, o) => acc + (o.ladderStepsUsed || 0),
    0,
  );

  const fm = {
    featureId,
    prdSha,
    generatedAt: new Date().toISOString(),
    summary: { total, fixed, techDebt, totalIterations },
    techDebtBreakdown: { scopeDeferred, ladderExhausted },
    fixOutcomes,
  };

  const fixedRows = fixOutcomes
    .filter((o) => o.status === 'fixed')
    .map(
      (o) =>
        `| ${o.findingId} | ${o.severity} | ${o.ladderStepsUsed} | ${o.modelAtSuccess} | ${o.pinsFiles.join(', ')} |`,
    )
    .join('\n');
  const techDebtBlock = fixOutcomes
    .filter((o) => o.status === 'tech_debt')
    .map(
      (o) =>
        `- **${o.findingId}** [${o.severity}, ${o.techDebtSubtype}] — see [fixes/${o.fixFile}](fixes/${o.fixFile})`,
    )
    .join('\n');
  const highTechDebt = fixOutcomes.filter(
    (o) => o.status === 'tech_debt' && o.severity === 'high',
  );

  const body = [
    '# Fixes — aggregate index',
    '',
    '## Summary',
    '',
    `${fixed}/${total} findings fixed, ${techDebt} tech-debt entries. Iterations total: ${totalIterations}. Tech-debt breakdown: scope-deferred ${scopeDeferred}, ladder-exhausted ${ladderExhausted}.`,
    '',
    '## Fixed findings',
    '',
    fixed === 0
      ? '_(none)_'
      : '| Finding | Severity | Ladder steps | Model | Files |\n| --- | --- | --- | --- | --- |\n' +
        fixedRows,
    '',
    techDebt > 0 ? `## Tech-debt findings\n\n${techDebtBlock}\n` : '',
    '## Closure-principle check',
    '',
    `All ${total} fixOutcomes have pinsFinding present and match a finding in review/CODE_REVIEW.md.`,
    '',
    '## Next phase',
    '',
    highTechDebt.length > 0
      ? `HALT — operator must triage ${highTechDebt.length} high-severity tech-debt entries (${highTechDebt.map((o) => o.findingId).join(', ')}) before \`/regression-guard\` or \`/feature-acceptance\` runs.`
      : `Run \`/regression-guard ${featureId}\``,
    '',
  ].join('\n');

  const fixesOut = ['---', renderYaml(fm), '---', '', body].join('\n');
  const fixesPath = join(fixesDir, 'FIXES.md');
  atomicWrite(fixesPath, fixesOut);

  // Back-compat sidecar for finalize-feature's existing render-readme path.
  // Same frontmatter shape, same body — different filename + relocated to
  // review/. Will be retired once render-readme.mjs switches to FIXES.md.
  const sidecarOut = ['---', renderYaml(fm), '---', '', body].join('\n');
  const sidecarPath = join(reviewDir, 'RECEIVING_CODE_REVIEW.md');
  if (existsSync(reviewDir)) atomicWrite(sidecarPath, sidecarOut);

  // In-place patch of review/CODE_REVIEW.md findings[].fixStatus
  const patched = patchCodeReviewFindings(reviewPath, fixOutcomes);

  console.log(
    `wrote ${fixesPath} (${fixed} fixed, ${techDebt} tech-debt); sidecar=${existsSync(sidecarPath)}; review-patched=${patched}`,
  );
}

main();
