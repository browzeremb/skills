#!/usr/bin/env node
// validate-frontmatter.mjs
// Validates YAML frontmatter in all SKILL.md and agents/*.md files under packages/skills/.
// Node v22 stdlib only — no npm dependencies.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYPE_1_PATTERNS } from './_workflow-mutator-patterns.mjs';

// Resolve the package root regardless of cwd (works from repo root or packages/skills/).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

// ── Frontmatter parser ────────────────────────────────────────────────────────
// Handles the three shapes found in this package:
//   1. Single-line quoted   description: "..."
//   2. Single-line unquoted description: Some text...
//   3. Block scalar         description: |\n  multi-line...
//
// Returns null if the file does not start with a valid frontmatter block.
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;

  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) return null;

  const raw = content.slice(4, endIndex);
  const result = {};

  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and comment lines.
    if (line.trim() === '' || line.startsWith('#')) {
      i++;
      continue;
    }

    // Top-level key: value
    const keyMatch = line.match(/^([A-Za-z][\w-]*):\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2].trim();

    // Block scalar — `|` or `|-` or `|+`
    if (rest === '|' || rest === '|-' || rest === '|+') {
      i++;
      const blockLines = [];
      while (
        i < lines.length &&
        (lines[i].startsWith('  ') || lines[i] === '')
      ) {
        blockLines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '');
        i++;
      }
      result[key] = blockLines.join('\n').trim();
      continue;
    }

    // Quoted string — strip surrounding `"` or `'`
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      result[key] = rest.slice(1, -1);
      i++;
      continue;
    }

    // Plain / unquoted scalar
    result[key] = rest;
    i++;
  }

  return result;
}

// ── File discovery ────────────────────────────────────────────────────────────
function collectFiles(root = PKG_ROOT) {
  const files = [];

  // agents/*.md  (direct children only; basename without .md = skill name)
  const agentsDir = join(root, 'agents');
  for (const entry of readdirSync(agentsDir)) {
    const full = join(agentsDir, entry);
    if (statSync(full).isFile() && entry.endsWith('.md')) {
      files.push({
        path: full,
        nameSource: 'basename',
        expectedName: basename(entry, '.md'),
      });
    }
  }

  // */*/SKILL.md  (two-level: category/skill-name/SKILL.md)
  // Exclude: examples/, node_modules/, agents/, scripts/
  const EXCLUDED = new Set([
    'examples',
    'node_modules',
    'agents',
    'scripts',
    '.claude-plugin',
  ]);
  for (const category of readdirSync(root)) {
    if (EXCLUDED.has(category)) continue;
    const categoryPath = join(root, category);
    if (!statSync(categoryPath).isDirectory()) continue;

    for (const skillDir of readdirSync(categoryPath)) {
      if (EXCLUDED.has(skillDir)) continue;
      const skillPath = join(categoryPath, skillDir);
      if (!statSync(skillPath).isDirectory()) continue;

      const skillMd = join(skillPath, 'SKILL.md');
      try {
        statSync(skillMd);
        files.push({
          path: skillMd,
          nameSource: 'parent-dir',
          expectedName: skillDir,
        });
      } catch {
        // No SKILL.md in this directory — skip.
      }
    }
  }

  return files;
}

