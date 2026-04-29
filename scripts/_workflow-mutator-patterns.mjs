// Single source of truth for `browzer workflow` mutator classification.
//
// Two consumers:
//   - validate-frontmatter.mjs (Rule 6 sub-rule): if a skill body matches any
//     TYPE_1 pattern, its allowed-tools MUST contain the literal
//     `Bash(browzer workflow * --await)` token. Claude Code allow-list pattern
//     matching treats `--await` as a distinct constraint, so plain
//     `Bash(browzer workflow *)` does NOT satisfy it.
//   - migrate-await.mjs (codemod): rewrites any TYPE_1 invocation it finds in
//     a skill body to include `--await` right after the verb, idempotently.
//
// TYPE_1 = state-mutating verbs whose write durability gates the next phase
// (lifecycle status, current step, config, append-step, payload-bearing
// fields like task/outputs/findings/scope/explorer). The agent must wait
// for fsync before continuing.
//
// TYPE_2 = read-only or low-impact mutations (queries, get-step,
// metrics/auditLog field updates, default review-history). The agent can
// fire-and-forget. Documented here for advisory classification only —
// nothing enforces TYPE_2 today.

export const TYPE_1_PATTERNS = [
  // Lifecycle status writes (every phase transition).
  /browzer\s+workflow\s+set-status\b/,
  // Verb that finalizes a step — must be durable before the next skill reads.
  /browzer\s+workflow\s+complete-step\b/,
  // Pointer to the active step — readers downstream rely on it.
  /browzer\s+workflow\s+set-current-step\b/,
  // Config knobs (mode, default-reviewer, etc.) — affect downstream skills.
  /browzer\s+workflow\s+set-config\b/,
  // Brand-new step with payload — the next skill loads it via get-step.
  /browzer\s+workflow\s+append-step\b/,
  // update-step is TYPE_1 only when --field targets a payload-bearing field.
  // task.* covers task.execution / task.reviewer / task.suggestedModel etc.
  /browzer\s+workflow\s+update-step\s+\S+\s+--field\s+(task\.|status\b|outputs\b|findings\b|scope\b|explorer\b|currentStepId\b)/,
  // patch with --jq writing into one of the same payload-bearing fields.
  /browzer\s+workflow\s+patch\b[^\n]*--jq[^\n]*\.steps\[[^\]]*\]\.(status|outputs|findings|scope|explorer)\b/,
];

export const TYPE_2_HINTS = [
  // Pure reads.
  /browzer\s+workflow\s+query\b/,
  /browzer\s+workflow\s+get-step\b/,
  /browzer\s+workflow\s+get-config\b/,
  // Low-impact field writes (instrumentation only).
  /browzer\s+workflow\s+update-step\s+\S+\s+--field\s+(metrics\b|auditLog\b)/,
  // Default review-history append (no state-machine impact).
  /browzer\s+workflow\s+append-review-history\b(?![^\n]*--field\s+(status|outputs|findings))/,
];

/**
 * Returns the list of TYPE_1_PATTERNS that match `body`. Empty array means
 * no Type-1 mutators were detected (safe to skip the --await requirement).
 */
export function findType1Matches(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const hits = [];
  for (const re of TYPE_1_PATTERNS) {
    if (re.test(body)) hits.push(re);
  }
  return hits;
}
