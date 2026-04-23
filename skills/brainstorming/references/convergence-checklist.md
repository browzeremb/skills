# Convergence Checklist

Reference for the `brainstorming` skill. Load when you need example questions per dimension, or when the skill stalls and you need prompts to unstick the conversation.

## The checklist

An interview only ends when every row has a resolved answer — from the operator, from reasoning grounded in the repo, or from a research agent round. "Resolved" includes explicit `n/a` with a one-line reason.

| # | Dimension | Resolved when |
|---|-----------|---------------|
| 1 | Primary user | You can name WHO this serves in one sentence, specific enough that `generate-task` can attach an acceptance criterion to their behaviour. |
| 2 | Job-to-be-done | You know the OUTCOME the user wants, not the feature name. "I want to use the new wizard" is not a JTBD; "I want to onboard 5 teammates in under 10 minutes" is. |
| 3 | Success signal | You know what "it works" means: a metric, a user-visible change, a state transition, or a manual demo script. |
| 4 | In-scope | You have 2-7 atomic capabilities that WILL ship. |
| 5 | Out-of-scope | You have at least 1-3 things that WILL NOT ship, so `generate-task` doesn't over-reach. |
| 6 | Repo surface | You have real paths returned by `browzer explore` for every area that will be touched, OR the explicit note "greenfield, no indexed code yet". |
| 7 | Tech constraints | You've named the language, framework, and key libraries pinned in the repo's manifests. |
| 8 | Failure modes | You've named 2-4 ways this can go wrong at runtime (network, bad input, concurrency, quota, etc.) and the intended degradation. |
| 9 | Acceptance criteria | Each criterion is binary and demoable — not "quality improves" but "user X does Y and sees Z". |
| 10 | Dependencies | You know what has to exist or be provisioned outside this change (a new table, an env var, a third-party account, a feature flag). |
| 11 | Open questions | Everything the operator or you flagged as "not sure yet". Each has a disposition: answered by research, deferred to PRD Assumptions, or acknowledged risk. |

## Example questions per dimension

Use these when you don't know what to ask. Prefer multiple-choice shapes. Always replace placeholders with real context from the repo.

### 1. Primary user

- "Who is this for? (a) end users of `<app>`, (b) operators / SRE, (c) internal teammates in another team, (d) AI agents / other services — pick one."
- "When you picture the person benefitting from this, what's their role + the moment they'd trigger it?"
- "Is this for a specific tenant / segment / plan, or all users?"

### 2. Job-to-be-done

- "Walk me through the before state — what are they doing today that's painful?"
- "After this ships, what's different for them in a concrete moment?"
- "If this were a sentence on a changelog, how would a non-technical teammate write it?"

### 3. Success signal

- "Six months from now, how would we know this worked? (a) a metric moves, (b) a support-ticket category goes away, (c) a demo script we couldn't run before now works, (d) something else."
- "What's the smallest demonstration of success you'd accept?"

### 4. In-scope

- "Which of these is the MUST-have for v1? [list 3-5 candidates]"
- "If we could only ship half, which half?"

### 5. Out-of-scope

- "What's something adjacent to this that we might confuse with the real scope, but that we are explicitly NOT doing?"
- "What's the 'nice to have' you'd drop if estimation doubles?"

### 6. Repo surface

- "I see `<path from browzer>` already handles `<concept>` — should the new thing live there, or does it warrant a new module?"
- "Does this touch `apps/<x>`, `apps/<y>`, or both? (browzer shows imports between them)"

### 7. Tech constraints

- "Is there a specific library / framework version you need to stay on, or can we pick freely?"
- "Does your CLAUDE.md name any invariants that apply here? (I found: <list from browzer search>)"

### 8. Failure modes

- "When this fails at runtime, what do you want the user to see?"
- "Is there a retry / fallback expected, or should it hard-fail?"
- "Anything about the data (size, rate, tenancy) that makes the naive path unsafe?"

### 9. Acceptance criteria

- "What's a sentence that starts with 'a user can…' and ends with a verifiable outcome?"
- "How many of these do we need before you'd merge? (a) 1-2, (b) 3-5, (c) 5+, (d) every case I can think of must be covered first."

### 10. Dependencies

- "Does this need a new table / column / index?"
- "A new env var or config secret?"
- "An external service or third-party account?"
- "A feature flag or canary channel?"

### 11. Open questions

- "Anything you're not sure about yet where you want me to research the current best practice?"
- "Is there a library or pattern you've seen somewhere that you want to explore here?"

## Stall signals

If the operator answers the same dimension 3 times with "not sure" or "whatever makes sense", that's a stall. Options:

1. **Propose a concrete shape** — "Given what I've heard, a plausible answer is X. Does X work?"
2. **Offer research** — that dimension is a candidate for the research round.
3. **Mark as assumption** — explicitly "I'll record this as assumed in the PRD; `generate-task` and `execute-task` will pick it up from there."

Never silently invent an answer. Assumptions are legitimate; hidden assumptions are bugs.

## When the checklist is "done"

All 11 rows resolved. At that point, present the working model (Phase 5 of the skill) and ask for approval. Only after explicit approval do you write `BRAINSTORM.md` and hand off to `generate-prd`.
