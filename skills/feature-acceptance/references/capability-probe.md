# capability-probe.md — Phase 0 stack-agnostic detection

Reference for `feature-acceptance` Phase 0. Runs once per skill invocation
and feeds the `AskUserQuestion` mode picker. The plugin is installed into
arbitrary host repos — every probe MUST tolerate "tool absent / file
missing" gracefully and never error out the skill.

> Output contract: each probe sets a single boolean in a `caps` map. Do
> NOT keep raw stdout/stderr. Truncate any captured banner to one line.

## Probes

Run these via Bash. All probes must be non-blocking (`|| true` tail) so a
missing tool never aborts detection.

### Process / runtime

| Capability key | Detection (any one positive ⇒ true) |
| --- | --- |
| `caps.docker` | `command -v docker && docker info >/dev/null 2>&1` |
| `caps.compose` | `test -f docker-compose.yml -o -f compose.yaml -o -f docker-compose.yaml` |
| `caps.makefile` | `test -f Makefile` AND `grep -qE '^(dev|up|run|test|smoke):' Makefile` |
| `caps.node` | `command -v node` |
| `caps.python` | `command -v python3 -o command -v python` |
| `caps.go` | `command -v go` |
| `caps.rust` | `command -v cargo` |
| `caps.ruby` | `command -v ruby && (test -f Gemfile -o -f bin/rails)` |
| `caps.java` | `command -v java && (test -f pom.xml -o -f build.gradle -o -f build.gradle.kts)` |

### Package / task scripts (any-language; map of `<script-name> → <runner cmd>`)

Don't hard-code pnpm. Detect the right runner from the lockfile / project
file, then list the dev / test / smoke targets.

| File present | Runner | List targets |
| --- | --- | --- |
| `pnpm-lock.yaml` | `pnpm` | `jq -r '.scripts \| keys[]' package.json 2>/dev/null` |
| `yarn.lock` | `yarn` | same |
| `package-lock.json` or `npm-shrinkwrap.json` | `npm` | same |
| `bun.lockb` | `bun` | same |
| `Makefile` | `make` | `grep -E '^[a-zA-Z_-]+:' Makefile \| cut -d: -f1` |
| `pyproject.toml` with `[tool.poetry]` / `[project.scripts]` | `poetry run` / module | `grep -E '^\s*[a-z_-]+\s*=' pyproject.toml` (best-effort) |
| `Taskfile.yml` | `task` | `task --list-all 2>/dev/null` |
| `justfile` | `just` | `just --list 2>/dev/null` |

Filter the resulting names with this regex to surface stack-up + smoke
targets relevant to acceptance:

```
/^(dev|dev:.*|start|up|run|serve|api|web|frontend|backend|smoke|e2e|e2e:.*|test:e2e|test:integration|infra:up|stack:up)$/
```

Persist the matched names + their resolved invocation as
`caps.scripts[]`.

### Frontend / browser surface

| Capability key | Detection |
| --- | --- |
| `caps.frontend.framework` | One of `next` / `vite` / `remix` / `astro` / `nuxt` / `cra` / `angular` / `flutter-web` / `none` (probe `package.json` deps; for python: `manage.py` ⇒ Django templates; for ruby: `bin/rails` ⇒ ERB). |
| `caps.frontend.devCmd` | First positive match: `<runner> run dev`, `<runner> dev`, `make dev`, `python manage.py runserver`, `bin/rails server`, `mvn spring-boot:run`. |
| `caps.frontend.url` | Hint from `.env*` / `vite.config.*` / `next.config.*` (`PORT` / `APP_URL`); else `http://localhost:3000`. |
| `caps.playwright` | `pnpm exec playwright --version` OR `npx --no playwright --version` OR `python -m playwright --version` (any exit 0). |
| `caps.cypress` | `pnpm exec cypress --version` etc. |
| `caps.browserMcp` | `~/.claude/settings.json` `mcpServers` keys match `/chrome\|browser\|playwright/`. Project-local `.claude/settings.json` checked too. |
| `caps.agentBrowser` | `find ~/.claude/skills -maxdepth 2 -name 'agent-browser' -type d` returns a hit. |

### Backend / API surface

| Capability key | Detection |
| --- | --- |
| `caps.backend.framework` | Probe deps: `fastify` / `express` / `koa` / `hono` / `nestjs` (Node); `fastapi` / `flask` / `django` (Python); `gin` / `echo` / `chi` (Go); `actix` / `axum` (Rust); `spring-boot` (Java); `rails` (Ruby). Else `none`. |
| `caps.backend.runCmd` | First positive: `<runner> run start`, `<runner> dev`, `make api`, `go run ./cmd/...`, `cargo run`, `uvicorn app:app --reload`, `bin/rails server`, `mvn spring-boot:run`. |
| `caps.backend.url` | `.env*` `API_URL` / `PORT`; default `http://localhost:8080`. |
| `caps.curl` | `command -v curl`. |
| `caps.httpie` | `command -v http`. |

### Data stores

| Capability key | Detection |
| --- | --- |
| `caps.postgres` | `compose` file mentions `postgres`/`postgresql` image, OR `command -v psql`, OR env `DATABASE_URL` ~ `^postgres`. |
| `caps.mysql` | analog. |
| `caps.mongodb` | analog (`mongo` / `mongosh`). |
| `caps.redis` | analog. |
| `caps.neo4j` | analog. |

### Test runners

| Capability key | Detection |
| --- | --- |
| `caps.tests.unit` | Any of `vitest` / `jest` / `pytest` / `go test` / `cargo test` / `mvn test` resolvable via the detected runner. |
| `caps.tests.integration` | A `test:integration` script OR a `tests/integration/` directory. |
| `caps.tests.e2e` | A `test:e2e` / `e2e:smoke` script OR a `tests/e2e/` / `e2e/` / `cypress/` / `tests/playwright/` directory. |

## Feasibility verdict

After populating `caps`, compute one of:

| Verdict | Condition |
| --- | --- |
| `full` | The PRD's ACs/NFRs/metrics all map to capabilities present in `caps`. Concretely: every shell-runnable NFR target's verb is callable, every frontend-AC has a browser surface (Playwright OR browser MCP OR agent-browser), every backend-AC has `caps.curl` + `caps.backend.runCmd`. |
| `partial` | At least one but not all of the above hold. |
| `none` | No backend run cmd AND no frontend dev cmd AND no test runners — purely offline doc / config change. |

The verdict drives which options the Phase 0 `AskUserQuestion` exposes.
See `SKILL.md` Phase 0 for the wiring.

## Persistence

Stash the probe under `featureAcceptance.modeNote` as a one-liner
(human-readable summary). Do NOT serialize the full `caps` map into
`workflow.json` — it's recomputed each run and bloats the artefact.

Example `modeNote`:

```
caps: docker=yes compose=yes pnpm=yes scripts=[dev:local,e2e:smoke,test:integration] backend=fastify@8080 frontend=next@3001 playwright=yes browser-mcp=no agent-browser=yes; verdict=full
```
