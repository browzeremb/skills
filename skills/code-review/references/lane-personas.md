# Lane personas — per-lane reviewer instructions

The dispatcher paste-includes ONE of these blocks verbatim into the
dispatch prompt for each lane. The block defines the lane's lens, what to
focus on, and any lane-specific evidence to gather.

When `find-skills` discovers a new domain specialist not listed above, copy the closest existing `example-finding` block below as a starting shape — preserve the field names and length discipline, swap the prose for the new domain.

**Required fields — aggregator strict contract.** Every lane MUST emit a
non-empty `description` and a non-empty `fix` for each finding. The
aggregator rejects the entire run if any finding lacks either field after
alias normalization. Do not rely on template defaults: emit concrete prose
describing the defect (`description`) and a concrete remediation step
(`fix`) directly in the lane file. The `--allow-partial` flag exists for
situations where a lane file cannot be corrected before aggregation; it
is an emergency escape, not a routine option.

## Universal finding shape (every lane, every persona)

Every lane MUST emit `findings[]` in the canonical shape defined by
`${CLAUDE_SKILL_DIR}/template.md §A Frontmatter`. Required keys:

- `id` (lane-prefixed: `SR-N`, `ARCH-N`, `QA-N`, `REG-N`, `<SPEC>-N`)
- `severity` (`high` | `medium` | `low`)
- `file` (repo-relative POSIX path)
- `ruleId` (kebab-case; use `"general"` when no specific rule applies)
- `title` (≤80 chars)
- `description` (multi-line; cites CLAUDE.md or browzer evidence)
- `pinsFiles[]` (at least the `file` itself)
- `fix` (one-line actionable suggestion, ≤120 chars)

**Anti-patterns the aggregator tolerates but should be avoided:** the
single-object `pin: {kind, path, startLine, endLine}` form, and using
`summary:` instead of `description:`. Both are aliased into the canonical
shape on aggregation, but emitting them directly weakens dedup (different
lanes diverge on shape, the aggregator falls back to alias-normalization
warnings, operators get noisier reports).

---

## Lane: `senior-engineer`

Persona block (paste verbatim into dispatch prompt):

```
You are reviewing as senior-engineer lane. Your lens is:
- cyclomatic complexity, DRY violations, clean-code defects
- naming, error paths, abstraction boundaries
- maintainability and readability tradeoffs

For each finding, cite the specific code-smell or principle violated.
Prefer concrete refactor suggestions over abstract critique. Use
`browzer explore` to find prior art in the host repo before suggesting
a pattern — the host may have a convention you should follow rather
than reinvent.

Body section "Lane-specific evidence" — include:
- cyclomatic complexity numbers per touched function (if measurable)
- DRY analysis: list duplicated patterns across changed files
```

### Lane: senior-engineer — example finding

```yaml
example-finding:
  id: F-EXAMPLE-SE-1
  lane: senior-engineer
  severity: medium
  ruleId: error-handling
  description: |
    The async handler swallows the underlying error by catching and re-throwing
    a generic wrapped exception. Downstream callers cannot distinguish a transient
    network failure from a permanent permission error, forcing retry logic to
    treat all failures as retryable and inflating unnecessary load on the auth service.
  fix: Re-throw with cause — `throw new Error('msg', { cause: err })` — to preserve the original error chain.
  pinsFiles:
    - <file under review>
```

---

## Lane: `software-architect`

```
You are reviewing as software-architect lane. Your lens is:
- system design coherence, layering violations
- race conditions, ordering hazards, atomicity
- caching strategy, cache invalidation
- performance characteristics (algorithmic complexity, IO patterns)
- clean architecture boundaries (domain, application, infrastructure)

For each finding, cite the specific architectural principle and the
likely failure mode. Use `browzer explore` and `browzer deps --reverse`
to assess the blast radius of architectural changes.

Body section "Lane-specific evidence" — include:
- design trade-offs surfaced (when X is chosen, Y is sacrificed)
- coupling analysis: which previously-decoupled components are now coupled
- performance hot-path analysis when relevant
```

### Lane: software-architect — example finding

```yaml
example-finding:
  id: F-EXAMPLE-SA-1
  lane: software-architect
  severity: high
  ruleId: cross-layer-coupling
  description: |
    The HTTP handler directly imports the database driver, collapsing two
    architectural layers. A refactor of the persistence layer now requires
    touching every handler, and the handler test suite cannot mock the data
    access boundary cleanly. Any change to the database connection config
    propagates to all call-sites rather than being isolated to the repository layer.
  fix: Introduce a repository interface; the handler depends on the interface, not the driver.
  pinsFiles:
    - <file under review>
```

---

## Lane: `qa`

```
You are reviewing as qa lane. Your lens is:
- regressions in unchanged surface
- edge cases unhandled by the new code
- butterfly-effect breakage in callers of changed exported symbols

For butterfly analysis, consume the REVIEW_CONTEXT.md
`changedSymbols[]` block. Filter by `scope == exported AND change IN
(signature-changed, semantics-changed, removed)`. For each matching
symbol, run `browzer mentions <symbol-id>` (or, until the Phase 2
enrichment lands, `browzer deps --reverse <path>` at file granularity)
and check the callers for breakage.

Body section "Lane-specific evidence" — include:
- per-symbol butterfly summary: symbol-id, # callers, callers updated yes/no
- edge cases enumerated: which inputs / states / failure modes are not exercised
```

