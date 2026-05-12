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

## CLI binary detection (generic)

This section defines how to populate `caps.cli` during the capability probe
step. All sub-steps are BEST-EFFORT — a failure at any point leaves
`caps.cli.binary` unset and the caller silently skips the CLI-staleness check.

### Detection steps

1. **Discover a candidate binary name.**
   Look for a CLI name in this order (first non-null wins):
   - PRD acceptance criteria or feature description: scan for phrases like
     `the <name> CLI`, `<name> binary`, `<name> command`.
   - `package.json#bin` (if present): `jq -r '.bin | keys[]' package.json 2>/dev/null | head -1`
   - `Makefile` targets named `install`, `build`, `cli`: extract the output
     binary name from the first `go build -o <name>` or `cargo build` line.
   - Convention fallback: `basename $CLAUDE_PROJECT_DIR` lowercased.

2. **Resolve to an absolute path.**

   ```bash
   CLI_BINARY=$(which <candidate-name> 2>/dev/null)
   ```

   If `which` returns nothing, `caps.cli.binary` remains unset — skip silently.
   If `which` returns a symlink, resolve it:

   ```bash
   CLI_BINARY=$(realpath "$CLI_BINARY" 2>/dev/null || readlink -f "$CLI_BINARY" 2>/dev/null || echo "$CLI_BINARY")
   ```

   Symlinks that resolve outside `$CLAUDE_PROJECT_DIR` are treated as
   system-installed binaries — `caps.cli.binary` is set to the resolved path
   but `caps.cli.inRepo` is `false`, and the staleness check is skipped.

3. **Check whether the binary lives inside the host repo.**

   ```bash
   if [[ "$CLI_BINARY" == "$CLAUDE_PROJECT_DIR"/* ]]; then
     caps.cli.inRepo=true
   else
     caps.cli.inRepo=false
   fi
   ```

4. **Detect the source language** (only when `caps.cli.inRepo=true`).

   Walk upward from the directory containing `caps.cli.binary` until a manifest
   file is found or the host repo root (`$CLAUDE_PROJECT_DIR`) is reached.
   Use the first manifest found — do NOT scan past the repo root.

   ```bash
   dir=$(dirname "$CLI_BINARY")
   lang=""
   manifest=""
   while [[ "$dir" == "$CLAUDE_PROJECT_DIR"* && "$dir" != "/" ]]; do
     if [[ -f "$dir/go.mod" ]];          then lang=go;   manifest="$dir/go.mod";   break; fi
     if [[ -f "$dir/Cargo.toml" ]];      then lang=rust; manifest="$dir/Cargo.toml"; break; fi
     if [[ -f "$dir/package.json" ]];    then lang=node; manifest="$dir/package.json"; break; fi
     dir=$(dirname "$dir")
   done
   ```

   If no manifest is found before `$CLAUDE_PROJECT_DIR`, set
   `caps.cli.lang=unknown` and skip the staleness check (`caps.cli.sourceRoot`
   unset).

   For **Go workspaces**: if `go.mod` declares `module` but the directory is
   not `$dir` itself (i.e. the binary lives under `cmd/<name>/`), the source
   root is still `$dir` (the module root), not the binary's parent directory.

   For **Cargo workspaces**: the first `Cargo.toml` found while walking up may
   be the workspace root. The per-member manifest lives at
   `members/<name>/Cargo.toml`. Set `caps.cli.sourceRoot` to the directory of
   the member manifest if `[package]` is present; otherwise use the workspace
   root.

5. **Populate `caps.cli` keys.**

   | Key | Value |
   | --- | --- |
   | `caps.cli.binary` | Absolute resolved path from step 2 |
   | `caps.cli.inRepo` | Boolean from step 3 |
   | `caps.cli.lang` | `go` / `rust` / `node` / `unknown` |
   | `caps.cli.sourceRoot` | Directory containing the detected manifest (step 4) |
   | `caps.cli.buildCmd` | Resolved from `caps.scripts[]` (e.g. `build`, `cli:build`) OR language convention: Go → `go build ./...`, Rust → `cargo build --release`, Node → `<runner> build` |

### Example populated `caps.cli`

```
caps.cli.binary=/home/user/projects/myapp/bin/myapp
caps.cli.inRepo=true
caps.cli.lang=go
caps.cli.sourceRoot=/home/user/projects/myapp
caps.cli.buildCmd=go build ./cmd/myapp/...
```

These values feed directly into R-8 of `SKILL.md` Phase 0 (CLI-source-staleness probe).

---

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
