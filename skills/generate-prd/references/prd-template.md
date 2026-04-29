# PRD template — JSON shape, field guidance, and examples

Reference for `generate-prd` Phase 3 (Assemble PRD payload). Load this file before constructing the PRD JSON object. It documents the mandatory shape, field-by-field authoring guidance, and examples.

## Full PRD JSON shape

```jsonc
{
  "title": "<feature name — noun phrase, ≤ 60 chars>",
  "overview": "<1-paragraph problem + vision prose — what pain, for whom, and the proposed outcome>",
  "personas": [
    { "id": "P-1", "description": "<one sentence: role + context + what they want to achieve>" }
  ],
  "objectives": [
    "<measurable objective — starts with an action verb, has a numeric or demoable target>"
  ],
  "functionalRequirements": [
    {
      "id": "FR-1",
      "description": "<observable system behavior — 'The system SHALL …' or 'When X, the system …'>",
      "priority": "must | should | could"
    }
  ],
  "nonFunctionalRequirements": [
    {
      "id": "NFR-1",
      "category": "perf | security | a11y | observability | scalability | reliability | maintainability | compliance",
      "description": "<requirement prose>",
      "target": "<measurable target — p99 latency, error-rate cap, WCAG level, etc.>"
    }
  ],
  "successMetrics": [
    {
      "id": "M-1",
      "metric": "<KPI name>",
      "target": "<numeric or categorical value>",
      "method": "<how measured — tool, query, manual check>"
    }
  ],
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "description": "<binary, demoable condition — 'Given X, when Y, then Z'>",
      "bindsTo": ["FR-1"]
    }
  ],
  "assumptions": [
    "<declarative sentence — something believed true that, if false, changes the spec>"
  ],
  "risks": [
    {
      "id": "R-1",
      "description": "<risk as a 'if P then Q' sentence>",
      "mitigation": "<concrete mitigation step or fallback>"
    }
  ],
  "deliverables": [
    "<concrete artifact or surface to be shipped — e.g. 'API endpoint POST /workspaces', 'dashboard page /settings/invitations'>"
  ],
  "inScope": [
    "<atomic capability we WILL deliver — specific, bounded>"
  ],
  "outOfScope": [
    "<explicit exclusion — what we will NOT do so generate-task doesn't over-reach>"
  ],
  "dependencies": {
    "external": ["<external service or API the feature depends on>"],
    "internal": ["<internal package or app the feature depends on>"]
  },
  "taskGranularity": "one-task-one-commit | grouped-by-layer"
}
```

## Field-by-field authoring guidance

### title

- Noun phrase, ≤ 60 chars.
- Example: `"Workspace invitation flow with Resend"` ✓
- Example: `"Improve the user experience"` ✗ (vague verb)

### overview

- 1 paragraph, 3–5 sentences.
- Must answer: what pain? for whom? what is the proposed outcome?
- Must NOT prescribe implementation (no file paths, no function names).
- Example: `"Workspace owners currently cannot invite collaborators without direct database access. This blocks onboarding for organizations using the SaaS plan. The invitation flow will let owners send email invitations via Resend, auto-create LGPD consent records, and link invitees to the workspace on acceptance."`

### personas

- One entry per distinct actor type.
- Description sentence: `"<role> who <context> and wants to <goal>"`.
- Example: `{ "id": "P-1", "description": "Workspace owner who manages a paid team and wants to add members without engineering help" }`

### objectives

- 1–5 bullets. Each starts with a verb. Each has a numeric or demoable target.
- Example: `"Reduce time-to-first-invitation to < 60 seconds for a workspace owner"`
- Example: `"Ship the feature behind a feature flag so rollback takes < 2 minutes"` ✓

### functionalRequirements

- `priority` levels:
  - `must` — feature is broken without this; ship blocker.
  - `should` — strongly desired; include unless time/complexity forces deferral.
  - `could` — nice-to-have; defer to v2 if needed.
- Description must be an observable behavior — something a QA engineer can test.
- Bad: `"Handle invitation errors"` — what does "handle" mean?
- Good: `"When invitation send fails (Resend API returns non-2xx), the system SHALL display an error toast and retain the invite form state"` ✓
- Every FR must be referenced by at least one AC via `bindsTo`.

