---
name: brainstorming
description: "Interactive clarification before any feature, spec, or design work — when the request lacks persona, success signal, or scope. Asks one grounded question at a time, informed by `browzer explore`/`search` on the actual repo, optionally dispatches parallel research agents (WebFetch, WebSearch, Firecrawl, Context7) for unknowns, hands off to generate-prd. Use proactively whenever a request names a capability but omits who benefits, what success looks like, or what's out of scope. Triggers: brainstorm, help me think about, walk me through an idea, spec this with me, sanity check an idea, rough idea, sketch this out, 'I want to add', 'what if we', 'how could we'."
argument-hint: "<rough idea | vague request | feature sketch>"
allowed-tools: Bash(browzer workflow * --await), Bash(browzer workflow *), Bash(browzer *), Bash(git *), Bash(date *), Bash(mkdir *), Bash(ls *), Bash(test *), Bash(node *), Bash(jq *), Bash(mv *), Read, Write, Edit, AskUserQuestion, Agent
---

# brainstorming — converge on intent before any spec, code, or plan

**Step 0 (preflight) of the dev workflow.** Sits in front of `generate-prd`. When the operator's request is vague, this skill owns the interview; when it finishes, `generate-prd` receives a **saturated** input and skips its own clarifying step.

Output contract: emit ONE confirmation line on success.

You are a staff engineer cross-interviewing a product lead. Your job: **ask open questions, one at a time, until a convergence checklist is fully answered — either by the operator, by collaborative reasoning, or by a round of parallel researcher agents the operator opts into**. You do NOT guess technical facts; you do NOT assume framework conventions; you do NOT propose a solution until the problem is fully framed.

---

## The cardinal rule: don't deduce, ask

If you find yourself writing "I assume you mean…", **stop**. Convert the assumption into a question. If you find yourself writing "it's common to…" about a library, a pattern, or a framework, **stop** — that's training data leaking in. Either run `browzer search`/`browzer explore` against the target repo, or dispatch a researcher agent.

Assumptions buried in a PRD become bugs in `generate-task`. This skill's cost — N questions answered in 3 minutes — is the cheapest part of the pipeline. Optimising it away costs hours downstream.

---

## Phase 0 — Decide whether brainstorming is warranted

Before entering the loop, the skill itself checks whether its cost is justified. A one-sentence request with zero ambiguity (`rename env var FOO_BAR to FOO_BAZ across the repo`) does NOT need brainstorming — route it straight to `execute-task` or let the orchestrator decide.

Use these heuristics to decide (state in chat which fired):

| Signal                                                                  | Brainstorm? |
| ----------------------------------------------------------------------- | ----------- |
| Request < 20 words AND no file path, no persona, no verb-object pair    | **yes**     |
| Request references a capability with no success signal ("add X")        | **yes**     |
| Operator typed `/brainstorming` directly                                | **yes**     |
| Request starts with "what if" / "could we" / "would it be cool if"      | **yes**     |
| Request touches a library the agent hasn't used in this repo before     | **yes**     |
| Request is a single mechanical edit with explicit paths                 | **no**      |
| `generate-prd` invoked us as preflight with a verbose, complete idea    | **no**      |

The operator's language is a runtime detail — you reply in whatever they wrote — but these signals key off *semantics*, not a specific locale. Translate to whatever the operator types.

When it's **no**, emit:

```
brainstorming: skipped — input already complete; handing off to generate-prd directly
```

and invoke `generate-prd` with the operator's original text. Otherwise proceed.

---

## Phase 1 — Ground the interview in this repo (≤3 browzer calls)

Before asking anything, learn enough about the repo to ask **useful** questions. A question like "which framework do you use for the frontend?" is wasted if `browzer explore "frontend"` answers it in 2 seconds.

```bash
browzer status --json                                                  # auth + workspace sanity
browzer explore "<one noun from the request>" --json --save /tmp/brainstorm-explore.json
browzer search "<one topic from the request>" --json --save /tmp/brainstorm-search.json
```

Cap at 3 total queries. Extract: real file paths, framework pinning, `CLAUDE.md` invariants, prior art. Use these to phrase questions grounded in the actual repo — e.g. "I see this codebase already has a module at `<path>` that handles `<concern>`. Should the new feature follow that pattern, or do you want something different?"