// ── Validation ────────────────────────────────────────────────────────────────
function validate(file) {
  const { path, expectedName } = file;
  const failures = [];

  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    failures.push({ rule: 1, reason: `Cannot read file: ${err.message}` });
    return failures;
  }

  // Rule 1: must start with --- frontmatter block
  if (!content.startsWith('---\n')) {
    failures.push({ rule: 1, reason: 'File does not start with ---' });
    return failures; // can't parse further
  }
  const hasClosure = content.indexOf('\n---\n', 4) !== -1;
  if (!hasClosure) {
    failures.push({ rule: 1, reason: 'Frontmatter closing --- not found' });
    return failures;
  }

  const fm = parseFrontmatter(content);
  if (fm === null) {
    failures.push({ rule: 1, reason: 'Could not parse frontmatter block' });
    return failures;
  }

  // Rule 2: name — present and non-empty
  if (!fm.name || fm.name.trim() === '') {
    failures.push({ rule: 2, reason: '`name` key is missing or empty' });
  }

  // Rule 3: description — present and non-empty
  if (!fm.description || fm.description.trim() === '') {
    failures.push({ rule: 3, reason: '`description` key is missing or empty' });
  }

  // Rule 4: name value must equal expected name (parent dir or basename)
  if (fm.name && fm.name.trim() !== '' && fm.name.trim() !== expectedName) {
    failures.push({
      rule: 4,
      reason: `\`name\` is "${fm.name.trim()}" but expected "${expectedName}"`,
    });
  }

  // Rule 5: if allowed-tools is present, it must be a non-empty string
  if ('allowed-tools' in fm) {
    if (!fm['allowed-tools'] || fm['allowed-tools'].trim() === '') {
      failures.push({
        rule: 5,
        reason: '`allowed-tools` is present but empty',
      });
    }
  }

  // Rule 6: any skill whose body mentions workflow.json MUST declare EITHER:
  //   (a) Bash(browzer workflow *) — the new CLI-backed mutation surface (canonical), OR
  //   (b) Bash(jq *) AND Bash(mv *) — the legacy raw-pipeline pair (accepted during
  //       migration window per PRD R-5; both forms still appear during the transition).
  // This enforces the read/write contract — no skill may fall back to Read/Write/Edit
  // on the canonical workflow state file.
  //
  // Rule 6 sub-rule (Type-1 mutators): if the body invokes any TYPE_1 verb
  // (state-mutating writes whose durability gates the next phase), allowed-tools
  // MUST contain the literal `Bash(browzer workflow * --await)` token. Claude
  // Code allow-list pattern matching treats `--await` as a distinct constraint,
  // so plain `Bash(browzer workflow *)` does NOT satisfy. Only one failure is
  // emitted regardless of how many Type-1 verbs the body contains.
  const mentionsWorkflow = /workflow\.json/i.test(content);
  if (mentionsWorkflow) {
    const allowedTools = fm['allowed-tools'] || '';
    const hasBrowzerWorkflow = /Bash\(browzer workflow \*\)/.test(allowedTools);
    const hasJq = /Bash\(jq \*\)/.test(allowedTools);
    const hasMv = /Bash\(mv \*\)/.test(allowedTools);
    if (!hasBrowzerWorkflow && (!hasJq || !hasMv)) {
      failures.push({
        rule: 6,
        reason:
          'mentions workflow.json but allowed-tools missing Bash(browzer workflow *) or the legacy Bash(jq *) + Bash(mv *) pair',
      });
    }
  }

  const allowedTools = fm['allowed-tools'] || '';
  const hasAwaitToken = /Bash\(browzer workflow \* --await\)/.test(
    allowedTools,
  );
  const firstType1Hit = TYPE_1_PATTERNS.find((re) => re.test(content));
  if (firstType1Hit && !hasAwaitToken) {
    failures.push({
      rule: 6,
      reason: `mentions Type-1 mutator '${firstType1Hit.source}' but allowed-tools missing Bash(browzer workflow * --await)`,
    });
  }

  // Rule 8: any skill whose body mentions `gates.baseline` MUST also
  // mention `gates.regression`. The subagent-preamble Step 2.5 contract
  // is only enforceable when every skill that captures a baseline also
  // documents (and, ideally, validates) the regression diff. Skills
  // that talk about baseline-without-regression are usually places
  // where the contract was forgotten — surface them in CI.
  const mentionsBaseline = /gates\.baseline/.test(content);
  const mentionsRegression = /gates\.regression/.test(content);
  if (mentionsBaseline && !mentionsRegression) {
    failures.push({
      rule: 8,
      reason:
        'mentions `gates.baseline` but not `gates.regression` — add the regression-diff contract (see references/subagent-preamble.md §Step 2.5)',
    });
  }

  // Rule 9 (warn-only): a SKILL.md that exceeds 250 lines without a
  // `## References router` heading is a candidate for router conversion.
  // Emits a warning to stderr but does NOT push to failures[] — the run
  // continues and exits 0. This rule flips to ERROR in a future commit
  // only after all routers exist (per plan Risk Checkpoint #1).
  const lineCount = content.split('\n').length;
  const hasReferencesRouter = /^## References router/m.test(content);
  if (lineCount > 250 && !hasReferencesRouter) {
    process.stderr.write(
      `⚠ ${relative(PKG_ROOT, path)} exceeds 250 lines (${lineCount}) without ## References router — consider router conversion\n`,
    );
  }

  // Rule 10: mutates: cross-check vs workflow-v1.schema.json
  const rule10Failures = checkRule10(content, expectedName);
  for (const f of rule10Failures) {
    failures.push(f);
  }

  // Rule 11: Bash-invocation hygiene inside fenced ```bash blocks.
  const rule11Failures = checkRule11(content);
  for (const f of rule11Failures) {
    failures.push(f);
  }

  return failures;
}

