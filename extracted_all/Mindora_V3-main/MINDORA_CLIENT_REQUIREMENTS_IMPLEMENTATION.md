# MINDORA client requirements — implementation notes

This file records the changes and the configuration/verification still required before a production rollout.

## Safety and crisis escalation

- The AI Integration Service runs the pre-filter before making a chatbot request.
- English phrases involving suicidal ideation or self-harm at levels 3–5 now bypass the generative model and return a static safety response.
- The message/response are stored encrypted in the AI interaction store; the notification event contains only a bounded 1,500-character excerpt plus user/session/interaction identifiers.
- Notification Service emails the restricted recipients in `MINDORA_CRISIS_ALERT_EMAILS` and optionally sends SMS to `MINDORA_CRISIS_ALERT_PHONES`.
- Never put an ordinary shared mailbox or broad mailing list here. Restrict access and retention because the alert can contain sensitive health information.
- The keyword list and response wording require approval by MINDORA's qualified clinical/safeguarding lead before live use. Automated keyword matching cannot assess intent or replace clinical triage.
- Configure country-specific emergency/counselling resources for every country in which the service is offered. The current static response contains Rwanda-specific contacts only.

## Login security

- Passwords must contain at least one letter and one number and be 8–128 characters.
- Passwords are hashed with Argon2id.
- Redis tracks failed login attempts per normalized email; five consecutive failures trigger a 15-minute lock.
- Lockout and reset emails are queued through the `mindora.auth-events` topic exchange and sent by Notification Service.
- Reset tokens are random, hashed in Redis, single use, and expire in 15 minutes.
- Set `APP_BASE_URL` to the public frontend origin, not the Auth Service origin.

## Appointments and notifications

- Booking is written to the database and emits the existing appointment domain event.
- The Notification Service continues to notify the patient and now additionally sends an operations alert to configured MINDORA email/SMS recipients.
- SMS requires a valid Africa's Talking account and `SMS_ENABLED=true`, `AT_API_KEY`, and `AT_USERNAME`.

## Therapist applications

- Public self-registration remains PATIENT-only. This is deliberate: users must not be able to grant themselves THERAPIST or ADMIN roles.
- Therapist applicants sign up for a normal account, submit a therapist application and documents, then become THERAPIST only after admin approval.
- Document categories include CV, LICENSE, DIPLOMA, CERTIFICATION, ID, and OTHER.

## External prerequisites not contained in these ZIP files

- Python chatbot source repository `MindoraVersionTwo` was not supplied; its internal API/runtime could not be audited or changed.
- Production credentials (Resend, Africa's Talking, Redis, RabbitMQ, PostgreSQL, object storage) were not supplied and must be set in deployment secrets.
- Before go-live, run database migrations and regenerate Prisma clients on the target runtime, then run integration tests against staging services.

## Updated delivery addendum — 1 November 2026

- Crisis email, SMS and Voice calls are attempted independently using `Promise.allSettled`; failure in one provider does not prevent the other channels being attempted.
- Per-recipient notification dedupe uses a hashed unique key in `notification_logs`; the migration is under `apps/notification-service/prisma/migrations/20261101160000_add_notification_dedupe_key/`.
- Africa's Talking Voice source integration, callback/event routes, token validation and Kong routes are included. Voice is not live-verified and must remain disabled until an issued Voice number, HTTPS callbacks, authorised recipients and a controlled call test are in place.
- Updated verification: 481 TypeScript/TSX/JavaScript/JSX files parsed with 0 syntax diagnostics; 57 JSON files and 15 YAML files parsed without errors; actual `preFilter.ts` manual phrase harness passed 22/22 cases. Full builds and package test suites were not run.
