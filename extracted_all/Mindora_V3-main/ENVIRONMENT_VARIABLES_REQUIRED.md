# MINDORA backend environment variables required for the final release

All values containing secrets must be created and stored in Railway/secret management. Never commit real values to Git.

## Auth Service

- `APP_BASE_URL=https://app.mindora.rw` — required production origin used to construct password reset links.
- `JWT_SECRET` — high-entropy JWT signing secret.
- `REDIS_URL` — Redis URL for refresh/session state and 15-minute single-use password reset tokens.
- `COOKIE_DOMAIN=.mindora.rw` — use only if the current cross-subdomain refresh-cookie architecture is retained and validated.

## Notification Service

- `RESEND_EMAIL_API_KEY` — Resend API key.
- `RESEND_FROM_EMAIL` — sender identity on a domain verified in Resend (for example `Mindora <no-reply@mindora.rw>` only after verification).
- `RABBITMQ_URL` — RabbitMQ connection URL.
- `NOTIFICATION_DATABASE_URL` — notification audit database URL.

Production startup now refuses to initialize Resend if the API key or a non-sandbox sender is missing. A provider's successful API acceptance is recorded as `accepted`; it is not proof of final mailbox delivery.

## Node AI Integration Service

- `THERAPY_CHATBOT_BASE_URL` — private Railway URL of the Python chatbot service.
- `MINDORA_INTEGRATION_KEY` — high-entropy shared secret, same value on both services. Generate and configure this in Railway; never commit it.

## Python Conversational Therapy service

- `MINDORA_INTEGRATION_KEY` — same secret as the Node AI Integration Service.
- `CHATBOT_JWT_SECRET` — separate strong signing secret for chatbot access tokens.
- `DATABASE_URL` or `CHATBOT_DATABASE_URL` — chatbot Postgres connection URL.
- `CHATBOT_CREATE_TABLES_ON_STARTUP=false` in production; use the reviewed additive SQL migration in `migrations/` instead.
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `QDRANT_HOST`, `QDRANT_PORT`, `QDRANT_COLLECTION`, and embedding model settings — configure to the actual Railway/private model and vector-store services.
- `CHATBOT_CRISIS_WEBHOOK_URL` and `CHATBOT_CRISIS_WEBHOOK_TOKEN` — configure only with the approved V3 endpoint and shared secret.

## Database migration approval

`services/python-conversational-therapy/migrations/20261105_add_mindora_external_id.sql` adds one nullable external identity column and one unique partial index. Apply in staging first, back up the chatbot database, and obtain database-owner approval before production. No migration is applied by these source ZIPs.
