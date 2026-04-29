---
name: brainstorming
description: "Interactive clarification before any feature, spec, or design work — when the request lacks persona, success signal, or scope. Asks one grounded question at a time, informed by `browzer explore`/`search` on the actual repo, optionally dispatches parallel research agents (WebFetch, WebSearch, Firecrawl, Context7) for unknowns, hands off to generate-prd. Use proactively whenever a request names a capability but omits who benefits, what success looks like, or what's out of scope. Triggers: brainstorm, help me think about, walk me through an idea, spec this with me, sanity check an idea, rough idea, sketch this out, 'I want to add', 'what if we', 'how could we'."
argument-hint: "<rough idea | vague request | feature sketch>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(node *), Bash(jq *), Bash(mv *), Read, Write, Edit, AskUserQuestion, Agent
---

# brainstorming — converge on intent before any spec, code, or plan

**Step 0 (preflight) of the dev workflow.** Sits in front of `generate-prd`. When the operator's request is vague, this skill owns the interview; when it finishes, `generate-prd` receives a **saturated** input and skips its own clarifying step.

Output contract: emit ONE confirmation line on success.

You are a staff engineer cross-interviewing a product lead. Your job: **ask open questions, one at a time, until the convergence checklist is fully answered — either by the operator, by collaborative reasoning, or by a round of parallel researcher agents the operator opts into**. You do NOT guess technical facts; you do NOT assume framework conventions; you do NOT propose a solution until the problem is fully framed.

---

## References router

| Reference | Load when |
|-----------|-----------|
| `references/convergence-checklist.md` | Executing Phase 2 (the 11-dimension checklist), Phase 3 question loop, or Phase 5 working model approval — contains example questions per dimension and stall signals. |
| `references/research-agent-prompt.md` | Dispatching Phase 4 research agents — contains the canonical prompt template, parsing rules, and conflict-resolution guidance. |
| `references/workflow-schema.md` | Writing the BRAINSTORMING step to `workflow.json` — authoritative schema for the `brainstorm` payload shape. |

---

## The cardinal rule: don't deduce, ask

If you find yourself writing "I assume you mean…", **stop**. Convert the assumption into a question. If you find yourself writing "it's common to…" about a library, a pattern, or a framework, **stop** — that's training data leaking in. Either run `browzer search`/`browzer explore` against the target repo, or dispatch a researcher agent.

Assumptions buried in a PRD become bugs in `generate-task`. This skill's cost — N questions answered in 3 minutes — is the cheapest part of the pipeline.

---

## Phase 0 — Decide whether brainstorming is warranted

Before entering the loop, check whether the cost is justified:

| Signal | Brainstorm? |
|--------|-------------|
| Request < 20 words AND no file path, no persona, no verb-object pair | **yes** |
| Request references a capability with no success signal ("add X") | **yes** |
| Operator typed `/brainstorming` directly | **yes** |
| Request starts with "what if" / "could we" / "would it be cool if" | **yes** |
| Request touches a library the agent hasn't used in this repo before | **yes** |
| Request is a single mechanical edit with explicit paths | **no** |
| `generate-prd` invoked us as preflight with a verbose, complete idea | **no** |

When **no**, emit:

```
brainstorming: skipped — input already complete; handing off to generate-prd directly
```

and invoke `generate-prd` with the operator's original text.

---

## Phase 1 — Ground the interview in this repo (≤3 browzer calls)

```bash
browzer status --json
browzer explore "<one noun from the request>" --json --save /tmp/brainstorm-explore.json
browzer search "<one topic from the request>" --json --save /tmp/brainstorm-search.json
```

Cap at 3 total queries. Extract: real file paths, framework pinning, `CLAUDE.md` invariants, prior art. Use these to phrase questions grounded in the actual repo.

---

## Phase 2 — The convergence checklist

The interview only ends when **every** row of the 11-dimension checklist has an answer (from the operator, from reasoning, or from research). Load `references/convergence-checklist.md` for the full checklist with resolved-when criteria and example questions per dimension.

Keep a live version of the checklist on-screen. After every answer, mark the row resolved (`✓`), partial (`~`), or open (`·`).

```bash
# clarification_audit after each answer cycle:
# Count resolved rows and surface any stalls (3+ consecutive non-resolves for a dimension)
RESOLVED=$(echo "$CHECKLIST_STATE" | grep -c "✓")
OPEN=$(echo "$CHECKLIST_STATE" | grep -c "·")
[ "$OPEN" -eq 0 ] && echo "checklist: fully resolved ($RESOLVED/11)" || echo "checklist: $RESOLVED resolved, $OPEN open"
```

---

## Phase 3 — Ask questions, one at a time

Rules for questions (load `references/convergence-checklist.md` §Example questions for per-dimension prompts):

1. **One question per message.** Multiple questions buried together get the operator to skip rows.
2. **Prefer multiple-choice** (A/B/C/D). Fall back to open-ended only when the answer space is genuinely creative.
3. **Ground the question in the repo.** Not "which database?" but "the codebase already uses `<db>` via `<orm>` in `<path>`. Should the new table land there?"
4. **Mark unresolvable rows for research** (Phase 4) — don't loop.
5. **State your working model** after every 3-5 questions. Quote back what you've understood; ask if it's right.

---

## Phase 4 — Research round (opt-in, parallel, bounded)

When the checklist has `open` rows that neither operator nor agent can resolve, offer a research round **exactly once**, with explicit cost disclosure:

> I have N open questions I can't answer from this repo alone. I can dispatch up to 3 research agents in parallel — Cost: ~1-2 extra minutes wall-clock. Run research? **[yes / no / list-questions-first]**

