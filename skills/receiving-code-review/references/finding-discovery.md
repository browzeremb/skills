# Finding discovery — reading `CODE_REVIEW.md.findings[]`

The receiving-code-review dispatcher reads ONE input — the structured
`findings[]` array in `docs/browzer/<feat>/staging/CODE_REVIEW.md.frontmatter`.

The aggregator that produced `findings[]` (see `code-review`) applied the
preserve-all merge algorithm. Each entry's shape:

```yaml
- id: F-001                       # canonical zero-padded ID
  mergedFrom: ["SR-3", "QA-1"]
  severity: high | medium | low
  lane: <primary lane>
  file: <repo-relative path>
  line: <int>                      # may be omitted
  ruleId: <short tag>
  title: "<one-line summary>"
  description: |
    <full explanation>
  pinsTask: [TASK_NN, ...]         # optional
  pinsAcs: [AC-NN, ...]            # optional
  pinsFiles: [<paths>]             # ≥1 entry — always populated
  fix: "<one-line suggestion>"
  assignedSkill: <skill-name | null>
```

---

## Dispatch ordering

1. **Severity-first**: dispatch `severity == high` findings before `medium` before `low`.
2. **File-overlap pre-check**: within a severity tier, build an overlap map:

   ```
   overlapMap = {}
   for each finding F in findings[]:
     for each file in F.pinsFiles:
       overlapMap[file] = (overlapMap[file] ?? []).concat(F.id)
   ```

   Any file with `overlapMap[file].length ≥ 2` is **contested**.

3. **Mode resolution** (per severity tier):

   | Condition | Mode |
   |---|---|
   | No contested files in tier | Parallel — dispatch all fixers simultaneously |
   | Some contested files | Split: non-overlapping findings dispatch in parallel; contested-file findings dispatch serially within the contested subset |
   | All findings share a file | Fully serial |

4. **Serial completion signal**: the dispatcher polls for `docs/browzer/<feat>/staging/fixes/F-<id>.completed.md` OR `.tech_debt.md`. The fixer is contractually bound to emit one of these AS SOON AS its ladder resolves (see `${CLAUDE_PLUGIN_ROOT}/agents/fixer.md`'s "Binding emit-on-completion contract").

---

## Worked example — 3 findings, 2 touch the same file

Suppose `CODE_REVIEW.md.findings[]` is:

```yaml
- id: F-001, severity: high, pinsFiles: ["src/routes/auth.<ext>"]
- id: F-002, severity: medium, pinsFiles: ["src/routes/auth.<ext>"]
- id: F-003, severity: low, pinsFiles: ["src/utils/helpers.<ext>"]
```

Overlap map:

```
src/routes/auth.<ext>:   ["F-001", "F-002"]   ← contested (2)
src/utils/helpers.<ext>: ["F-003"]            ← safe
```

Dispatch plan:

1. **High tier**: F-001 dispatches first (contested-file leader).
2. **Medium tier**: F-002 waits for F-001 to emit `staging/fixes/F-001.{completed,tech_debt}.md` (poll).
3. **Low tier**: F-003 dispatches in parallel with F-001 (no overlap).
4. After F-001 resolves → F-002 dispatches.
5. Once all three resolve → aggregator runs.

This ordering guarantees no two fixers write conflicting edits to
`src/routes/auth.<ext>` simultaneously.

---

## Dispatch prompt composition

For each finding, the dispatcher composes a prompt with:

1. Paste-include `${CLAUDE_PLUGIN_ROOT}/references/subagent-preamble.md` verbatim.
2. Paste-include `${CLAUDE_PLUGIN_ROOT}/references/preambles/code-subagent.md` verbatim.
3. Paste-include the per-finding payload:

   ```
   FIX BRIEF
     featureId   : <feat>
     findingId    : F-NNN
     severity     : <level>
     lane         : <lane>
     ruleId       : <tag>
     pinsFiles    : <list>
     pinsTask     : <list (optional)>
     pinsAcs      : <list (optional)>
     assignedSkill: <skill | null>

   ## Finding description
   <description verbatim>

   ## Suggested fix
   <fix verbatim>
   ```

4. Set `model` based on ladder step (sonnet for steps 1-3, opus for 4-6).
5. Set `effort` based on severity (`xhigh`/`max` for high; `high`/`xhigh` for medium/low).
6. Append: `Write staging/fixes/F-${findingId}.completed.md (or .tech_debt.md) when your ladder resolves. Return ONE LINE (≤200 tokens) — full details in the per-finding file.`
7. Spawn with `Agent(subagent_type: "browzer:fixer", model: <model>, effort: <effort>, prompt: <composed>)`.

---

## Tech-debt halt rule

After every dispatch wave, the receiving-code-review skill checks for
`staging/fixes/F-*.tech_debt.md` files with `severity: high` in frontmatter. If any
match, after the wave the dispatcher HALTS before the next severity tier
dispatches:

> receiving-code-review: HALT — high-severity tech-debt detected: <list of findingIds>. Triage each (re-run `/receiving-code-review <feat>` after the operator either accepts the debt explicitly via .browzer/accepted-tech-debt.json or replaces the entry with a `.completed.md` fix). Subsequent severity tiers blocked.

This prevents `medium` / `low` dispatches from masking unresolved `high`
problems.
