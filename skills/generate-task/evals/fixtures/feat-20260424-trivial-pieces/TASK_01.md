# Task plan for Expose rate-limit tunables via shared env

**Workflow stage:** generate-task (2/6) · previous: `generate-prd` · next: `execute-task`
**PRD source:** `packages/skills/skills/generate-task/evals/fixtures/feat-20260424-trivial-pieces/PRD.md` · **Repo surface:** `packages/shared/src/env.ts`, `apps/gateway/src/env-schema.ts`, `apps/gateway/src/server.ts`
**Invariant source:** `CLAUDE.md` (root), `packages/shared/CLAUDE.md`, `apps/gateway/CLAUDE.md`

---

## TASK_01 — Add RATE_LIMIT_GLOBAL_MAX + RATE_LIMIT_AUTH_MAX to shared env; wire gateway config to consume all three rate-limit fields from env

**Layer:** shared / foundation + edge (env schema addition + config-glue rewire). Cross-layer merge is safe: all three new env vars carry `.default()` values matching current hardcoded values, so partial landing at any point leaves runtime behaviour identical to today. No feature-flag gate required.
**Depends on:** none
**Trivial:** false — spans two packages (`packages/shared`, `apps/gateway`), three files, cross-layer. The single-package ≤3-file requirement for the trivial flag is not satisfied.
**Suggested model for `execute-task`:** haiku — fully deterministic config wiring: add two Zod fields, drop one local duplicate declaration, fix one type (string → number), add two keys to buildConfig, replace one hardcoded string literal. No algorithmic complexity, no new business logic.

### Scope — files (~30 soft cap)

| File | Action | Purpose | Source |
| ---- | ------ | ------- | ------ |
| `packages/shared/src/env.ts` | modify | Add `RATE_LIMIT_GLOBAL_MAX` (`z.coerce.number().default(600)`) and `RATE_LIMIT_AUTH_MAX` (`z.coerce.number().default(10)`) to `commonEnvFields` after `RATE_LIMIT_WINDOW_MS` at line 43. `RATE_LIMIT_WINDOW_MS` already exists — do not duplicate it. | `browzer explore`, `Read` |
| `apps/gateway/src/env-schema.ts` | modify | (a) Remove local `RATE_LIMIT_GLOBAL_MAX: z.string().default('600')` at line 51 — now supplied via `commonEnvFields` spread. (b) In `buildConfig` rateLimit block (lines ~173–176): replace `globalMax: Number.parseInt(env.RATE_LIMIT_GLOBAL_MAX, 10)` with `globalMax: env.RATE_LIMIT_GLOBAL_MAX` (already a `number`); add `authMax: env.RATE_LIMIT_AUTH_MAX`; add `windowMs: env.RATE_LIMIT_WINDOW_MS`. | `Read`, `browzer explore` |
| `apps/gateway/src/server.ts` | modify | Replace hardcoded `timeWindow: '1 minute'` at line ~267 with `timeWindow: rateLimitConfig.windowMs`. `rateLimitConfig` is imported from `./config.ts`; `windowMs` is the new key added to `buildConfig`. | `Read` |

**Total: 3 files.**

**PRD surface note:** The PRD lists `apps/api/src/plugins/rate-limit.ts` and `apps/gateway/src/plugins/rate-limit.ts` as target files, but neither exists. The gateway's `@fastify/rate-limit` registration is inline in `server.ts`; the api has no `@fastify/rate-limit` dependency. Both apps spread `commonEnvFields` from `@browzer/shared/env`, so `RATE_LIMIT_GLOBAL_MAX` and `RATE_LIMIT_AUTH_MAX` automatically appear in their env schemas once added to the shared module — no additional consumer code in `apps/api` is required to satisfy AC1/AC4 (`pnpm turbo lint typecheck test` green). See Pre-execution verification #3 and Implementation notes.

### Success criteria