// ── Rule 11: Bash-invocation hygiene inside SKILL.md fenced ```bash blocks ────
//
// Reuses the same Bash-block parsing as Rule 6 (Type-1 mutator detection).
// Rejects when:
//   (a) A block contains an inline `# comment` line (per workflow-schema.md
//       "Bash-invocation hygiene" rule 2). Allowed: shebang line (#!), blank
//       comment-only lines at the very start, and standalone comment lines
//       (lines whose first non-whitespace character is `#`). Only rejected when
//       `#` appears AFTER the command on the same line.
//   (b) A block declares more than two logical steps on a single line. Heuristic:
//       a single line contains 2+ `&&` tokens that is NOT a shell `if [` / `[ `
//       / `[[ ` conditional test. Example violation: `foo && bar && baz`.
//       Two-command chains (`mkdir -p X && cd X`) are LIKELY OK and left alone.
//   (c) A block uses the `$(jq … "$WORKFLOW")` capture pattern when
//       `browzer workflow get-step --field … --save … --quiet` is a drop-in
//       replacement. Heuristic: a line matching `VAR=$(jq[^)]+"$WORKFLOW")`
//       where VAR is multi-letter AND the captured value is later used as JSON
//       (the variable appears downstream in the same block piped through jq or
//       passed via --argjson). Single-letter variables are excluded (low FP cost).

// Regex used by Rule 11(c)
const RULE11_JQ_CAPTURE_RE = /\$\(jq[^)]+"\$WORKFLOW"\)/;
const RULE11_ASSIGN_RE = /^([A-Za-z_][A-Za-z_0-9]+)=\$\(jq/;

/**
 * Extract fenced ```bash ... ``` blocks from content.
 * Returns an array of { block, startLine } objects where `block` is the raw
 * block text (without the fence lines) and `startLine` is the 1-based line
 * number of the opening fence within the overall file.
 */
function extractBashBlocks(content) {
  const results = [];
  const regex = /^```bash\n([\s\S]*?)^```/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const startLine = content.slice(0, match.index).split('\n').length + 1;
    results.push({ block: match[1], startLine });
  }
  return results;
}

/**
 * Rule 11 check for a single skill file.
 * Returns array of { rule: 11, reason } failure objects.
 */
