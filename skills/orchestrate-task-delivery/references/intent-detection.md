# Intent detection — operator prompt routing

The orchestrator dispatches based on operator intent + filesystem state.
This ref documents the heuristics for two routing decisions:

1. **Brainstorming gate** — when is brainstorming needed before PRD?
2. **Mid-workflow entry** — is the operator asking the orchestrator OR a single phase skill?

---

## Brainstorming gate

When invoked with no prior feat folder, the orchestrator decides whether
to dispatch `brainstorming` first or jump straight to `generate-prd`.

### Heuristic

Examine the operator's verbatim request (the `originalRequest` text)
against four dimensions:

1. **Persona** — does the request name WHO benefits? (e.g. "developers using X", "operators of Y", "end users of Z")
2. **Success signal** — does the request name HOW we measure success? (e.g. "should reduce latency by 50%", "such that operators can X")
3. **In-scope** — does the request explicitly name what's included? (e.g. specific files, features, APIs)
4. **Out-of-scope** — does the request explicitly name what's excluded? (e.g. "but not Y", "leave Z alone")

Score each dimension `present | absent | implicit`. Decision:

| Score | Action |
|---|---|
| 3-4 of 4 `present` | Skip brainstorming → dispatch `generate-prd` directly. Synthesize a minimal `BRIEF.md` from the request as `$contextInput`. |
| 2 of 4 `present` | Ask the operator: "Do you want me to brainstorm first or go straight to PRD?" via `AskUserQuestion`. Default: brainstorm. |
| 0-1 of 4 `present` | Dispatch `brainstorming` — input is too thin for a useful PRD without clarification. |

The operator MAY force one or the other via explicit phrasing
("brainstorm this", "draft a PRD directly").

### Examples

- "Add a per-tenant rate limit to the HTTP API; cap at 100 req/min, return 429 with `Retry-After`" → persona implicit (API operators + SDK consumers), success explicit (cap + 429 contract), in-scope explicit (HTTP middleware), out-of-scope absent → score 3/4 → **skip brainstorming**.
- "I want to make billing better" → all 4 absent → **brainstorm**.
- "Refactor the auth flow — we keep hitting TOCTOU on session refresh, callers should get a single atomic check+update, and we should keep the existing `validateSession()` signature" → all 4 present → **skip brainstorming**.

---

## Mid-workflow entry

When the operator prompt names a specific phase skill or a specific
artefact (not "build this end-to-end"), route to the named skill
directly — do NOT engage the orchestrator's state machine.

### Direct-skill phrasings

| Phrase | Skill |
|---|---|
| "execute TASK_03 for `<feat>`" / "run TASK_03" | `execute-task <feat> TASK_03` |
| "code review for `<feat>`" / "review my changes" / "audit `<feat>`" | `code-review <feat>` |
| "re-run the quality gate" / "validate fixes" / "check post-fix regressions" | `regression-guard <feat>` |
| "is `<feat>` ready" / "acceptance check `<feat>`" | `feature-acceptance <feat>` |
| "finalize `<feat>`" / "write the README" / "update the docs for `<feat>`" / "sync the docs" | `finalize-feature <feat>` (handles both doc-patching and README) |
| "commit this" / "commit `<feat>`" | `commit [<feat>]` |
| "brainstorm `<topic>`" / "let's spec out `<idea>`" | `brainstorming <feat>` |

### Orchestrator phrasings

| Phrase | Action |
|---|---|
| "build this end-to-end" / "ship this feature" / "drive the workflow" / "let's start" | full orchestrator from initial state |
| "continue `<feat>`" / "resume `<feat>`" / "what's next for `<feat>`" | orchestrator state machine from current filesystem |
| "build `<idea>`" (no feat exists yet) | initialize → state machine |

### Ambiguous phrasings

When the operator says something like "do the next thing for `<feat>`"
without specifying which phase, the orchestrator runs the state machine
(filesystem inspection) and dispatches the result.

When the operator says something like "is this done?" without a feat
id and without a phase, ask via `AskUserQuestion`: "Which feature? Or
do you want a general 'how does the orchestrator work' walkthrough?"

---

## Operator override

The operator's explicit phrasing ALWAYS wins. If they say "skip
brainstorming and draft a PRD" even when the heuristic says brainstorm,
honor the override. Record the override in `DELEGATION_TRACE.md`:

```
<RFC3339> orchestrator → operator-override: brainstorming-skipped (reason: explicit operator request)
```
