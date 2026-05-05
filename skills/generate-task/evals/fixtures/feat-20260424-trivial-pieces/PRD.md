# Medium Feature: Expose 3 new rate-limit env vars

**Repo surface:** `packages/shared/src/env.ts`, `apps/api/src/plugins/rate-limit.ts`, `apps/gateway/src/plugins/rate-limit.ts`

## 1. Problem
Rate-limit tunables are hardcoded. Ops want to change them per deploy without rebuilding.

## 2. Vision & value
Three env vars (`RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_WINDOW_MS`) read via zod-validated env helper and consumed by rate-limit plugins. Defaults preserved.

## 3. Objectives
- Add 3 env-var definitions to `packages/shared/src/env.ts`.
- Replace hardcoded values in `apps/api/src/plugins/rate-limit.ts`.
- Replace hardcoded values in `apps/gateway/src/plugins/rate-limit.ts`.

## 4. Scope
**In:** the 3 files listed above.
**Out:** web app rate-limit (different plugin, not in scope). No new rate-limit strategy.

## 5. Personas
- Dev/ops: changes RATE_LIMIT_GLOBAL_MAX in Railway without redeploy.

## 7. Functional requirements
7.1. Add `RATE_LIMIT_GLOBAL_MAX` (number, default 1000) to shared env schema.
7.2. Add `RATE_LIMIT_AUTH_MAX` (number, default 10) to shared env schema.
7.3. Add `RATE_LIMIT_WINDOW_MS` (number, default 60000) to shared env schema.
7.4. `apps/api` rate-limit plugin reads from shared env.
7.5. `apps/gateway` rate-limit plugin reads from shared env.

## 8. Non-functional
- Defaults MUST match current hardcoded values so prod behaviour is identical if env vars unset.

## 9. Constraints
- Env schema file is shared across ALL services — must not break worker/rag/web.

## 13. Acceptance criteria
- [ ] AC1: 3 env vars appear in shared env schema with correct types/defaults.
- [ ] AC2: api plugin reads from env (not hardcoded).
- [ ] AC3: gateway plugin reads from env (not hardcoded).
- [ ] AC4: unset env vars → identical runtime behaviour.
- [ ] AC5: `pnpm turbo lint typecheck test` green.

## 14. Hand-off to `generate-task`
Three tiny touch-points but all same-layer (env + config glue). Likely one task, not three.