- [ ] 1 (AC1): `commonEnvFields` in `packages/shared/src/env.ts` contains exactly one declaration of each: `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_WINDOW_MS`. No duplicates. Types: `z.coerce.number()`. Defaults: 600, 10, 60000 respectively.
- [ ] 2 (AC2): `apps/gateway/src/env-schema.ts` no longer contains a local `z.string()` declaration for `RATE_LIMIT_GLOBAL_MAX`. The `buildConfig` rateLimit section exposes `globalMax`, `authMax`, and `windowMs` as typed `number` values sourced from `env` — no `parseInt` or string literal.
- [ ] 3 (AC3): `apps/gateway/src/server.ts` does not contain the string literal `'1 minute'`. The `timeWindow` field reads `rateLimitConfig.windowMs`.
- [ ] 4 (AC4): Starting either service with no `RATE_LIMIT_*` env vars set produces behaviour identical to today: gateway caps at 600 req/min per IP, 60-second window, auth-route cap 10 req/min.
- [ ] 5 (AC5): `pnpm turbo lint typecheck test --filter=@browzer/shared --filter=@browzer/gateway --filter=@browzer/api` passes with no regressions.

### Non-functional requirements (scoped to this task)

- **Performance:** n/a — config-path only, zero hot-path impact.
- **Security / authz:** `RATE_LIMIT_GLOBAL_MAX` controls ingress throughput. The shared default MUST equal the gateway's current hardcoded value (600), not the PRD §7.1 example of 1000 — PRD §8 "defaults MUST match current hardcoded values" overrides the FR example. Shipping a default of 1000 in prod would silently increase the per-IP cap by 67 %. — source: PRD §8.
- **Observability:** n/a — no new metrics or traces emitted by this task.
- **Accessibility:** n/a — no UI surface.
- **Scalability / tenancy:** All new `commonEnvFields` entries must carry `.default(...)`. Any service that spreads the object (api, gateway, rag, worker, web) must continue to boot successfully without the new vars in their environment. — source: PRD §9, `CLAUDE.md §Shared env`.

### Repo invariants carried by this task

- "Env schema file is shared across ALL services — must not break worker/rag/web." — source: PRD §9. New fields require `.default()`; no service may receive a Zod parse failure due to a missing required field.
- "Gateway is a pure router — does NOT receive `INTERNAL_SERVICE_SECRET`." — source: `CLAUDE.md §Shared env`. Unrelated to this task; noted so execute-task does not accidentally expand the gateway env surface beyond rate-limit fields.
- "`pnpm exec biome check --write <path>` must be run from repo root, not from a subpackage." — source: `CLAUDE.md §Commands`.
- "Routing invariants: adding a new `/api/*` prefix requires three co-located updates (server.ts proxy call + server.test.ts prefix list + assertion)." — source: `apps/gateway/CLAUDE.md §Routing invariants`. Not triggered by this task — no new proxy routes.

### Verification plan

**Baseline (before changes):**

```bash
# Capture type check + lint baseline for affected packages
pnpm turbo lint typecheck --filter=@browzer/shared --filter=@browzer/gateway --filter=@browzer/api 2>&1 | tail -20

# Capture unit test baseline
pnpm turbo test --filter=@browzer/shared --filter=@browzer/gateway --filter=@browzer/api 2>&1 | tail -20
```

Record: pass/fail for each, test counts.

**Post-change:**

```bash
# 1. Format + lint from repo root
pnpm exec biome check --write \
  packages/shared/src/env.ts \
  apps/gateway/src/env-schema.ts \
  apps/gateway/src/server.ts

# 2. Type check + lint — must equal or improve baseline
pnpm turbo lint typecheck --filter=@browzer/shared --filter=@browzer/gateway --filter=@browzer/api 2>&1 | tail -20

# 3. Unit tests — count must be >= baseline
pnpm turbo test --filter=@browzer/shared --filter=@browzer/gateway --filter=@browzer/api 2>&1 | tail -20

# Criterion 1 — exactly three RATE_LIMIT_* entries in shared, no WINDOW_MS duplicate
grep -n "RATE_LIMIT_" packages/shared/src/env.ts
# expected: RATE_LIMIT_WINDOW_MS on one line, RATE_LIMIT_GLOBAL_MAX on one line, RATE_LIMIT_AUTH_MAX on one line

# Criterion 2 — gateway env-schema: no local z.string() declaration, no parseInt
grep -n "RATE_LIMIT_GLOBAL_MAX\|parseInt" apps/gateway/src/env-schema.ts
# must not match a z.string() or parseInt line

# Criterion 3 — gateway server: no hardcoded '1 minute'
grep -n "timeWindow" apps/gateway/src/server.ts
# must not contain the literal string "'1 minute'"

# Criterion 4 — defaults sanity (run from repo root)
node --experimental-strip-types --input-type=module << 'EOF'
import { commonEnvFields } from './packages/shared/src/env.ts';
import { z } from 'zod';
const result = z.object(commonEnvFields).parse({});
console.assert(result.RATE_LIMIT_GLOBAL_MAX === 600,  'GLOBAL_MAX default must be 600');
console.assert(result.RATE_LIMIT_AUTH_MAX   === 10,   'AUTH_MAX default must be 10');
console.assert(result.RATE_LIMIT_WINDOW_MS  === 60000,'WINDOW_MS default must be 60000');
console.log('defaults OK:', result.RATE_LIMIT_GLOBAL_MAX, result.RATE_LIMIT_AUTH_MAX, result.RATE_LIMIT_WINDOW_MS);
EOF
```

