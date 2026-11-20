# MINDORA final handover — backend

## What this release candidate contains

- Existing MINDORA V3 Node/TypeScript microservices, with the prior CI/security fixes retained.
- Password reset flow hardening: 15-minute hashed single-use Redis token remains, RabbitMQ publisher confirms are awaited, tokens are deleted if event enqueue fails, and the public response no longer claims that an email was sent.
- Production auth configuration now requires a public HTTPS `APP_BASE_URL`. The reset link should point to `https://app.mindora.rw/reset-password?token=...`.
- Resend must be configured for production with a real `RESEND_EMAIL_API_KEY` and a verified `RESEND_FROM_EMAIL`. Provider acceptance is recorded as `accepted`, not `delivered`. Recipient addresses and reset tokens are not written to application logs by the email helper.
- Python chatbot has a private `POST /integration/session` endpoint matching the V3 Node client contract. It checks `X-Integration-Key` with constant-time comparison and reuses/creates a chatbot identity linked to the stable V3 user id.
- Python chatbot conversation IDs are numeric; the Node client validates/converts conversation IDs and normalizes numeric message IDs to strings before storing/returning session data.
- RabbitMQ event publishing uses publisher confirms and mandatory routing checks so a password-reset event cannot be reported as accepted when no queue is bound.

## Required Railway services/configuration

1. Deploy the Node V3 bundle using the existing reviewed `Dockerfile.bundle`; the documentation gateway on port 3010 is for API docs, not the REST API origin. The public Kong API base is `https://api.mindora.rw`.
2. Deploy `services/python-conversational-therapy` as a separate Railway service using its Dockerfile. It is not included as a process in the Node Dockerfile bundle.
3. Set `THERAPY_CHATBOT_BASE_URL` in the Node AI integration service to the private Railway URL of the Python chatbot service (or its approved HTTPS domain).
4. Set `MINDORA_INTEGRATION_KEY` to the same high-entropy secret in the Node AI integration service and Python chatbot service. Generate it in the secret manager/Railway dashboard; do not commit it.
5. Set `APP_BASE_URL=https://app.mindora.rw` in the Node auth service.
6. Set `RESEND_EMAIL_API_KEY` and `RESEND_FROM_EMAIL` in notification-service. The sender domain must already be verified with Resend.
7. Set Python `CHATBOT_JWT_SECRET`, `DATABASE_URL` (or `CHATBOT_DATABASE_URL`), `MINDORA_INTEGRATION_KEY`, the configured Ollama endpoint/model, and Qdrant values as required by the selected chatbot features.

## Database migration approval

The file `services/python-conversational-therapy/migrations/20261105_add_mindora_external_id.sql` is additive only. It adds a nullable external identity column and a unique index; it does not drop or rewrite existing data. Review and apply it to the chatbot database in staging first. Do not apply to production without MINDORA/DB administrator approval and a backup.

## API/domain mapping

- `https://app.mindora.rw` — Next.js user application and password reset UI.
- `https://api.mindora.rw` — public Kong API gateway used by the frontend.
- `https://docs.mindora.rw` — Swagger/docs gateway (port 3010), not the frontend API base.
- Python chatbot — private Railway service URL consumed server-to-server by AI Integration; its URL is not exposed to the browser.

## Verification limits

This archive is a source release candidate, not a certified production release. The current build environment has Node 22.16.0, while this repository requires Node 24.16.0 and npm registry access was unavailable. Full npm install, TypeScript, Vitest, Prettier, dependency audit, Next build, Docker build, provider send tests and Railway integration tests must run in CI/staging. No production databases, domains, secrets or deployments were changed by preparing this archive.