### 4.1 Detect available research tools

```bash
test -f ~/.claude/settings.json && node -e 'try { const s=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")); console.log(Object.keys(s.mcpServers||{}).join(",")); } catch { console.log(""); }'
test -f .claude/settings.json && node -e 'try { const s=JSON.parse(require("fs").readFileSync(".claude/settings.json")); console.log(Object.keys(s.mcpServers||{}).join(",")); } catch { console.log(""); }'
```

```bash
# clarification_audit before dispatching research:
# Verify open rows are genuine unknowns, not paraphrasable from existing browzer results
UNRESOLVABLE=$(echo "$CHECKLIST_STATE" | grep -c "·")
[ "$UNRESOLVABLE" -gt 0 ] && echo "research: $UNRESOLVABLE rows need agents" || echo "research: all rows resolvable from repo context; skipping agent dispatch"
```

### 4.2 Dispatch pattern

Queue up to 3 agents in a single assistant message (literal parallelism). Use the canonical prompt template from `references/research-agent-prompt.md` — do not rewrite it inline.

### 4.3 Consolidate

Collate results into the checklist as "researched" rows with source citations. If two agents conflict, present both answers and ask the operator — don't auto-resolve.

### 4.4 Budget discipline

At most **one** research round per brainstorm session. New questions after the first round → ship the PRD with `Assumptions` entries.

---

## Phase 5 — Present the working model and get approval

Once the checklist is fully resolved, present the convergent understanding:

```
**Working model (pre-PRD):**

- Who: <persona>
- What (outcome): <job-to-be-done>
- Success: <signal>
- Does: <in-scope, 3-5 bullets>
- Doesn't: <out-of-scope, 1-3 bullets>
- Touches: <repo surface, real paths>
- Assumes: <open rows closed by research or explicit assumption>
- Risks: <top 2-3, if salient>

Does this match your intent? Anything I've misframed? Once you confirm,
I'll persist to workflow.json and hand off to generate-prd.
```

Wait for approval. If the operator corrects a dimension, update the checklist and re-present. Only proceed to Phase 6 after explicit approval.

```bash
# clarification_audit at working model gate:
# All 11 checklist dimensions must be ✓ or explicitly noted as assumption before proceeding
UNRESOLVED=$(echo "$CHECKLIST_STATE" | grep -c "[·~]")
[ "$UNRESOLVED" -gt 0 ] && echo "WARN: $UNRESOLVED dimensions not fully resolved — record as Assumptions before hand-off"
```

---

## Phase 6 — Persist the artefact and hand off

### 6.1 Feat folder

Format: `docs/browzer/feat-<YYYYMMDD>-<kebab-slug>/`. State the path in chat before writing; wait one beat for alternate slug.

### 6.2 Initialize `workflow.json` and append STEP_01_BRAINSTORMING

```bash
mkdir -p "$FEAT_DIR"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Seed a v1 top-level skeleton if `$WORKFLOW` does not exist, then append the BRAINSTORMING step:

```bash
STEP_ID="STEP_01_BRAINSTORMING"
echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

The `brainstorm` payload shape is documented in `references/workflow-schema.md` §4. `config.mode` stays null — `orchestrate-task-delivery` will populate it.

Never edit `workflow.json` with `Read`/`Write`/`Edit`. Only `browzer workflow *`.

### 6.3 Review gate (if `config.mode == "review"`)

```bash
MODE=$(browzer workflow get-config mode --workflow "$WORKFLOW" --no-lock)
MODE=${MODE:-autonomous}
```

- `autonomous` → proceed to 6.4.
- `review` → set status to `AWAITING_REVIEW`, render `brainstorm.jq`, enter review loop. Options: Approve / Adjust / Skip / Stop per `references/workflow-schema.md` §7.

### 6.4 Hand off to generate-prd

```
Skill(skill: "generate-prd", args: "feat dir: <FEAT_DIR>")
```

---

## Phase 7 — One-line confirmation

On success:

```
brainstorming: updated workflow.json STEP_01_BRAINSTORMING; status COMPLETED; steps 1/<N>
```

On failure:

```
brainstorming: stopped at STEP_01_BRAINSTORMING — <one-line cause>
hint: <single actionable next step>
```

---

## Anti-patterns (self-check before every question)

- [ ] About to write "I assume you mean …"? → **Turn it into a question.**
- [ ] About to cite a library's API from memory? → **Run `browzer search` or dispatch a researcher.**
- [ ] Asking 2+ things in one message? → **Split. One at a time.**
- [ ] About to propose an implementation? → **Not yet. Problem first.**
- [ ] Operator said "just do it"? → **Offer a 30-second summary; get approval; then proceed.**
- [ ] Loop has gone >15 questions without progress? → **Stop, surface the stalemate, ask what's blocking them.**

---

## Non-negotiables

- **Output language: English** for the JSON payload. Conversational wrapper follows the operator's language.
- No implementation proposal until Phase 5 (Working model).
- No question limit. No shortcuts. The checklist either resolves or `openQuestions[]` notes what's open.
- One research round max, 3 agents max.
- Does not invoke `superpowers:brainstorming` — that skill is a conceptual reference, not a dependency.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

## Render-template surface

`generate-prd` and `generate-task` consume a compressed brainstorm summary via `browzer workflow get-step <step-id> --render brainstorming`. The template emits one screen of context (primary user, JTBD, success signal, scope, repo surface, open questions, assumptions, AC count) ideal for subagent dispatch prompts.
