# Deploying Mindora to Railway

Single-container "bundle" deploy: all 9 hand-written services + the docs
aggregator run together via `Dockerfile.bundle` + `ecosystem.config.cjs`.
Postgres, Redis, MongoDB, and RabbitMQ are separate Railway services.

## 1. Push to GitHub

Commit and push as usual — everything below assumes the branch Railway is
tracking is up to date on GitHub before you touch the dashboard. Make sure
CI is green first (see "CI" below); Railway will happily deploy a branch
that fails CI, but you don't want to find that out from a crash-looping
container instead of a red check.

## 2. Create the data-store services

Do these first — the app service needs them at boot. In your Railway project:

- **Postgres** — "New" → "Database" → "Add PostgreSQL". It only creates one
  database by default; you'll create the other 6 in step 4.
- **Redis** — "New" → "Database" → "Add Redis".
- **MongoDB** — "New" → "Database" → "Add MongoDB" (Railway's official
  template). It generates its own root username/password — do **not**
  assume no auth.
- **RabbitMQ** — "New" → "Database" → "Add RabbitMQ" (Railway's official
  template, comes with a management Web UI). It also generates its own
  credentials.

Both official templates auto-generate random credentials and expose a
ready-made private connection string (`RABBITMQ_PRIVATE_URL`, and something
equivalent for MongoDB) on their own Variables tab — use those directly in
step 5 rather than assuming a fixed username/password like `mindora`/`mindora`.
(If you deploy either as a bare Docker image instead — `mongo:7` /
`rabbitmq:3-management-alpine` via "Empty Service" → "Deploy Docker Image" —
_then_ no auth is enabled by default and you'd set your own
`RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS`. The official templates
shown above don't work that way.)

Name these services clearly (e.g. `postgres`, `redis`, `mongodb`, `rabbitmq`)
— Railway's private DNS is `<service-name>.railway.internal`, and you'll
reference that name directly.

## 3. Create the app service (the bundle)

1. "New" → "GitHub Repo" → select this repo again (same repo, new service).
2. Settings → Source: confirm **Root Directory is `/`** — the Dockerfile
   builds from repo root, not a subfolder.
3. Settings → Build: set **Dockerfile Path** to `Dockerfile.bundle`.
4. Leave the start command unset — the Dockerfile's `CMD` handles it.

## 4. Create the 7 Postgres databases

The bundle's 7 Prisma services each expect their own database on one Postgres
instance (mirroring `infrastructure/postgres/init-databases.sh`, which only
runs on fresh local volumes and won't run on Railway).

Open the Postgres service → "Console" tab. This drops you into a **bash**
shell inside the container (`root@<id>:/#`), not directly into `psql` —
pasting raw SQL there fails with `bash: CREATE: command not found`. Run
`psql` yourself first:

```bash
psql -U postgres -c "CREATE DATABASE mindora_auth;" -c "CREATE DATABASE mindora_user;" -c "CREATE DATABASE mindora_appointment;" -c "CREATE DATABASE mindora_mood;" -c "CREATE DATABASE mindora_admin;" -c "CREATE DATABASE mindora_ai;" -c "CREATE DATABASE mindora_notifications;"
```

(`postgres` is Railway's default Postgres template superuser — check the
service's Variables tab for `PGUSER` if a different one was set. The
container already has `PGPASSWORD` etc. in its own environment, so a bare
`psql -U postgres` should connect without prompting.)

## 5. Set environment variables on the app service

Go to the app service → Variables, and add these. Railway's
`${{ServiceName.VAR}}` syntax pulls values from the other services you just
created — replace `Postgres`/`Redis`/`MongoDB`/`RabbitMQ` with whatever you
actually named those services, and confirm the exact variable names on each
service's own "Variables" tab (e.g. `PGHOST` vs `PGHOSTNAME` can vary):

```
AUTH_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_auth
USER_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_user
APPOINTMENT_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_appointment
MOOD_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_mood
ADMIN_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_admin
AI_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_ai
NOTIFICATION_DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/mindora_notifications

REDIS_URL=${{Redis.REDIS_URL}}

# MongoDB's official template generates its own root user — build this from
# whatever credential variables its Variables tab actually shows (commonly
# MONGOUSER/MONGOPASSWORD, but confirm the exact names). No trailing
# database name or query string here — ecosystem.config.cjs appends
# /mindora_community, /mindora_messaging, /mindora_user_documents, and
# ?authSource=admin itself.
MONGO_BASE_URL=mongodb://${{MongoDB.MONGOUSER}}:${{MongoDB.MONGOPASSWORD}}@${{MongoDB.RAILWAY_PRIVATE_DOMAIN}}:27017

# RabbitMQ's official template also generates its own credentials — use its
# ready-made private URL variable directly rather than assuming mindora/mindora.
RABBITMQ_URL=${{RabbitMQ.RABBITMQ_PRIVATE_URL}}

# Only exists once you've done step 8 — community-service, messaging-service,
# and admin-service all call out to Kong for service-to-service auth-enforced
# lookups. Fine to add this later; those specific calls just fail until it's set.
KONG_URL=http://<kong-service-name>.railway.internal:8000

# Different from KONG_URL above: this one is handed to a *browser*
# (user-service mints therapist-document download links pointing here -
# see apps/user-service/src/lib/object-storage.ts) and so must be the same
# externally-reachable Kong URL the frontend's NEXT_PUBLIC_API_URL and the
# mobile app's EXPO_PUBLIC_KONG_BASE_URL already point at (e.g.
# https://api.mindora.rw), never the *.railway.internal host above - that
# hostname only resolves inside Railway's private network, not from a
# visitor's browser.
PUBLIC_KONG_URL=https://api.mindora.rw

JWT_SECRET=<generate with: openssl rand -hex 32>
INTERNAL_SERVICE_TOKEN=<generate locally with the SAME JWT_SECRET as above: JWT_SECRET=<value> npm run generate:service-token --workspace=@mindora/auth-service>
MOOD_JOURNAL_ENCRYPTION_KEY=<generate with: openssl rand -hex 16>
COMMUNITY_ENCRYPTION_KEY=<generate with: openssl rand -hex 16>
MESSAGE_ENCRYPTION_KEY=<generate with: openssl rand -hex 16>
AI_INTERACTION_ENCRYPTION_KEY=<generate with: openssl rand -hex 16>
USER_SERVICE_URL=http://localhost:3002
APP_BASE_URL=https://app.mindora.rw  # Required: public frontend URL used in password-reset links and OAuth redirects

# AI provider behind POST /chat — see apps/ai-integration-service/src/chatbotClient.ts.
# A session (short-lived access token) is exchanged per patient lazily, on that
# patient's first message, via POST /integration/session — no per-patient password.
THERAPY_CHATBOT_BASE_URL=https://chatbot.mindora.rw
# Shared secret proving ai-integration-service is the caller of /integration/session.
# Get the real value from the chatbot vendor via a password manager — never commit it.
MINDORA_INTEGRATION_KEY=<get from the chatbot vendor, never commit>
```

Therapist application documents (license PDFs/IDs) no longer need their own
object-storage credentials — they live in MongoDB GridFS now, on the same
Mongo instance/`MONGO_BASE_URL` already set above for community-service and
messaging-service (see `apps/user-service/src/lib/mongo.ts`). This feature
does need `PUBLIC_KONG_URL` set (above) — without it, document downloads
default to `http://localhost:8000`, which is correct for local dev but not
reachable from a real visitor's browser in production.

Kong also needs the `user-documents` route (`infrastructure/kong/
kong.railway.yml`) — deliberately outside the jwt plugin, same as
`user-photos` beside it, since a document download link is opened directly
by the browser (`window.open()`), which can't attach an Authorization
header. Both routes ship in the checked-in `kong.railway.yml`; nothing to
add here, just don't remove them if you're hand-editing that file.

`USER_SERVICE_URL` and `THERAPY_CHATBOT_BASE_URL` are the only two values
above that are correct to paste exactly as shown — everything else is either
a reference you must confirm matches your actual service names, or a secret
you must generate fresh (never reuse an example value from this file).

Leave `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `RESEND_EMAIL_API_KEY`,
`FIREBASE_SERVICE_ACCOUNT_JSON`, `AT_API_KEY`/`AT_USERNAME` unset unless you
use those integrations.

`ai-integration-service` also needs `REDIS_URL` (already listed above) —
its auth middleware checks Redis for blacklisted/suspended tokens on every
request; without it every authenticated call 500s.

## 6. Deploy and run Prisma migrations

1. Trigger the first deploy — it should happen automatically once variables
   are saved and the GitHub push has landed.
2. Once it's up, open a one-off shell against the app service (Railway's
   dashboard has a "Shell" / run-command feature) and run, once per Prisma
   service:

```bash
npx prisma migrate deploy --schema=apps/auth-service/prisma/schema.prisma
npx prisma migrate deploy --schema=apps/user-service/prisma/schema.prisma
npx prisma migrate deploy --schema=apps/appointment-service/prisma/schema.prisma
npx prisma migrate deploy --schema=apps/mood-tracking-service/prisma/schema.prisma
npx prisma migrate deploy --schema=apps/admin-service/prisma/schema.prisma
npx prisma migrate deploy --schema=apps/ai-integration-service/prisma/schema.prisma
npx prisma migrate deploy --schema=apps/notification-service/prisma/schema.prisma
```

## 7. Verify it's actually running

1. Check the deploy logs — pm2-runtime should show all 10 processes as
   `online`. If a Prisma-backed service instead crash-loops with
   `PrismaClientInitializationError: ... was generated for "debian-openssl-*",
but the actual deployment required "linux-musl-openssl-*"`, that's a
   flaky "native" engine auto-detection issue on Alpine, not a Railway
   config problem — every service's `schema.prisma` already pins
   `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` to prevent it,
   so this shouldn't recur, but if it does, rebuild with `--no-cache`.
2. Give the service a public domain (Settings → Networking → "Generate
   Domain"), targeting **port 3010** first — that's the docs-gateway. Visit
   it; you should get one Swagger UI page with a service dropdown, each
   entry resolving to real JSON (not the HTML-shell bug from earlier).
3. Spot check a couple of services' `/health` from the same Railway shell,
   since they're not publicly exposed yet:
   ```bash
   curl localhost:3001/health
   curl localhost:3005/health
   ```

## 8. Put Kong in front (for real external API traffic)

Everything so far gives you internal services plus one public docs page —
no public API access yet, which is correct, since JWT verification, rate
limiting, and CORS all live in Kong.

`infrastructure/kong/kong.railway.yml` and `infrastructure/kong/Dockerfile`
already exist for this — every service `url:` in that file points at
`mindorav3.railway.internal:<port>`, the confirmed `RAILWAY_PRIVATE_DOMAIN`
for the bundle service named `Mindora_V3` on Railway (private DNS strips
underscores/casing entirely — it is **not** a simple lowercase or hyphenated
version of the service name). If you rename that service, or Kong still
can't resolve the DNS name, re-check the `RAILWAY_PRIVATE_DOMAIN` variable
on the bundle service's own Variables tab (Railway auto-injects it) for the
exact private hostname, and update every `url:` in that file to match before
building.

1. Before deploying, open `infrastructure/kong/kong.railway.yml` and replace
   `REPLACE_WITH_PRODUCTION_JWT_SECRET` in the `jwt_secrets` section with the
   **exact same value** as the app service's `JWT_SECRET`. Kong's declarative
   config can't read env vars, so this has to be a literal value baked into
   the file at build time — setting a `JWT_SECRET` env var on the Kong
   service itself does nothing (Kong only consumes `KONG_*`-prefixed vars).
2. Deploy Kong: "New" → "Empty Service" → "Deploy from Dockerfile". Leave
   **Root Directory** as `/` (repo root, same as the bundle service in step 3) and set **Dockerfile Path** to `infrastructure/kong/Dockerfile` — the
   build context needs to be the repo root since the Dockerfile's `COPY`
   references `infrastructure/kong/kong.railway.yml`. Setting Root Directory
   to `infrastructure/kong` instead (with the same Dockerfile Path) double-
   nests the path and fails with "file with no instructions".
3. Set Kong's env vars: `KONG_DATABASE=off`,
   `KONG_DECLARATIVE_CONFIG=/kong/kong.yml`,
   `KONG_PROXY_LISTEN=0.0.0.0:8000`,
   `KONG_DNS_ORDER=A`,
   `KONG_NGINX_WORKER_PROCESSES=1`.
   - `KONG_DNS_ORDER=A` is Railway-specific: Kong's default DNS resolution
     order tries an SRV lookup before falling back to A, and Railway's
     internal DNS resolver doesn't support SRV queries — it replies
     `dns server error: 4 not implemented`, which fails the balancer resolve
     for `<bundle-service-name>.railway.internal` instead of falling
     through. Restricting the order to `A` skips the unsupported query type
     entirely.
   - `KONG_NGINX_WORKER_PROCESSES=1` overrides Kong's default
     (`worker_processes auto`), which sizes itself off the number of CPU
     cores the container can _see_ — on Railway that's the host's full core
     count, not what's actually allocated to this service. Left on `auto`,
     Kong spawns dozens of workers, blows past the service's memory limit,
     and they get SIGKILL'd in a loop (visible in logs as repeated
     `worker process N exited on signal 9` followed by
     `failed to connect: ... timeout` / `connection reset by peer` on
     in-flight requests). Pin it to a small fixed number instead — `1` is
     enough for Kong itself, which is not the bottleneck the bundle
     services' own PM2 process count is.
4. Give **Kong** the public domain (not the bundle) — that's the one your
   frontend/mobile app should actually call. Once you have that domain, set
   `APP_BASE_URL` (step 5) and `KONG_URL` (step 5) on the bundle app service
   accordingly, and redeploy it.
5. Point the frontend's `NEXT_PUBLIC_SOCKET_URL` at this same Kong domain,
   not a separate one — messaging-service has no public domain of its own,
   only Kong does (this step 4 gives it one, nothing else in this guide
   does). `kong.railway.yml` already has a `messaging-socket` route
   proxying `/socket.io` to messaging-service for exactly this; without it,
   real-time chat has no way to reach the backend at all in production.
   Live-verified locally (the equivalent route in `kong.yml`): a real
   `socket.io-client` connects and authenticates successfully through Kong's
   proxy port, not just messaging-service's own port.

## CI

`.github/workflows/ci.yml` gates every merge to `main` on: secret scan
(TruffleHog), CodeQL, lint + format check, tests (against the same
`docker-compose.yml` infra as local dev, with all 7 per-service Postgres
databases created and migrated), a full build, and a production-dependency
audit (`npm audit --audit-level=high --omit=dev --omit=optional`). Because
`package-lock.json` changes trip the "global config changed" path in
`detect-changes`, a dependency or workspace change (like adding
`docs-gateway` or `pm2`) makes CI run lint/test/build across every package,
not just the ones touched — worth knowing before assuming a small change
keeps CI fast.

Locally verified before pushing (same commands CI runs):

- `npm run format:check`
- `npx turbo run lint`
- `npx prisma generate` (+ `migrate deploy` for the test job) for each of the
  7 Prisma services, then `npx turbo run build` / `npx turbo run test`
- `npm audit --audit-level=high --omit=dev --omit=optional`

All passed at the time this was written. `secret-scan` and `codeql` only
run in GitHub Actions (TruffleHog needs real commit history to diff against;
CodeQL needs its own toolchain) — nothing in this bundle work introduces
new secrets or an obvious injection surface, but they haven't been run
locally, so treat the Actions run as the first real check on those two.
