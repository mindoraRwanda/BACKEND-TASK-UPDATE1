# MINDORA V3 Backend — final source release status

**Status: source release candidate; not production-certified.**

## Included

- MINDORA V3 TypeScript monorepo and existing microservices.
- Auth password reset hardening (hashed, 15-minute, one-time Redis token; generic public response; queue publisher confirms; refresh-session revocation on reset).
- Resend email integration that records provider acceptance accurately and requires a configured non-sandbox sender in production.
- Python conversational therapy service included under `services/python-conversational-therapy`.
- Private V3-to-chatbot session exchange at `POST /integration/session`, using `X-Integration-Key` and stable MINDORA user identity.
- Additive SQL migration to link existing chatbot identities to V3 identities.
- Voice/webhook and crisis-handling changes documented in the source tree.

## Required before production

1. Use Node.js 24.16.0 and npm 10.9.2. Run `RUN_MINDORA_FINAL_CHECKS.cmd` from this folder. It regenerates the lockfile using the patched npm overrides, performs `npm ci`, formats the repository, and runs format, lint, test, build and high-severity production audit checks. Review all lockfile and formatting changes before committing.
2. Run `RUN_MINDORA_PYTHON_CHATBOT_TESTS.cmd` with the Python runtime and dependencies available. The current execution environment used for preparing this archive did not have `python-jose` and `passlib`, so these tests were not run here.
3. Review and apply `services/python-conversational-therapy/migrations/20261105_add_mindora_external_id.sql` in staging only after backing up the chatbot DB. Obtain the DB owner's approval before production.
4. Configure `APP_BASE_URL=https://app.mindora.rw` in auth-service.
5. Configure `RESEND_EMAIL_API_KEY` and a sender identity verified by Resend in notification-service. Provider acceptance is not proof of delivery to the recipient's mailbox.
6. Set the same generated high-entropy `MINDORA_INTEGRATION_KEY` in the V3 AI integration service and Python chatbot service. Set `THERAPY_CHATBOT_BASE_URL` to the chatbot's private Railway URL and configure a separate `CHATBOT_JWT_SECRET`.
7. Configure the Python chatbot Postgres URL, Ollama model/service and Qdrant endpoint/collection.
8. Verify Kong CORS, cookie domain, service private DNS, rate limits, alert routing, approved clinical contacts and Voice/SMS provider credentials in staging.
9. Obtain MINDORA review/approval and let its Railway administrators deploy. This archive does not merge PRs or deploy to Railway.

## Verification performed while preparing the archive

- Source/archive inspection and static configuration checks only.
- Python `compileall` can be run without importing dependencies.
- ZIP integrity is checked when this release archive is created.

## Not verified in this environment

- Full `npm ci`, dependency resolution and `npm audit`: Node available here was 22.16.0, below the repo requirement, and npm registry access was unavailable.
- Full Vitest, TypeScript, ESLint, Prettier and Turbo builds.
- Python FastAPI integration tests: required runtime modules were not all installed in the preparation environment.
- Docker builds, real Resend delivery, SMS/Voice calls, real database migration, live API integration and Railway deployment.

Do not describe this source archive as production-ready until the required checks and staging verification above actually pass.
