# manual-instructions.md — Templates for human-runnable verification steps

Reference for `feature-acceptance` Phase 2.7 (manual + hybrid). Every AC,
NFR, or success metric the skill cannot run autonomously MUST be emitted
with a concrete, copy-pasteable instruction block. Vague prose like
"verify the feature works" is rejected.

Pick the template that matches the surface the AC lives on. Combine
templates when an AC spans surfaces (e.g. UI triggers an API call). Fill
every `<placeholder>` from the PRD + capability probe; never leave a
placeholder unresolved.

## Backend endpoint (HTTP API)

```
AC-<n>: <verbatim AC text>

How to verify (manual):
  1. Start the API:
       <caps.backend.runCmd>
     Wait until it logs "<ready signal from PRD or framework default>".
  2. Obtain an auth token (if the route requires it):
       <command from PRD auth section, OR: skip if route is public>
  3. Hit the endpoint:
       curl -i -X <METHOD> <caps.backend.url><PATH> \
         -H 'Authorization: Bearer $TOKEN' \
         -H 'Content-Type: application/json' \
         -d '<JSON body from PRD>'
  4. Expected: HTTP <status>, response body matches:
       <shape excerpt from PRD>
  5. Reply with the response status + first 20 lines of the body.
```

When `caps.httpie` is present and `caps.curl` is not, swap step 3 for the
HTTPie equivalent (`http POST <url> <key>=<value>`).

## Frontend screen / interaction

```
AC-<n>: <verbatim AC text>

How to verify (manual):
  1. Start the stack:
       <caps.frontend.devCmd>
     (If the screen depends on the API: also run <caps.backend.runCmd> in a second terminal.)
  2. Open <caps.frontend.url><ROUTE> in your browser.
  3. Sign in with: <test credentials from PRD or .env.test>.
  4. Click <element selector or visible label>.
  5. Expected: <observable result from PRD — toast text, redirect URL,
     element appearing, etc.>.
  6. Reply with a screenshot OR a one-line description of what you saw.
```

If the AC describes a flow (multiple clicks), number every click + every
expected post-condition between clicks. Do NOT collapse to "navigate the
flow".

## CLI / script

```
AC-<n>: <verbatim AC text>

How to verify (manual):
  1. Run:
       <exact command, including args and flags from the PRD>
  2. Expected exit code: <0 | other>.
  3. Expected stdout contains: <substring from PRD>.
  4. Expected side effect (if any): <file written / row inserted / job
     enqueued>. Probe with:
       <follow-up command — `ls -la <path>`, `psql -c 'select ...'`,
       `redis-cli LRANGE <queue> 0 -1>`.
  5. Reply with the exit code + the relevant stdout/stderr line.
```

## Database / migration

```
AC-<n>: <verbatim AC text>

How to verify (manual):
  1. Apply the migration:
       <migrate command — `<runner> drizzle-kit migrate`,
        `python manage.py migrate`, `bin/rails db:migrate`, etc.>
  2. Connect to the DB:
       <psql / mysql / mongosh / cypher-shell connect string from
       caps.<store> + .env>
  3. Run the verification query:
       <SQL/Cypher/Mongo query asserting the schema or row state from PRD>
  4. Expected result: <exact rows / count / shape>.
  5. Reply with the query output (truncate to 20 rows).
```

## Background job / worker

```
AC-<n>: <verbatim AC text>

How to verify (manual):
  1. Start the worker:
       <caps.backend.runCmd alt — worker entrypoint>
  2. Enqueue the trigger:
       <command or API call from PRD that produces the job>
  3. Watch the worker log for:
       <log line from PRD or framework default>
  4. Probe the side effect:
       <DB query, file check, downstream API call>
  5. Reply with the log line + side-effect probe output.
```

## NFR — performance / load

```
NFR-<n>: <verbatim NFR text>, target <target>.

How to verify (manual):
  1. Start the stack: <caps.backend.runCmd> (+ frontend if relevant).
  2. Run the load harness:
       <k6 / wrk / autocannon / pytest-benchmark command from PRD>
  3. Compare measured p95/p99 (or RPS) to the target above.
  4. Reply with the harness summary (truncate to 20 lines).
```

## NFR — security / auth

```
NFR-<n>: <verbatim NFR text>.

How to verify (manual):
  1. Start the API: <caps.backend.runCmd>.
  2. Reproduce the negative case:
       curl -i <caps.backend.url><PATH>     # no token
       curl -i -H 'Authorization: Bearer wrong' <caps.backend.url><PATH>
       <cross-tenant probe — second org's token against first org's resource>
  3. Expected: HTTP 401 / 403 (no leakage), and no 5xx.
  4. Reply with status codes + first error body line for each probe.
```

## NFR — accessibility (a11y)

```
NFR-<n>: <verbatim NFR text>.

How to verify (manual):
  1. Start the frontend: <caps.frontend.devCmd>.
  2. Open <caps.frontend.url><ROUTE>.
  3. Run an axe-core scan (any one):
     - Browser DevTools → Lighthouse → Accessibility.
     - `pnpm exec playwright test <a11y spec>` if Playwright is
       configured with `@axe-core/playwright`.
     - Manual: tab through the UI, confirm focus order + visible focus ring.
  4. Reply with the violation count + top 3 violations (or "0 violations").
```

## Composition rules

- Every block ends with **"Reply with…"** — the operator's reply is what
  resolves the `operatorActionsRequested[]` entry. No "reply"
  instruction ⇒ skill is non-compliant.
- Resolve every `<placeholder>` from the PRD + capability probe BEFORE
  emitting the block. If a placeholder cannot be resolved (e.g. PRD
  doesn't say what selector to click), record the gap as a separate
  `operatorActionsRequested[]` entry of `kind: "manual-verification"`
  with `description: "AC-<n> under-specified — operator must clarify
  <missing field>"` rather than emitting a half-filled template.
- Group blocks by surface in the rendered checklist (backend → frontend
  → DB → worker → NFR), not by AC index, so an operator working in one
  context can run several checks together.
- For hybrid mode: emit ONE consolidated `## Manual residue` section at
  the bottom of the run summary, containing only items the autonomous
  pass could not verify. Items the autonomous pass DID verify go in
  `acceptanceCriteria[]` / `nfrVerifications[]` as usual; do NOT
  duplicate them as manual instructions.
