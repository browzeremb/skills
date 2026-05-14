# Butterfly-effect analysis — qa lane protocol

The qa lane's most expensive (and most valuable) work is butterfly-effect
analysis: which callers of changed exported symbols may break.

---

## Phase 1 (current rollout) — file-granularity probe

Use `REVIEW_CONTEXT.md.changedFiles[].reverseDeps` directly. For every
changed file, the renderer captured `browzer deps <file> --reverse`. The
qa lane reads that list, opens each reverse-importer, and checks whether
the importer's call sites still type-check / behave correctly given the
diff.

Cost: 1 `browzer deps --reverse` call per changed file (pre-computed by
`render-review-context.mjs` — qa lane reads from REVIEW_CONTEXT.md and
does not re-run).

Coverage: ~80% of real-world butterfly cases. Misses:

- Stringly-typed dispatch (event names, route paths, gRPC method names)
- Reflection / proxy / dynamic-import call sites
- Doc cross-references citing the symbol by name

---

## Phase 2 (deferred, planned) — symbol-granularity probe via `browzer mentions`

When `REVIEW_CONTEXT.md.changedSymbols[]` is populated (it is, per the
markdown-chain-output-contract Block 3), an enrichment pass would run:

```bash
# `--limit` default is 20; raise it when probing widely-cited symbols
# (dispatch keys, route names, public exports). Hard cap is 100.
for SYM in <changedSymbols WHERE scope == exported AND change IN (signature-changed, semantics-changed, removed)>; do
  browzer mentions "$SYM" --limit 50 --json --save "/tmp/mentions-$(echo "$SYM" | tr ':/' '__').json"
done
```

This finds:

- Doc cross-references that cite the symbol by name (markdown, ADRs)
- Test fixtures naming the symbol in assertion strings
- Configuration files referencing the symbol (route maps, RPC catalogs)

**Filter rules:**

- `change == added` is EXCLUDED. New symbols have no prior callers — no butterfly.
- `scope == internal` is EXCLUDED. Internal symbols have no external callers.

The Phase 2 enrichment is **not in the current rollout** — the cost
(linear in number of exported changed symbols) outweighs the marginal
coverage for typical features. Adopt when the host repo has many
stringly-typed dispatch patterns and the file-granularity probe regularly
misses real breakage.

---

## qa lane finding shape

```yaml
findings:
  - id: QA-1
    severity: high
    ruleId: butterfly-effect
    file: <reverse-importer path>
    line: <call site line>
    title: "<symbol> call site requires update after <change>"
    description: |
      <changed symbol> was <change> in this PR (see CODE_REVIEW.qa.md
      Lane-specific evidence for the butterfly summary table). The call
      site at <file>:<line> still uses the old <signature|semantics|name>
      and will <fail to compile | produce wrong result | reference removed
      symbol>.

      Evidence: `browzer deps --reverse <changed-file>` reports this file as
      an importer. Per CLAUDE.md "Cross-cutting invariants — Score
      normalization", a behavior shift on the score path requires every
      caller to re-validate batch shape.
    pinsTask: [TASK_03]
    pinsFiles: ["<changed-file>", "<reverse-importer>"]
    fix: "Update the call to pass the new <param-name> argument with the same default that <changed-file>::<symbol> now expects."
    assignedSkill: null
```

The lane file's "Lane-specific evidence" body section MUST include the
butterfly summary table:

```markdown
## Lane-specific evidence

### Butterfly summary

| Symbol | Change | Callers (file-granularity) | Callers updated? |
|---|---|---|---|
| src/api/handler.<ext>::Server.HandleRequest | semantics-changed | 3 | 0/3 |
| src/lib/auth.<ext>::validateToken | removed | 2 | 0/2 |
```

The aggregator does NOT paste-include lane bodies into `CODE_REVIEW.md`,
so this table is for human review and finalize-feature Phase A doc-patching context only. The
findings themselves are the structured handoff.