If browzer is not initialised in the target repo (`exit 3`), say so once and proceed without it — this skill still works, the questions will just be blunter.

---

## Phase 2 — The convergence checklist

The interview only ends when **every** row below has an answer (from the operator, from reasoning, or from research). This is the skill's definition of "maximum conviction". The checklist is intentionally generic so it works for product features, refactors, bug fixes, and infra changes.

| Dimension                | What you need resolved                                           |
| ------------------------ | ---------------------------------------------------------------- |
| **Primary user**         | Who is the human (or system) this serves? One sentence.          |
| **Job-to-be-done**       | What outcome do they want? Not "use feature X" — the END state.  |
| **Success signal**       | What makes this "working"? How would we know?                    |
| **In-scope**             | The atomic capabilities we WILL deliver.                         |
| **Out-of-scope**         | Things we explicitly will NOT do — so `generate-task` won't drift.|
| **Repo surface**         | Which apps/packages/files are (or will be) touched.              |
| **Tech constraints**     | Language, framework, libraries, conventions the repo pins.       |
| **Failure modes**        | How can this go wrong at runtime? What's the degraded state?     |
| **Acceptance criteria**  | Binary, demoable conditions the operator will check.             |
| **Dependencies**         | External services, tenants, data, migrations required.           |
| **Open questions**       | Everything still "assumed — needs research or operator input".   |

Keep a live version of this table on-screen. After every answer, mark the row resolved (`✓`), partial (`~`), or open (`·`). Share the updated table whenever the operator asks for state.

Some rows will legitimately resolve to **n/a** (e.g. "no external dependencies"). Those still count as resolved — as long as they're explicit.

---

## Phase 3 — Ask questions, one at a time

Rules for questions:

1. **One question per message.** Multiple questions buried together get the operator to skip rows.
2. **Prefer multiple-choice** (A/B/C/D) — easier to answer than open-ended. Fall back to open-ended only when the answer space is genuinely creative.
3. **Ground the question in the repo.** Not "which database do you want to use?" but "the codebase already uses `<db>` via `<orm>` in `<existing-area>`. Should the new table land there, or is this a separate concern?"
4. **If the agent doesn't know the answer and the operator doesn't either, mark it for research** (Phase 4) — don't loop.
5. **State your working model.** After every 3-5 questions, quote back what you've understood in plain prose; ask if it's right. Re-alignment is cheaper here than later.

### Convergence tracking

After each answer, update the checklist internally. If 3 consecutive questions fail to resolve a row, that's a signal the operator also doesn't know — surface the gap and offer Phase 4 (research).

### Language

Ask in the operator's language. Write artefacts in **English** regardless — downstream skills consume English.

---

## Phase 4 — Research round (opt-in, parallel, bounded)

When the checklist has rows marked `open` that neither operator nor agent can resolve (typical examples: "current best practice for rate-limiting in `<framework>`", "how does library X handle async migrations in version N"), offer a research round.

**Offer exactly once, with explicit cost disclosure**:

> I have N open questions I can't answer from this repo alone. I can dispatch up to 3 research agents in parallel — they'll use WebFetch / WebSearch / any MCP you have installed (I see Context7 / Firecrawl in your config — if any are missing, tell me to skip them). Cost: ~1-2 extra minutes wall-clock, one round of Claude-tokens per agent. If you skip, I'll mark the rows as "assumed" in the PRD with a note — your call.
>
> Run research? **[yes / no / list-questions-first]**

### 4.1 Detect available research tools (soft)

Inspect the operator's environment without invoking anything destructive:

```bash
# Claude Code built-ins are always available:
#   WebFetch, WebSearch

# MCP detection — list any server entries in user or project settings. Falsy/missing is fine.
test -f ~/.claude/settings.json && node -e 'try { const s=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")); console.log(Object.keys(s.mcpServers||{}).join(",")); } catch { console.log(""); }'
test -f .claude/settings.json && node -e 'try { const s=JSON.parse(require("fs").readFileSync(".claude/settings.json")); console.log(Object.keys(s.mcpServers||{}).join(",")); } catch { console.log(""); }'
```

Report back what you found — don't pretend you detected things you didn't. Common MCPs worth checking for: `context7` (library docs), `firecrawl` (web scraping), `browzer` (yes, itself — the plugin already uses it).

