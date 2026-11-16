# Mood Tracking Service

Patient mood logging with TimescaleDB analytics, Redis caching, and RabbitMQ concern/streak events.

## Prerequisites

- **Node.js 24+**
- **TimescaleDB** (via `timescale/timescaledb` Postgres image in `docker-compose.yml`)
- Redis, RabbitMQ, auth-service for JWTs

## Port

**3004** (direct) · **8000** via Kong (`/api/v1/mood/*`)

## API documentation

- **OpenAPI:** [`docs/mood-service.yaml`](../../docs/mood-service.yaml)
- **Swagger UI:** `http://localhost:3004/docs`
- **Frontend codegen:** `http://localhost:3004/openapi.json` or `/openapi.yaml` (CORS enabled)

| Method | Path              | Auth            | Description                                                                              |
| ------ | ----------------- | --------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/health`         | No              | Health check                                                                             |
| POST   | `/log`            | JWT (patient)   | Log mood — 10/day limit, encrypted journal; optional `recordedAt` backfills a missed day |
| POST   | `/screenings`     | JWT (patient)   | Persist encrypted answers and a server-calculated screening result                       |
| GET    | `/today`          | JWT (patient)   | Already checked in today? (`?timezone=` IANA name)                                       |
| GET    | `/history`        | JWT (patient)   | Paginated history (`?startDate=`, `?endDate=`)                                           |
| GET    | `/summary`        | JWT (patient)   | Bucketed aggregates for the dashboard chart (`?granularity=day\|week\|month`)            |
| GET    | `/insights`       | JWT (patient)   | Weekly `time_bucket` trends (Redis cached 1h)                                            |
| GET    | `/report/:userId` | JWT (therapist) | Patient summary (no journal notes)                                                       |
| GET    | `/streak`         | JWT (patient)   | Consecutive check-in streak                                                              |
| PUT    | `/:id`            | JWT (patient)   | Edit own entry — content only, **not** `recordedAt`                                      |
| DELETE | `/:id`            | JWT (patient)   | Delete own entry                                                                         |

### Why `recordedAt` can't be edited

`mood_entries` is a TimescaleDB hypertable partitioned on `recorded_at`, with a
composite primary key `[id, recorded_at]`. Timescale rejects an `UPDATE` that
would move a row into a different chunk:

```
ERROR: new row for relation "_hyper_1_2_chunk" violates check constraint "constraint_2"
```

So changing when an entry happened means deleting it and logging a new one with
the corrected `recordedAt` (which `POST /log` accepts). The same composite key
is also why `PUT`/`DELETE` use Prisma's `updateMany`/`deleteMany` with a
`{ id, userId }` filter — `id` alone isn't a unique selector Prisma will accept,
and filtering on `userId` in the same statement enforces ownership without a
separate read-then-write.

### `/today` and time zones

"Today" is only answerable in the user's own zone — a Kigali user (UTC+2)
checking in at 01:00 local is still on the previous UTC day, so the UTC default
would be wrong for the first two hours of every day. Clients should send
`Intl.DateTimeFormat().resolvedOptions().timeZone`. The day-boundary helper
(`src/lib/local-day.ts`) is DST-correct — a spring-forward day resolves to a
23-hour range.

## RabbitMQ events

| Event            | Routing key    | Exchange       |
| ---------------- | -------------- | -------------- |
| Concern          | `mood.concern` | `mindora.mood` |
| Streak milestone | `mood.streak`  | `mindora.mood` |

## Development

```bash
docker compose up -d postgres redis rabbitmq

# NOT `npm run db:migrate` — that targets the orphaned @mindora/database
# package, not this service's own DB (MOOD_DATABASE_URL)
cd apps/mood-tracking-service && npx prisma migrate dev
cd ../..

npm run seed -w @mindora/auth-service   # no root shortcut for this one yet
npm run db:seed:mood
npm run dev -w @mindora/mood-tracking-service
```

## Environment

| Variable                      | Purpose                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOOD_JOURNAL_ENCRYPTION_KEY` | AES-256-GCM key for journal notes                                                                                                                                             |
| `SCREENING_ENCRYPTION_KEY`    | Required base64-encoded 32-byte AES-256-GCM key for screening answers                                                                                                         |
| `MOOD_DATABASE_URL`           | PostgreSQL + TimescaleDB — this was previously (and incorrectly) documented as `DATABASE_URL`; that's the orphaned `@mindora/database` package's variable, not this service's |
| `REDIS_URL`                   | Rate limit + insights cache                                                                                                                                                   |
| `RABBITMQ_URL`                | Event publishing                                                                                                                                                              |

Screening results are stored separately from mood entries. The patient ID is
derived from the verified JWT; submitted patient IDs and client scores are
rejected. Screening answers are encrypted with `SCREENING_ENCRYPTION_KEY` and
are never included in the submission response. Scoring version
`public-screenings-v1` matches the public frontend rules at implementation time
and must be bumped when those rules change. This endpoint does not trigger
crisis escalation.

Generate the screening key separately from the journal key (for example,
`openssl rand -base64 32`). Submissions return 503 when the screening key is
missing or invalid.

## Tests

```bash
npm run test -w @mindora/mood-tracking-service
```