function checkRule11(content) {
  const failures = [];
  const seen = new Set(); // deduplicate identical reasons per file

  const bashBlocks = extractBashBlocks(content);

  for (const { block, startLine } of bashBlocks) {
    const lines = block.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.trim();
      const lineNo = startLine + i;

      // ── (a) inline comment ────────────────────────────────────────────────
      // Allow: empty lines, shebang (#!), standalone comment lines (start with #)
      // Reject: `#` appearing AFTER the command on the same line
      if (
        stripped.length > 0 &&
        !stripped.startsWith('#') &&
        line.includes(' #')
      ) {
        const reason = `rule11(a): inline # comment on non-comment line (L${lineNo}): ${line.trim().slice(0, 60)}`;
        if (!seen.has(reason)) {
          seen.add(reason);
          failures.push({ rule: 11, reason });
        }
      }

      // ── (b) multi-step chain (3+ commands via &&) ─────────────────────────
      // Allow: if [ ... ] && [ ... ] conditional tests (starts with 'if ', '[ ', '[[ ')
      const ampCount = (line.match(/&&/g) || []).length;
      if (
        ampCount >= 2 &&
        !stripped.startsWith('if ') &&
        !stripped.startsWith('[ ') &&
        !stripped.startsWith('[[ ')
      ) {
        const reason = `rule11(b): single-line chain with ${ampCount + 1} &&-separated commands (L${lineNo}): ${line.trim().slice(0, 60)}`;
        if (!seen.has(reason)) {
          seen.add(reason);
          failures.push({ rule: 11, reason });
        }
      }

      // ── (c) $(jq … "$WORKFLOW") capture pattern ───────────────────────────
      if (RULE11_JQ_CAPTURE_RE.test(line)) {
        const assignMatch = RULE11_ASSIGN_RE.exec(stripped);
        if (assignMatch) {
          const varName = assignMatch[1];
          if (varName.length > 1) {
            // Check if the variable is later piped through jq or passed as --argjson
            const restOfBlock = lines.slice(i + 1).join('\n');
            const jqDownstream = new RegExp(
              `\\$${varName}[^\\n]*\\|[^\\n]*jq|--argjson\\S*\\s+\\S+\\s+"\\$${varName}"`,
            ).test(restOfBlock);
            if (jqDownstream) {
              const hint =
                'use `browzer workflow get-step --field <jqpath> --save <file> --quiet` instead';
              const reason = `rule11(c): $(jq … "$WORKFLOW") capture pattern for var ${varName} used as JSON downstream — ${hint}`;
              if (!seen.has(reason)) {
                seen.add(reason);
                failures.push({ rule: 11, reason });
              }
            }
          }
        }
      }
    }
  }

  return failures;
}

// ── Rule 7: shared-reference mirrors must be in sync ──────────────────────────
// Skills installed standalone must work without reaching outside their own
// folder, so each consuming skill keeps a byte-identical mirror of the shared
// references under its own references/ dir. Drift means a maintainer edited a
// mirror by hand or forgot to run sync — both are bugs.
import { execSync } from 'node:child_process';

function checkSharedRefMirrors() {
  try {
    execSync(`node ${join(__dirname, 'sync-shared-refs.mjs')} --check`, {
      stdio: 'inherit',
    });
    return [];
  } catch {
    return [
      {
        rel: 'packages/skills/references/*',
        rule: 7,
        reason:
          'shared-reference mirrors out of sync — run `node packages/skills/scripts/sync-shared-refs.mjs`',
      },
    ];
  }
}

// ── Rule 10: mutates: cross-check vs workflow-v1.schema.json ──────────────────
//
// Skills declare a `mutates:` frontmatter key listing every workflow.json path
// they write to with the fields required per path. This rule asserts (a) every
// declared path exists in the schema, and (b) every field listed in `requires:`
// appears in the schema's required[] for that path. Drift = fatal.
//
// --strict (off by default) adds a reverse check: every required field of every
// step-type is declared as `requires` by at least one skill.

const SCHEMA_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'cli',
  'schemas',
  'workflow-v1.schema.json',
);

let _workflowSchema = null;
function loadWorkflowSchema() {
  if (_workflowSchema) return _workflowSchema;
  try {
    _workflowSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  } catch {
    // If schema not found, skip rule 10 silently (CI will catch it via TASK_01).
    _workflowSchema = null;
  }
  return _workflowSchema;
}

