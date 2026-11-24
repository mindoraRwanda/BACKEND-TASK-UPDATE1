# MINDORA Backend — Final Source Release Status

Prepared: 1 November 2026

This archive contains the previous MINDORA backend implementation plus the additional crisis-notification independence and Africa's Talking Voice integration changes made for this release. It is a source-code delivery archive, **not a claim of production deployment or end-to-end production verification**.

## Implemented in the included source

- Existing MINDORA V3 monorepo and microservice structure retained.
- Existing crisis event detection/response work from the previous backend retained.
- Crisis notifications now attempt email, SMS and Voice independently with `Promise.allSettled()` so one provider failure does not prevent the other channels from being attempted.
- Added durable per-recipient idempotency claims for email/SMS/Voice notifications using SHA-256 hashed dedupe keys in the notification log. Terminal Voice callback outcomes cannot be overwritten by a late outbound-call acceptance response.
- Added Africa's Talking Voice SDK integration using the existing `africastalking` dependency.
- Added Voice callback and call-events HTTP routes, XML response handling and callback token validation.
- Added public Kong routes for Voice callbacks in both standard and Railway Kong configuration files.
- Added notification-log schema field and SQL migration for the idempotency key.
- Added crisis channel failure regression test cases in the notification-service test source.
- Existing Resend email, Africa's Talking SMS, authentication security and therapist onboarding implementation retained from the previous backend archive.

## Required configuration before live use

Set secrets through the hosting provider's secret manager or deployment environment. Do not commit `.env` files or paste API keys into source code.

- `RESEND_EMAIL_API_KEY`
- `RESEND_FROM_EMAIL` (sender/domain must be verified with Resend)
- `AT_API_KEY` (rotate/reissue any key previously exposed in chat)
- `AT_USERNAME`
- `SMS_ENABLED=true` after approval and testing
- `AT_SENDER_ID` if the account has an approved sender ID
- `AT_VOICE_ENABLED=true` only after an Africa's Talking-issued Voice number is allocated and a controlled test is approved
- `AT_VOICE_NUMBER`
- `AT_VOICE_WEBHOOK_TOKEN` (generate a long random secret)
- `AT_VOICE_CALLBACK_URL` and `AT_VOICE_EVENTS_URL` (public HTTPS URLs)
- `MINDORA_CRISIS_ALERT_EMAILS`
- `MINDORA_CRISIS_ALERT_PHONES`
- `MINDORA_CRISIS_ALERT_VOICE_PHONES`
- `MINDORA_BOOKING_ALERT_EMAILS`
- `MINDORA_BOOKING_ALERT_PHONES`

Configure the issued Voice number's callback URL and events URL in the Africa's Talking dashboard, pointing to the public URLs above. The routes validate the `token` query parameter or `x-at-voice-token` header using `AT_VOICE_WEBHOOK_TOKEN`. Confirm the callback format supported by the actual account before enabling the service.

The Voice call API request being accepted is not proof that a human answered. Final call outcomes arrive through the configured Voice events callback. This release records callback events separately; it does not automatically repeat unanswered crisis calls because repeat-call policy and cadence require MINDORA approval.

## Clinical and operational approvals still required

- Clinical approval of crisis wording, risk classification behavior, escalation thresholds and escalation procedures.
- Confirmation of emergency/hotline contacts and therapist contact routes by MINDORA's clinical owner.
- Authorization of internal crisis notification recipients and their phone numbers/email addresses.
- Approval of the generic voice message or a clinician-approved script.
- Consent and operational policy for any calls to patients. The current design calls staff recipients only.

MINDORA's public contact details supplied by the client are `+250 783 974-066` and `info@mindora.rw`, published as Monday–Friday, 9 AM–5 PM with email response within 24 hours. These are general public contacts, not a 24/7 emergency hotline and are not automatically used as internal alert recipients.

## Database migration

A new notification-service migration was added:

`apps/notification-service/prisma/migrations/20261101160000_add_notification_dedupe_key/migration.sql`

Apply it through the normal notification-service migration process in a controlled staging environment before deploying the new service code. Back up the database first and verify that the service uses the matching schema.

## Verification performed in this environment

- TypeScript/TSX/JavaScript/JSX syntax parse: 481 files scanned across backend, web app and official website; 0 syntax diagnostics.
- JSON parse: 57 files; 0 errors.
- YAML parse: 15 files; 0 errors.
- Actual `preFilter.ts` manual phrase harness: 22/22 cases matched expected levels.
- Final ZIP integrity checks are run after packaging.

## Verification not completed

- Full semantic TypeScript compilation and monorepo build.
- Vitest/Jest test execution and integration test execution.
- Database migration execution against a real PostgreSQL database.
- Live Resend email delivery.
- Live Africa's Talking SMS delivery.
- Live Africa's Talking Voice call and callback verification.
- Production deployment and production health checks.

The backend declares Node.js `24.16.0` in `.nvmrc`; the available execution environment used Node.js `22.16.0`. Dependency installation did not complete in this environment. Run installation, generation, builds and test suites using the declared Node runtime in CI/staging before production release.

## Chatbot source

The Python chatbot repository (`https://github.com/mindoraRwanda/MindoraVersionTwo`) was not included as an uploaded ZIP and could not be retrieved in this packaging workflow. This archive does not claim to contain a modified Python chatbot. Its source must be obtained and separately integrated/verified.
