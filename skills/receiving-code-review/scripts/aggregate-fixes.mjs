#!/usr/bin/env node
/**
 * aggregate-fixes.mjs — glob FIX_*.{completed,tech_debt}.md → RECEIVING_CODE_REVIEW.md
 *
 * Usage: node aggregate-fixes.mjs <featureId>
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
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
    let v = kv[2].trim();
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

function main() {
  const featureId = process.argv[2];
  if (!featureId || !/^feat-\d{8}-[a-z0-9-]+$/.test(featureId)) {
    die('usage: aggregate-fixes <featureId>', 2);
  }
  const featDir = resolve('docs', 'browzer', featureId);
  if (!existsSync(featDir)) die(`feat folder not found: ${featDir}`, 2);

  const fixFiles = readdirSync(featDir).filter((e) =>
    /^FIX_F-\d+\.(completed|tech_debt)\.md$/.test(e),
  );
  if (fixFiles.length === 0)
    die('no FIX_*.{completed,tech_debt}.md files found', 3);

  // Read CODE_REVIEW.md to mirror prdSha
  let prdSha = '';
  const reviewPath = join(featDir, 'CODE_REVIEW.md');
  if (existsSync(reviewPath)) {
    const fm = parseFrontmatter(readFileSync(reviewPath, 'utf8'));
    if (fm?.prdSha) prdSha = fm.prdSha;
  }

  const fixOutcomes = [];
  for (const f of fixFiles.sort()) {
    const text = readFileSync(join(featDir, f), 'utf8');
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

  // Compose body
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
        `- **${o.findingId}** [${o.severity}, ${o.techDebtSubtype}] — see [${o.fixFile}](${o.fixFile})`,
    )
    .join('\n');
  const highTechDebt = fixOutcomes.filter(
    (o) => o.status === 'tech_debt' && o.severity === 'high',
  );

  const body = [
    '# Receiving code review — aggregate',
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
    `All ${total} fixOutcomes have pinsFinding present and match a finding in CODE_REVIEW.md.`,
    '',
    '## Next phase',
    '',
    highTechDebt.length > 0
      ? `HALT — operator must triage ${highTechDebt.length} high-severity tech-debt entries (${highTechDebt.map((o) => o.findingId).join(', ')}) before \`/feature-acceptance\` will run.`
      : `Run \`/write-tests ${featureId}\``,
    '',
  ].join('\n');

  const out = ['---', renderYaml(fm), '---', '', body].join('\n');
  const outPath = join(featDir, 'RECEIVING_CODE_REVIEW.md');
  atomicWrite(outPath, out);
  console.log(`wrote ${outPath} (${fixed} fixed, ${techDebt} tech-debt)`);
}

main();