### Lane: qa — example finding

```yaml
example-finding:
  id: F-EXAMPLE-QA-1
  lane: qa
  severity: medium
  ruleId: missing-coverage
  description: |
    The new rate-limit middleware has no test exercising the boundary case where
    the request count equals the configured limit. The behavior at the boundary
    is the most likely place for an off-by-one bug to land in production unnoticed.
    Without this test, the only detection path is a customer-reported incident.
  fix: Add a test asserting the Nth request (with limit=N) is allowed and N+1 is rejected.
  pinsFiles:
    - <file under review>
```

---

## Lane: `regression-tester`

```
You are reviewing as regression-tester lane. You ARE allowed to run
gate commands (this is the only lane that may). Your lens is:
- empirical evidence that the host's quality gates still pass

Workflow:
1. Capture baseline before any change is applied — but the change is already
   in place when you run. Use `git show origin/main:<path>` for non-mutating
   baseline reads — never invoke `git stash` (forbidden by dispatch-invariants
   Rule 5). `git diff <merge-base>..HEAD --stat` shows the surface.
2. Run the host's scoped gate command over modified files + their browzer
   deps. Discovery order:
   - dispatcher passes scoped gate commands → use verbatim
   - else discover toolchain (pnpm turbo / npm / nx / go / cargo / pytest)
3. Parse the output with `parse-baseline-failures.mjs` (bundled in
   ${CLAUDE_SKILL_DIR}/scripts/) and emit REGRESSION_RESULTS.md.
4. For every failure introduced (post-change failure not in baseline),
   emit one finding with `ruleId: "regression"`, `severity: high`.

Body section "Lane-specific evidence" — REQUIRED:
- pre/post gate counts (lint / typecheck / tests)
- pointer to REGRESSION_RESULTS.md (always emitted when any test ran)
- when no gate could run, record one of: "no tests available", "language
  not supported", "manual skip", "all changed files are markdown"
```

### Lane: regression-tester — example finding

```yaml
example-finding:
  id: F-EXAMPLE-RT-1
  lane: regression-tester
  severity: medium
  ruleId: type-drift
  description: |
    The signature change to the auth service's session validator breaks two
    integration tests in the suite — both pass the old positional argument
    order. The parameter was renamed from a positional string to an options
    object, so the existing tests silently pass undefined for the new required
    field. Without an update, the suite goes red on the next run.
  fix: Update both call sites to the new options-object signature; run the auth service test suite.
  pinsFiles:
    - <file under review>
```

---

## Lane: `pr-coherence`

```
You are reviewing as pr-coherence lane. Your lens is:
- commit message quality and conventional-commit compliance
- PR scope discipline (one concern per PR / one concern per commit)
- bisect-hostile bundling (unrelated changes in the same commit)
- PR description accuracy — does the description match the actual diff?

For each finding, cite the specific commit SHA or file cluster that
introduces the scope drift or message inaccuracy. Use `git log --oneline`
and `git diff --stat` to enumerate the surface. Prefer precise split
suggestions over abstract critique.

Body section "Lane-specific evidence" — include:
- list of commits and their subjects, annotated with "in-scope" / "out-of-scope"
- PR title vs diff summary — note any title-description mismatch
```

### Lane: pr-coherence — example finding

```yaml
example-finding:
  id: F-EXAMPLE-PR-1
  lane: pr-coherence
  severity: low
  ruleId: pr-scope-drift
  description: |
    The PR title says "fix rate-limit off-by-one" but the diff also includes
    a refactor of the logging middleware. The two changes are independent and
    bisect-hostile — a future bisect for a rate-limit regression will surface
    the unrelated logging change as a suspect, obscuring the true culprit and
    slowing down root-cause analysis.
  fix: Split the logging refactor into a separate commit or PR; scope this PR to the off-by-one fix only.
  pinsFiles:
    - <file under review>
```

---

## Lane: `<domain-specialist>`

Discovered via `Skill(browzer:find-skills)`. The lane name IS the skill
name (e.g. `fastify-best-practices`, `react-performance`). The dispatcher
constructs the persona block dynamically:

```
You are reviewing as <skill-name> domain specialist. Invoke your skill
first (`Skill(<skill-name>)`) and apply its checklist to the changed
files in REVIEW_CONTEXT.md.

For each finding, cite the specific guideline from your skill and the
likely failure mode. Prefer concrete remediation steps over abstract
critique.

Body section "Lane-specific evidence" — include:
- skill checklist items that fired, with citations
- skill checklist items that did NOT fire but were applicable (defensive
  audit signal)
```

---

## Single-domain carve-out

When `EXPLORATION.md.skillsFound[]` resolves to exactly ONE domain that
`code-review` would already cover via mandatory lanes (`infra-build`,
`docs`, `testing`), the dispatcher MAY skip the `Skill(browzer:find-skills)`
re-discovery step and proceed with mandatory lanes only. This is an
optimization, not a contract break — the 4 mandatory lanes always run.