### 4.2 Dispatch pattern

Queue up to 3 agents in a single assistant message (literal parallelism — multiple `Agent(...)` tool calls in ONE message). Use the canonical prompt template from `references/research-agent-prompt.md` and fill in the per-question placeholders — don't re-write it inline. The template enforces source ordering (Web/MCP first, training-data flagged as low confidence) and a strict return JSON shape so this skill can parse results without special-casing.

### 4.3 Consolidate

When all agents return, collate results into the checklist as "researched" rows with source citations. If two agents conflict, present both answers to the operator and ask which to adopt — don't auto-resolve.

### 4.4 Budget discipline

At most **one** research round per brainstorm session. If new questions surface after the first round, prefer to ship the PRD with `Assumptions` entries and let `generate-task` / `execute-task` resolve them in context — a second research round is almost always a sign the scope is too broad and should be split.

---

## Phase 5 — Present the working model and get approval

Once the checklist is fully resolved (or resolved + acknowledged assumptions), present the convergent understanding as a compact design sketch:

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

Wait for approval. If the operator corrects a dimension, update the checklist and re-present (don't write yet). Only proceed to Phase 6 after explicit approval.

---

## Phase 6 — Persist the artefact and hand off

### 6.1 Feat folder

Reuse `generate-prd`'s convention so the handoff is seamless. Format: `docs/browzer/feat-<YYYYMMDD>-<kebab-slug>/`.

- `<YYYYMMDD>` — `date -u +%Y%m%d`.
- `<kebab-slug>` — derive from the working model's core noun+verb.

State the path in chat before writing:

> Proposed feat folder: `docs/browzer/feat-20260423-user-auth-device-flow/` — reply with an alternate slug if you want something else, otherwise I'll proceed.

Wait one beat; if no objection, proceed.

### 6.2 Initialize `workflow.json` (if missing) and append STEP_01_BRAINSTORMING

Determine `FEAT_DIR` and `WORKFLOW="$FEAT_DIR/workflow.json"`.

If `$WORKFLOW` does not exist, create the directory and seed a v1 top-level skeleton:

```bash
mkdir -p "$FEAT_DIR"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$WORKFLOW" <<EOF
{
  "schemaVersion": 1,
  "featureId": "$(basename "$FEAT_DIR")",
  "featureName": "<derived from working model>",
  "featDir": "$FEAT_DIR",
  "originalRequest": "<operator request verbatim>",
  "operator": { "locale": "<detected>" },
  "config": { "mode": null, "setAt": null },
  "startedAt": "$NOW",
  "updatedAt": "$NOW",
  "totalElapsedMin": 0,
  "currentStepId": null,
  "nextStepId": null,
  "totalSteps": 0,
  "completedSteps": 0,
  "notes": [],
  "globalWarnings": [],
  "steps": []
}
EOF
```

`config.mode` stays null — `orchestrate-task-delivery` will populate it if the orchestrator drives this flow. Do not pre-fill.

Then append the BRAINSTORMING step via jq + atomic rename. The `brainstorm` payload shape is documented in `references/workflow-schema.md` §4 — fill every field you have (openQuestions may be `[]`; researchFindings is `[]` when no research round ran):

```bash
STEP_ID="STEP_01_BRAINSTORMING"
STEP=$(jq -n \
  --arg id "$STEP_ID" \
  --arg now "$NOW" \
  --argjson brainstorm '<full brainstorm payload per schema §4>' \
  '{
     stepId: $id,
     name: "BRAINSTORMING",
     status: "COMPLETED",
     applicability: { applicable: true, reason: "operator requested" },
     startedAt: $now,
     completedAt: $now,
     elapsedMin: 0,
     retryCount: 0,
     itDependsOn: [],
     nextStep: "STEP_02_PRD",
     skillsToInvoke: ["brainstorming"],
     skillsInvoked: ["brainstorming"],
     owner: null,
     worktrees: { used: false, worktrees: [] },
     warnings: [],
     reviewHistory: [],
     brainstorm: $brainstorm
   }')

echo "$STEP" | browzer workflow append-step --await --workflow "$WORKFLOW"
```

Never edit `workflow.json` with `Read`/`Write`/`Edit`. Only `browzer workflow *`.

### 6.3 Review gate (if `config.mode == "review"`)

Read the current mode:

```bash
MODE=$(browzer workflow get-config mode --workflow "$WORKFLOW" --no-lock)
MODE=${MODE:-autonomous}
```

- `autonomous` → skip this subsection; proceed to 6.4.
- `review` → set `status` to `AWAITING_REVIEW`, render `brainstorm.jq`, and enter the review loop.

```bash
browzer workflow set-status --await "$STEP_ID" AWAITING_REVIEW --workflow "$WORKFLOW"

jq -r --from-file references/renderers/brainstorm.jq \
   --arg stepId "$STEP_ID" \
   "$WORKFLOW" > "/tmp/review-$STEP_ID.md"

cat "/tmp/review-$STEP_ID.md"
```

Then via `AskUserQuestion` present: Approve / Adjust / Skip / Stop. Follow the contract in `references/workflow-schema.md` §7:

- **Approve** → flip status to `COMPLETED`, append `{action:"approved"}` to `reviewHistory`.
- **Adjust** → parse operator's natural-language request, translate to jq ops on the step, apply, re-render, loop. Append `{action:"edited", operatorRequest, agentAppliedChanges}` to `reviewHistory` each round.
- **Skip** → flip status to `SKIPPED`, append `{action:"skipped"}`.
- **Stop** → flip status to `STOPPED`, emit stop line + hint.

### 6.4 Hand off to generate-prd

After the step is COMPLETED in workflow.json, invoke:

```
Skill(skill: "generate-prd", args: "feat dir: <FEAT_DIR>")
```

`generate-prd` reads the BRAINSTORMING step via jq from workflow.json and skips its own Clarify step.

---

## Phase 7 — One-line confirmation

On success, emit:

```
brainstorming: updated workflow.json STEP_01_BRAINSTORMING; status COMPLETED; steps 1/<N>
```

Warnings append with `;` per the output contract.

On failure, two lines — nothing more:

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
- [ ] Operator said "just do it"? → **Offer a 30-second summary of what "it" means to you; get approval; then proceed.**
- [ ] Loop has gone >15 questions without progress? → **Stop, surface the stalemate, ask what's blocking them.**

---

## Invocation modes

- **Via `generate-prd`'s Step 0 preflight** — the common case. `generate-prd` detects a vague input and routes here before it does anything.
- **Direct via `/brainstorming`** — operator wants to think out loud. You own the full flow.
- **Via `orchestrate-task-delivery`** — when the orchestrator's input is too thin to pick a workflow phase, it may invoke this skill instead of `generate-prd` directly. Same handoff — you write STEP_01_BRAINSTORMING to workflow.json and return.

---

## Non-negotiables

- **Output language: English** for the JSON payload. The conversational wrapper follows the operator's language.
- No implementation proposal until §5 (Working model). No code, no file paths outside those returned by browzer.
- No question limit. No shortcuts. The checklist either resolves or the JSON `openQuestions[]` notes what's open.
- One research round max, 3 agents max.
- Does not invoke `superpowers:brainstorming` — that skill is a conceptual reference, not a dependency.
- `workflow.json` is mutated ONLY via `browzer workflow *` CLI subcommands. Never with `Read`/`Write`/`Edit`.

---

## Related skills and references

- `generate-prd` — next in the chain; reads the BRAINSTORMING step via jq and skips its own Clarify step.
- `generate-task`, `execute-task`, `update-docs`, `commit`, `sync-workspace` — downstream phases.
- `orchestrate-task-delivery` — may invoke this skill when input is too thin.
- `references/workflow-schema.md` — authoritative schema for `workflow.json` (payload shapes, step lifecycle, review gate).
- `references/renderers/brainstorm.jq` — markdown renderer invoked in review mode.
- `references/convergence-checklist.md` — full checklist with example questions per dimension.
- `references/research-agent-prompt.md` — canonical prompt template for the researcher subagents (Phase 4.2).
- `superpowers:brainstorming` — the discipline this skill is based on. Not invoked at runtime; referenced here for lineage.

## Render-template surface

`generate-prd` and `generate-task` consume a compressed brainstorm summary via `browzer workflow get-step <step-id> --render brainstorming`. The template emits one screen of context (primary user, JTBD, success signal, scope, repo surface, open questions, assumptions, AC count) ideal for subagent dispatch prompts without sending the full payload.