/**
 * Resolve a $ref string like "#/components/schemas/Foo" into the actual schema
 * node within the given root schema object.
 */
function resolveRef(ref, rootSchema) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = rootSchema;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return null;
    node = node[p];
  }
  return node ?? null;
}

/**
 * Merge properties + required arrays from allOf entries (flattens one level).
 * Returns { properties, required }.
 */
function mergeAllOf(schema, rootSchema) {
  const props = Object.assign({}, schema.properties ?? {});
  const req = [...(schema.required ?? [])];
  for (const entry of schema.allOf ?? []) {
    const resolved = entry.$ref ? resolveRef(entry.$ref, rootSchema) : entry;
    if (!resolved) continue;
    Object.assign(props, resolved.properties ?? {});
    for (const r of resolved.required ?? []) {
      if (!req.includes(r)) req.push(r);
    }
  }
  return { properties: props, required: req };
}

/**
 * Navigate a dotted path (supports `[]` array suffix) through the schema.
 * Returns { node, required } where node is the schema at that path, or null if
 * the path does not exist. `required` is the required[] array of the *parent*
 * that owns the terminal segment.
 *
 * Examples:
 *   "config"                         → WorkflowV1.properties.config
 *   "steps[]"                        → WorkflowV1.steps.items (Step)
 *   "steps[].prd"                    → Step merged props → "prd" property
 *   "steps[].task.execution.gates"   → TaskStep.task → TaskExecution.execution
 *                                      → TaskExecutionResult.gates
 */
function resolveSchemaPath(dotPath, rootSchema) {
  const schemas = rootSchema?.components?.schemas ?? {};
  const workflowRoot = schemas['WorkflowV1'];
  if (!workflowRoot) return null;

  const segments = dotPath.split('.');
  // Current node + its parent required array.
  let node = workflowRoot;
  let parentRequired = workflowRoot.required ?? [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Resolve any pending $ref before going deeper.
    if (node?.$ref) {
      node = resolveRef(node.$ref, rootSchema);
      if (!node) return null;
    }

    // Flatten allOf (picks up StepBase fields etc.).
    const { properties, required } = mergeAllOf(node, rootSchema);

    const isArraySuffix = seg.endsWith('[]');
    const cleanSeg = isArraySuffix ? seg.slice(0, -2) : seg;

    if (!(cleanSeg in properties)) {
      // For Step (oneOf discriminated union), search all oneOf variants.
      if (node.oneOf) {
        let found = null;
        let foundRequired = [];
        for (const variant of node.oneOf) {
          const vResolved = variant.$ref
            ? resolveRef(variant.$ref, rootSchema)
            : variant;
          if (!vResolved) continue;
          const { properties: vProps, required: vReq } = mergeAllOf(
            vResolved,
            rootSchema,
          );
          if (cleanSeg in vProps) {
            found = vProps[cleanSeg];
            foundRequired = vReq;
            break;
          }
        }
        if (!found) return null;
        parentRequired = foundRequired;
        node = found;
      } else {
        return null;
      }
    } else {
      parentRequired = required;
      node = properties[cleanSeg];
    }

    // If the segment is an array accessor (ends with []), go into items.
    if (isArraySuffix) {
      if (node?.$ref) {
        node = resolveRef(node.$ref, rootSchema);
        if (!node) return null;
      }
      if (!node?.items) return null;
      const items = node.items;
      parentRequired = [];
      node = items.$ref ? resolveRef(items.$ref, rootSchema) : items;
      if (!node) return null;
    }
  }

  // Resolve a final $ref at the terminal node.
  if (node?.$ref) {
    node = resolveRef(node.$ref, rootSchema);
  }

  return node ? { node, required: parentRequired } : null;
}

/**
 * Parse the `mutates:` block from raw frontmatter content.
 * Returns an array of { path, requires } objects, or [] if not present.
 *
 * Handles the minimal YAML subset used in SKILL.md files:
 *   mutates:
 *     - path: some.path
 *       requires: [field1, field2]
 */
