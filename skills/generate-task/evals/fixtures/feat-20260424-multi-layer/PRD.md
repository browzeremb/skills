# Multi-layer Feature: User-facing API key rotation

**Repo surface:** multi-layer. Shared types, Postgres migration, Fastify route in `apps/auth`, Next.js page in `apps/web`, integration test, docs.

## 1. Problem
Users can create and revoke API keys but can't rotate (generate new key with same permissions, old still valid for a 24h overlap window).

## 2. Vision & value
Rotation flow: user clicks "Rotate" → system creates new key with same scope/quotas, marks old key `rotating_until=<now+24h>`, returns new key value ONCE. Both keys work during the window; old is auto-revoked at expiry.

## 3. Objectives
- Add `rotating_until` column to `api_key` table via drizzle migration.
- Add `POST /api/auth/api-key/:id/rotate` route to `apps/auth`.
- Add "Rotate" button + confirmation modal to `apps/web/src/app/settings/api-keys/page.tsx`.
- Add BullMQ schedule to auto-revoke expired rotations.
- Integration test end-to-end rotation.
- Runbook update for ops.

## 4. Scope
**In:** schema, migration, route, UI, worker consumer, test, docs.
**Out:** rotation for org-wide keys (only user keys for now), UI for managing rotation history.

## 5. Personas
- Paid user (primary): rotates their production key without downtime.
- Dev/ops: runs the auto-revoke migration.

## 7. Functional requirements
7.1. Drizzle schema: add `rotating_until TIMESTAMPTZ NULL` to `api_key`.
7.2. Migration SQL: `ALTER TABLE api_key ADD COLUMN rotating_until TIMESTAMPTZ NULL;`.
7.3. Route `POST /api/auth/api-key/:id/rotate`: creates new key, sets old.rotating_until, returns new key value.
7.4. Auth middleware: if `rotating_until > now()` AND key matches old value → valid.
7.5. BullMQ job `auto-revoke-rotated-key`: runs every 10min, revokes keys where rotating_until < now.
7.6. Worker consumer in `apps/worker/src/consumers/auto-revoke-rotated-consumer.ts`.
7.7. Queue schema in `packages/queue/src/job-schemas.ts`.
7.8. API key verify endpoint returns `rotating_until` so clients can show warning.
7.9. UI button "Rotate" on each key row, modal confirms + shows new value ONCE.
7.10. UI badge "Rotating (expires in Xh)" on the old key.

## 8. Non-functional
- **Security:** new key value returned ONCE; not stored in frontend state longer than modal lifetime. Old key audit-logged on rotation.
- **Observability:** `api.key.rotated` metric + trace span.
- **Tenant scoping:** rotation is per-user (no cross-user id leakage).

## 9. Constraints
- Drizzle migration ownership is `apps/auth` (per CLAUDE.md).
- Must not break existing `/api/auth/api-key/:id/revoke`.
- Partitioned `api_key_audit_log` must receive rotation event.

## 13. Acceptance criteria
- [ ] AC1: migration applies cleanly on empty + populated DB.
- [ ] AC2: rotation endpoint creates new key, old still works for 24h.
- [ ] AC3: auto-revoke consumer removes expired rotating keys.
- [ ] AC4: UI button triggers rotation, modal shows new key once.
- [ ] AC5: audit log records `api_key.rotated` event.
- [ ] AC6: integration test covers full rotate → use-old → expire → old-rejected flow.
- [ ] AC7: runbook updated with rotation + troubleshooting steps.
- [ ] AC8: `pnpm turbo lint typecheck test` and `pnpm test:integration` green.

## 14. Hand-off to `generate-task`
Touches 8+ files across shared, data, api, worker, web, tests, docs. Expect 4-6 tasks ordered by layer.