### nonFunctionalRequirements

- Categories: `perf`, `security`, `a11y`, `observability`, `scalability`, `reliability`, `maintainability`, `compliance`.
- `target` must be measurable — do not write `"should be fast"`.
- Example: `{ "id": "NFR-2", "category": "security", "description": "Invitation tokens must be single-use and expire after 7 days", "target": "Token verified via HMAC-SHA256; expiry enforced at DB layer" }`
- Repo-level invariants discovered from CLAUDE.md (security rules, layering, testing policy) are GIVENS — list them in NFRs only if the feature **changes** them.

### successMetrics

- Track the objective signals post-ship.
- `method` must be concrete — e.g. `"Postgres query on invitations table"`, `"Grafana panel 'invitation success rate'"`, `"Manual: invite flow walkthrough in staging"`.
- Example: `{ "id": "M-1", "metric": "Invitation acceptance rate", "target": "≥ 70% within 48h of send", "method": "SELECT COUNT(*) FROM invitations WHERE accepted_at IS NOT NULL / total in first 48h" }`

### acceptanceCriteria

- Binary: either the condition holds or it doesn't. No partial credit.
- Format: `"Given <precondition>, when <action>, then <observable outcome>"`.
- IDs must be stable (`AC-1`, `AC-2`, …); never renumber — downstream skills index into these by ID.
- Example: `{ "id": "AC-3", "description": "Given an invitation token older than 7 days, when the invitee clicks the link, then they see an error page 'This invitation has expired'", "bindsTo": ["FR-4"] }`
- `bindsTo` is a 1-to-many link — an AC may bind multiple FRs if it tests a combination.

### assumptions

- Declarative sentences starting with a noun or subject.
- Each assumption is something believed true that, if false, changes the spec.
- Surface-collision assumptions (§2.7 of SKILL.md) go here verbatim.
- Example: `"Resend is already configured in the production environment with a verified sending domain"` ✓
- Example: `"The feature is wanted"` ✗ (too vague to be falsifiable)

### risks

- `description` as `"if <condition> then <consequence>"`.
- `mitigation` must be a concrete action, not `"we will be careful"`.
- Example: `{ "id": "R-1", "description": "If Resend experiences an outage, invitation emails will not be delivered", "mitigation": "Queue invitation sends via BullMQ with retry-on-failure; surface outage in the ops dashboard" }`

### inScope / outOfScope

- `inScope`: atomic capabilities, 1–2 lines each. Specific enough that `generate-task` can directly decompose them into files.
- `outOfScope`: explicit exclusions. Include anything a reader might reasonably expect that you are deliberately NOT doing.
- Example in scope: `"POST /api/invitations endpoint that validates email, creates invitation row, and sends via Resend"`
- Example out of scope: `"Bulk invite (CSV upload) — deferred to v2"`

### dependencies

- `external`: third-party services, APIs, or infra (e.g. `"Resend API"`, `"Stripe webhooks"`).
- `internal`: packages or apps this feature extends (e.g. `"@browzer/db"`, `"apps/auth"`). Use real package names from browzer explore results.

### taskGranularity

- `one-task-one-commit` (default): one TASK per atomic unit of work; each task ships its own commit. Use for most features.
- `grouped-by-layer`: tasks grouped by architectural layer (e.g. DB + API + UI as three tasks). Use for thin-slice features where each layer is trivially small and combining saves orchestration overhead.

## Completeness checklist

Before sealing the PRD, verify:

- [ ] Every FR has at least one AC bound to it via `bindsTo`.
- [ ] Every AC can be checked by a QA engineer without access to source code.
- [ ] `outOfScope` addresses at least one thing a reader might reasonably expect.
- [ ] `dependencies.internal` lists real package names verified by browzer results.
- [ ] No invented file paths or function names appear in any field.
- [ ] No vague verbs: "handle", "improve", "work well", "support", "manage" — each must be replaced with observable behavior.
- [ ] Surface-collision check (§2.7 of SKILL.md) ran if screens AND endpoints are both listed.
