/**
 * Self-test for lane-personas.md example-finding blocks.
 *
 * Asserts:
 *  - At least 5 example-finding blocks are present.
 *  - Every description is >= 40 chars (trimmed, multi-line joined).
 *  - Every fix is >= 20 and <= 120 chars (trimmed).
 *  - No block contains a forbidden token (case-insensitive).
 *  - The file body contains the literal phrase `find-skills`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LANE_PERSONAS_PATH = join(
  __dirname,
  '..',
  'references',
  'lane-personas.md',
);

const FORBIDDEN_TOKENS = [
  'lefthook',
  'biome',
  'pnpm',
  'turbo',
  'vitest',
  'neo4j',
  'langfuse',
  'runpod',
  'bullmq',
  'railway',
  'drizzle',
  'fastify',
  'nextjs',
  'next.js',
];

/**
 * Extract all example-finding YAML blocks from a markdown file body.
 * Each block starts at a line matching /^example-finding:/ (inside a fenced
 * YAML block) and ends at the next `example-finding:` start, `### Lane:`, or
 * EOF. We strip the outer triple-backtick fences; the block content is
 * everything from `example-finding:` to the closing fence.
 *
 * Strategy: scan line by line; track whether we are inside a ```yaml fence.
 * When we encounter `example-finding:` inside a fence, accumulate lines until
 * the closing ``` or until a new `example-finding:` or a Lane heading appears.
 */
function extractExampleFindingBlocks(fileContent) {
  const lines = fileContent.split('\n');
  const blocks = [];
  let insideFence = false;
  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect opening/closing of fenced code blocks
    if (/^```/.test(line)) {
      if (!insideFence) {
        insideFence = true;
      } else {
        // Closing fence
        if (currentBlock !== null) {
          blocks.push(currentBlock.join('\n'));
          currentBlock = null;
        }
        insideFence = false;
      }
      continue;
    }

    if (insideFence) {
      if (/^example-finding:/.test(line)) {
        // Start a new block (flush any prior incomplete one)
        if (currentBlock !== null) {
          blocks.push(currentBlock.join('\n'));
        }
        currentBlock = [line];
      } else if (currentBlock !== null) {
        currentBlock.push(line);
      }
    } else {
      // Not inside a fence — if we somehow have an open block, flush it
      if (currentBlock !== null) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = null;
      }
    }
  }

  // Flush trailing block
  if (currentBlock !== null) {
    blocks.push(currentBlock.join('\n'));
  }

  return blocks;
}

/**
 * Parse a raw YAML block string (starting at `example-finding:`) and extract
 * `description` (multi-line until next top-level key) and `fix` (value on the
 * `fix:` line or following indented lines before the next top-level key).
 */
function parseBlock(blockText) {
  const lines = blockText.split('\n');

  let description = null;
  let fix = null;

  let mode = null; // 'description' | 'fix' | null
  const descLines = [];
  const fixLines = [];

  for (const line of lines) {
    // Skip the root `example-finding:` key
    if (/^example-finding:/.test(line)) {
      mode = null;
      continue;
    }

    // Top-level YAML key detection (2-space indent for nested, 0-indent for top-level within the block)
    // In the YAML block, keys like `description:`, `fix:`, `id:`, etc. are at 2-space indent.
    const topLevelKeyMatch = line.match(/^ {2}(\w[\w-]*):/);
    if (topLevelKeyMatch) {
      const key = topLevelKeyMatch[1];
      // Flush previous mode
      if (mode === 'description') {
        description = descLines.join('\n').trim();
      } else if (mode === 'fix') {
        fix = fixLines.join('\n').trim();
      }
      mode = null;

      if (key === 'description') {
        mode = 'description';
        // Value may start on the same line (after `description: `) or be `|` (block scalar)
        const rest = line.replace(/^ {2}description:\s*/, '');
        if (rest && rest !== '|') {
          descLines.length = 0;
          descLines.push(rest);
        } else {
          descLines.length = 0;
        }
      } else if (key === 'fix') {
        mode = 'fix';
        const rest = line.replace(/^ {2}fix:\s*/, '');
        if (rest && rest !== '|') {
          fixLines.length = 0;
          fixLines.push(rest);
        } else {
          fixLines.length = 0;
        }
      }
      continue;
    }

    // Continuation lines for multi-line block scalars (4-space indent inside description/fix)
    if (mode === 'description' && /^ {4}/.test(line)) {
      descLines.push(line.trim());
    } else if (mode === 'fix' && /^ {4}/.test(line)) {
      fixLines.push(line.trim());
    } else if (mode !== null && line.trim() === '') {
      // blank line — could be separator in block scalar
      if (mode === 'description') descLines.push('');
      else if (mode === 'fix') fixLines.push('');
    }
  }

  // Flush final mode
  if (mode === 'description') {
    description = descLines.join('\n').trim();
  } else if (mode === 'fix') {
    fix = fixLines.join('\n').trim();
  }

  return { description, fix };
}

// ── Load file ──────────────────────────────────────────────────────────────

const fileContent = readFileSync(LANE_PERSONAS_PATH, 'utf8');
const blocks = extractExampleFindingBlocks(fileContent);

// ── Tests ──────────────────────────────────────────────────────────────────

describe('lane-personas.md example-finding blocks', () => {
  it('has at least 5 example-finding blocks', () => {
    assert.ok(
      blocks.length >= 5,
      `Expected >= 5 example-finding blocks, found ${blocks.length}`,
    );
  });

  it('file body contains the literal phrase "find-skills"', () => {
    assert.ok(
      fileContent.includes('find-skills'),
      'Expected the file to contain the literal phrase "find-skills"',
    );
  });

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const { description, fix } = parseBlock(block);
    const blockLabel = `Block ${i + 1}`;

    it(`${blockLabel}: description is present and >= 40 chars`, () => {
      assert.ok(
        description !== null && description.length > 0,
        `${blockLabel}: description is missing or empty`,
      );
      assert.ok(
        description.length >= 40,
        `${blockLabel}: description is ${description.length} chars, expected >= 40. Got: "${description}"`,
      );
    });

    it(`${blockLabel}: fix is present, >= 20 chars, and <= 120 chars`, () => {
      assert.ok(
        fix !== null && fix.length > 0,
        `${blockLabel}: fix is missing or empty`,
      );
      assert.ok(
        fix.length >= 20,
        `${blockLabel}: fix is ${fix.length} chars, expected >= 20. Got: "${fix}"`,
      );
      assert.ok(
        fix.length <= 120,
        `${blockLabel}: fix is ${fix.length} chars, expected <= 120. Got: "${fix}"`,
      );
    });

    it(`${blockLabel}: contains no forbidden tokens`, () => {
      const lowerBlock = block.toLowerCase();
      for (const token of FORBIDDEN_TOKENS) {
        assert.ok(
          !lowerBlock.includes(token.toLowerCase()),
          `${blockLabel}: contains forbidden token "${token}"`,
        );
      }
    });
  }
});
