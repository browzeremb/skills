# Small Feature: Add request-id to worker log lines

**Repo surface:** `apps/worker/src/consumers/ingestion-consumer.ts`

## 1. Problem
Worker log lines don't include `x-request-id`, making correlation with API traces painful.

## 2. Vision & value
Every worker log line carries the request-id that triggered the job. Operator can grep logs across services.

## 3. Objectives
- Thread `requestId` from job data to `log.child({ requestId })`
- Applies to ingestion-consumer only (other consumers already do it)

## 4. Scope
**In:** `apps/worker/src/consumers/ingestion-consumer.ts` only.
**Out:** other consumers, schema changes, new queues.

## 5. Personas
- Dev/ops (primary): greps production logs.

## 6. User journeys
Dev/ops searches `grep requestId=abc123` across worker + api logs and gets a unified timeline.

## 7. Functional requirements
7.1. Parse `requestId` from validated job.data (already in the Zod schema).
7.2. Scope logger with `log.child({ requestId })` at consumer entry.
7.3. All subsequent log lines in that handler use the scoped logger.

## 8. Non-functional requirements
- **Performance:** zero measurable overhead.
- **Observability:** existing Langfuse traces unaffected.

## 9. Constraints
- Must not change the consumer's existing Zod schema.
- Must not touch any other consumer file.

## 10. Success metrics
- 100% of ingestion-consumer log lines include `requestId` field when present in job.

## 11. Assumptions
- `requestId` is already populated on the job by upstream enqueuers (true per CLAUDE.md).

## 12. Risks
- Missing requestId on legacy jobs → log.child handles undefined gracefully.

## 13. Acceptance criteria
- [ ] AC1: `requestId` appears in log output of ingestion-consumer when job has the field.
- [ ] AC2: no change in log output when job lacks requestId (backwards compatible).
- [ ] AC3: `pnpm turbo lint typecheck test --filter=@browzer/worker` green.

## 14. Hand-off to `generate-task`
Single-file change. One task at most. Probably TASK_01 = the whole fix.