**MCP checks:** not applicable — no browser or UI surface.

### Implementation notes for `execute-task`

- **Sub-area:** shared env schema, gateway config wiring.
- **Skills to load in subagents:** none required beyond repo `CLAUDE.md`.
- **Patterns to mirror:**
  - `RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000)` — existing field at `packages/shared/src/env.ts:43`. Use identical `z.coerce.number().default(N)` shape for both new fields; do not use `z.string()`.
  - `authzEnvFields` JSDoc comment style at `packages/shared/src/env.ts:46–67` — mirror the block comment format for the two new fields.
  - `buildConfig` rateLimit mapping at `apps/gateway/src/env-schema.ts:173–176` — add `authMax` and `windowMs` keys alongside the existing `globalMax` and `redisUrl`.
- **Reuse hints:**
  - Both `apps/api` and `apps/gateway` import `{ commonEnvFields }` from `@browzer/shared/env` and spread them via `...commonEnvFields` in their `envSchema`. Adding to `packages/shared/src/env.ts#commonEnvFields` propagates to both apps with no additional per-app changes. Confirmed via `apps/api/src/env-schema.ts:4,26` and `apps/gateway/src/env-schema.ts:18,22`.
  - `apps/gateway/src/env-schema.ts:174` currently calls `Number.parseInt(env.RATE_LIMIT_GLOBAL_MAX, 10)` because the local field is `z.string()`. Once moved to `commonEnvFields` as `z.coerce.number()`, `env.RATE_LIMIT_GLOBAL_MAX` is already a `number` — remove the `parseInt` call or TypeScript will emit a type error.
- **Files NOT to create:** `apps/api/src/plugins/rate-limit.ts` and `apps/gateway/src/plugins/rate-limit.ts` are listed in the PRD header but do not exist in the repo. The acceptance criteria are fully satisfiable by modifying the existing inline configuration (`env-schema.ts` + `server.ts`). Do not create plugin files unless a pre-execution check reveals they already exist.

### Pre-execution verification

- **Assumption 1:** `RATE_LIMIT_WINDOW_MS` already exists in `packages/shared/src/env.ts#commonEnvFields`.
  - **Verify via:** `Read('packages/shared/src/env.ts')` — search for `RATE_LIMIT_WINDOW_MS`.
  - **If holds → proceed** without adding it; add only `RATE_LIMIT_GLOBAL_MAX` and `RATE_LIMIT_AUTH_MAX`. Success criterion 1 is scoped to "no duplicate introduced."
  - **If fails (field missing) → add it** as `z.coerce.number().default(60000)` alongside the other two; update success criterion 1 to "all three fields added."

- **Assumption 2:** The correct default for `RATE_LIMIT_GLOBAL_MAX` is 600 (the gateway's current hardcoded value), not 1000 as stated in PRD §7.1. PRD §8 "defaults MUST match current hardcoded values" takes precedence.
  - **Verify via:** `Read('apps/gateway/src/env-schema.ts')` at line 51 — confirm `z.string().default('600')`.
  - **If holds → use 600 as shared default.** Document the discrepancy with PRD §7.1 in the commit message.
  - **If gateway default differs → use the actual gateway default.** If the gap vs. PRD §7.1 exceeds 2×, surface to the operator before proceeding.

- **Assumption 3:** `apps/api/src/plugins/rate-limit.ts` and `apps/gateway/src/plugins/rate-limit.ts` do not exist.
  - **Verify via:** `Bash('ls apps/api/src/plugins/ 2>/dev/null; ls apps/gateway/src/plugins/ 2>/dev/null')`.
  - **If holds → proceed** with the scope above (env-schema.ts + server.ts only; no plugin files).
  - **If one or both exist → read those files first** and modify them in place instead of the identified inline locations; update the scope table accordingly.