function parseMutates(content) {
  if (!content.startsWith('---\n')) return [];
  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) return [];
  const raw = content.slice(4, endIndex);

  // Find the mutates: block — everything from "mutates:\n" to end-of-raw
  // OR to the next top-level key (a line that starts with a non-space letter).
  // Use a greedy match so multiline list items are captured in full.
  const mutatesMatch =
    raw.match(/^mutates:\s*\n([\s\S]+?)(?=\n[A-Za-z][^\n]*:|$(?![\s\S]))/m) ??
    raw.match(/^mutates:\s*\n([\s\S]+)/m);
  if (!mutatesMatch) return [];

  const block = mutatesMatch[1];
  const items = [];
  // Split on list-item markers (lines starting with optional whitespace + "- ").
  const itemBlocks = block.split(/\n(?=\s*-\s)/);

  for (const itemBlock of itemBlocks) {
    const trimmed = itemBlock.trim();
    if (!trimmed || !trimmed.startsWith('-')) continue;

    const pathMatch = trimmed.match(/path:\s*(.+)/);
    const requiresMatch = trimmed.match(/requires:\s*\[([^\]]*)\]/);

    if (!pathMatch) continue;

    const path = pathMatch[1].trim();
    const requires = requiresMatch
      ? requiresMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    items.push({ path, requires });
  }

  return items;
}

/**
 * Rule 10 check for a single skill file.
 * Returns array of { rule: 10, reason } failure objects.
 */
function checkRule10(content, skillName) {
  const schema = loadWorkflowSchema();
  if (!schema) return []; // schema not available — skip silently

  const mutates = parseMutates(content);
  if (mutates.length === 0) return []; // no mutates declared — rule does not apply

  const failures = [];

  for (const { path, requires } of mutates) {
    const resolved = resolveSchemaPath(path, schema);

    if (!resolved) {
      failures.push({
        rule: 10,
        reason: `path "${path}" not found in workflow-v1.schema.json`,
      });
      continue;
    }

    // Resolve the terminal node's own required array (for nested schemas).
    const termNode = resolved.node;
    let termRequired = [];
    if (termNode?.$ref) {
      const ref = resolveRef(termNode.$ref, schema);
      termRequired = ref?.required ?? [];
    } else {
      const { required } = mergeAllOf(termNode, schema);
      termRequired = required;
    }

    // Also include the parent required (i.e. the field name itself may be required
    // in the parent object — but we care about fields *within* the path node).
    // For leaf paths, the interesting required[] is the terminal node's required.
    const effectiveRequired =
      termRequired.length > 0 ? termRequired : resolved.required;

    for (const field of requires) {
      if (!effectiveRequired.includes(field)) {
        failures.push({
          rule: 10,
          reason: `field "${field}" not in schema required[] for path "${path}"`,
        });
      }
    }
  }

  return failures;
}

// ── --self-test-rule-10 mode ──────────────────────────────────────────────────
// Copies the bad fixture into a tmp skill dir, runs the full validator, asserts
// non-zero exit, removes the tmp dir, exits 0.
// Invoked via: node validate-frontmatter.mjs --self-test-rule-10

import { execFileSync as _execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

if (process.argv.includes('--self-test-rule-10')) {
  const fixtureDir = join(__dirname, '__fixtures__');
  const fixturePath = join(fixtureDir, 'skill-with-bad-mutates.md');
  const tmpRoot = join(
    tmpdir(),
    `rule10-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const tmpSkillDir = join(tmpRoot, 'skills', 'bad-skill-fixture');
  const tmpAgentsDir = join(tmpRoot, 'agents');

  try {
    mkdirSync(tmpSkillDir, { recursive: true });
    mkdirSync(tmpAgentsDir, { recursive: true });
    writeFileSync(
      join(tmpSkillDir, 'SKILL.md'),
      readFileSync(fixturePath, 'utf8'),
    );

    // Run the validator against the tmp tree.
    let exitCode = 0;
    let output = '';
    try {
      output = _execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, SKILLS_ROOT_OVERRIDE: tmpRoot },
        },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    if (exitCode === 0) {
      process.stderr.write(
        `✗ --self-test-rule-10 FAILED: validator exited 0 — expected non-zero for bad fixture\nOutput:\n${output}\n`,
      );
      process.exit(1);
    }

    if (!output.includes('rule10') && !output.includes('rule 10')) {
      process.stderr.write(
        `✗ --self-test-rule-10 FAILED: validator exited non-zero but output missing "rule10"\nOutput:\n${output}\n`,
      );
      process.exit(1);
    }

    console.log('✓ --self-test-rule-10 passed: bad fixture correctly rejected');
    process.exit(0);
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── --self-test-rule-11 mode ──────────────────────────────────────────────────
// Copies the bad fixture into a tmp skill dir, runs the full validator, asserts
// non-zero exit, removes the tmp dir, exits 0.
// Invoked via: node validate-frontmatter.mjs --self-test-rule-11

if (process.argv.includes('--self-test-rule-11')) {
  const fixtureDir = join(__dirname, '__fixtures__');
  const fixturePath = join(fixtureDir, 'skill-with-inline-comment.md');
  const tmpRoot = join(
    tmpdir(),
    `rule11-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const tmpSkillDir = join(tmpRoot, 'skills', 'bad-bash-skill');
  const tmpAgentsDir = join(tmpRoot, 'agents');

  try {
    mkdirSync(tmpSkillDir, { recursive: true });
    mkdirSync(tmpAgentsDir, { recursive: true });
    writeFileSync(
      join(tmpSkillDir, 'SKILL.md'),
      readFileSync(fixturePath, 'utf8'),
    );

    // Run the validator against the tmp tree.
    let exitCode = 0;
    let output = '';
    try {
      output = _execFileSync(
        process.execPath,
        [join(__dirname, 'validate-frontmatter.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, SKILLS_ROOT_OVERRIDE: tmpRoot },
        },
      );
    } catch (err) {
      exitCode = err.status ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    if (exitCode === 0) {
      process.stderr.write(
        `✗ --self-test-rule-11 FAILED: validator exited 0 — expected non-zero for bad fixture\nOutput:\n${output}\n`,
      );
      process.exit(1);
    }

    if (!output.includes('rule11') && !output.includes('rule 11')) {
      process.stderr.write(
        `✗ --self-test-rule-11 FAILED: validator exited non-zero but output missing "rule11"\nOutput:\n${output}\n`,
      );
      process.exit(1);
    }

    console.log('✓ --self-test-rule-11 passed: bad fixture correctly rejected');
    process.exit(0);
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
// SKILLS_ROOT_OVERRIDE allows tests to point the validator at a tmp tree.
// When set, Rule 7 (shared-ref mirror check) is skipped — the tmp tree has no
// references/ mirrors and the check would always fail.
const SKILLS_ROOT = process.env.SKILLS_ROOT_OVERRIDE ?? PKG_ROOT;
const isOverride = !!process.env.SKILLS_ROOT_OVERRIDE;

const files = collectFiles(SKILLS_ROOT);
const allFailures = [];

for (const file of files) {
  const failures = validate(file);
  if (failures.length > 0) {
    const rel = relative(SKILLS_ROOT, file.path);
    for (const { rule, reason } of failures) {
      allFailures.push({ rel, rule, reason });
      console.error(`✗ ${rel}: rule ${rule}: ${reason}`);
    }
  }
}

if (!isOverride) {
  allFailures.push(...checkSharedRefMirrors());
}

if (allFailures.length > 0) {
  console.error(
    `\n${allFailures.length} validation error(s) across ${files.length} file(s).`,
  );
  process.exit(1);
}

console.log(`✓ ${files.length} SKILL.md files passed frontmatter validation`);
