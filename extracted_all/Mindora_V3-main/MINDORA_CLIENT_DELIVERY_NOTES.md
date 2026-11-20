# MINDORA V3 — Client Delivery Notes

**Prepared:** 1 November 2026  
**Scope:** Source-code implementation updates for Kwizera Rulinda's 27 October 2026 request.

## What changed in this source package

### 1. Chatbot crisis escalation (urgent)

- The AI Integration Service runs an English-language crisis phrase pre-filter before calling the external Therapy Chatbot API.
- Direct/high-risk phrase matches (levels 3–5) receive an immediate static safety response and bypass the generative chatbot for that turn.
- The response includes Rwanda emergency number **112**, ambulance number **912**, Kigali Mental Health Referral Centre contacts **+250 793 902 059 / +250 736 440 666**, and the MINDORA therapist directory URL.
- The interaction is stored encrypted where the AI database is available. A bounded recent conversation excerpt and identifiers are emitted to the notification pipeline for the authorised operations team.
- Notification Service sends an urgent email to `MINDORA_CRISIS_ALERT_EMAILS`. Optional SMS is available through Africa's Talking when explicitly enabled and configured.
- Additional phrase variants and neutral-wording regression cases were added to the pre-filter test suite.

**Important clinical limitation:** this is a technical keyword/phrase starting point, not a clinical risk assessment model. It can miss paraphrases and can produce false positives. A qualified mental-health professional must review and approve the detection taxonomy, wording, risk levels, crisis contacts and escalation operating procedure before production use. A crisis banner/response does not replace emergency services or human clinical support.

### 2. Appointment booking and operations alerts

- The frontend booking journey now resolves the selected therapist from the live approved-therapist API and uses the existing availability and booking APIs rather than demo therapist records.
- When an `appointment.booked` event is consumed, the Notification Service sends an operations email to `MINDORA_BOOKING_ALERT_EMAILS` and can send SMS to `MINDORA_BOOKING_ALERT_PHONES`.
- SMS delivery uses the existing Africa's Talking adapter and is intentionally disabled until the owner enables it and supplies credentials and recipient numbers. Configurable staff Voice-call alerts are also supported through the Africa's Talking Voice API; Voice remains disabled until the account has an issued Voice number, public callbacks and a controlled test.

### 3. Login and password security

- Signup includes Create password and Confirm password and rejects mismatches.
- Password policy is at least 8 characters with letters and numbers (maximum 128 characters).
- Existing Argon2id password hashing remains in use.
- Forgot-password creates a high-entropy, hashed, one-time Redis token that expires after 15 minutes; Redis `GETDEL` consumes it atomically.
- Five unsuccessful login attempts trigger a 15-minute lockout. A security email event is queued for the account owner.
- Successful password reset clears the lock and revokes active refresh tokens.
- The frontend revokes the server session and clears client state after 30 minutes of inactivity by default; this can be configured with `NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS`.

### 4. Therapist onboarding

- Separate `/therapist/login` and `/therapist/signup` entry points are provided.
- Therapist applicants register with the patient role first and submit an application; a browser request cannot grant itself the privileged THERAPIST role.
- Application documents include CV, practising licence and diploma. The existing admin review/approval path remains the gate for activation.
- The public therapist directory and profile pages now use approved, accepting therapists from the live backend API, not the old demo cards.

### 5. Business page and UI

- The `/business` route uses same-tab internal navigation. External document viewing in the therapist application/admin review flows intentionally opens a separate tab and is not the business-page navigation.
- Frontend primary accents have been updated to a teal/white MINDORA treatment. Therapist discovery and booking are wired to live API data.
- The supplied `mindora-website_v2` source is included in the frontend delivery bundle as a separate source folder; it has not been redesigned in this change set.

### 6. Bug audit

- A source-level review was made around therapist discovery, booking, registration, reset-password, therapist application, event notification and same-tab business navigation.
- A concise audit is included in the front-end delivery notes. This is not a claim that every browser/device/production integration has been exhaustively tested.

### 7. Hosting comparison

- See `MINDORA_HOSTING_COMPARISON.md`. No production services, DNS, databases or hosting were moved as part of this source change.

### 8. Chatbot integration plan

- The backend AI Integration Service currently proxies to a separately hosted Therapy Chatbot API using `THERAPY_CHATBOT_BASE_URL` and `MINDORA_INTEGRATION_KEY`.
- The standalone `MindoraVersionTwo` Python repository was not included in the supplied archives. Its internals and tests could not be modified or verified here.
- The frontend and booking hand-off plan is documented in `MINDORA_CHATBOT_INTEGRATION_PLAN.md`.

## Required production configuration (do not commit real secrets)

Set the following in the deployment secret manager / environment:

| Variable                                              | Purpose                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `RESEND_EMAIL_API_KEY`                                | Transactional email provider credential                                   |
| `RESEND_FROM_EMAIL`                                   | Sender address from a domain verified in Resend                           |
| `MINDORA_CRISIS_ALERT_EMAILS`                         | Restricted on-call/clinical crisis inbox(es), comma-separated             |
| `MINDORA_BOOKING_ALERT_EMAILS`                        | Booking operations inbox(es), comma-separated                             |
| `MINDORA_CRISIS_ALERT_PHONES`                         | Restricted crisis duty phone(s), E.164 format                             |
| `MINDORA_BOOKING_ALERT_PHONES`                        | Booking operations phone(s), E.164 format                                 |
| `SMS_ENABLED`                                         | Set `true` only after SMS testing and approval                            |
| `AT_API_KEY`, `AT_USERNAME`                           | Africa's Talking credentials                                              |
| `AT_SENDER_ID`                                        | Optional sender ID if approved for the account                            |
| `APP_BASE_URL`                                        | Production frontend base URL used to construct reset links                |
| `COOKIE_DOMAIN`                                       | Production parent domain when the app and API are on different subdomains |
| `OBJECT_STORAGE_*`                                    | S3-compatible storage needed for therapist CV/licence/diploma files       |
| `THERAPY_CHATBOT_BASE_URL`, `MINDORA_INTEGRATION_KEY` | External Python chatbot service integration                               |

For production, set `APP_BASE_URL=https://app.mindora.rw`, use the verified MINDORA email sender, restrict alert recipients to authorised staff, configure object storage with private access, and use Redis 6.2+ for atomic `GETDEL` reset-token consumption.

## Suggested rollout sequence and timeline

Indicative working-day schedule after MINDORA supplies the required contacts and provider credentials. These are planning estimates, not a deployment commitment:

| Working days | Work                                                           | Exit condition                                                                                     |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1–2          | Clinical review, crisis contacts, alert routing, staging tests | Clinician signs off phrase rules, message and escalation SOP; email alert reaches restricted inbox |
| 3–4          | Booking end-to-end, email and SMS provider test                | Staging booking is saved; authorised team receives email and SMS                                   |
| 5–6          | Auth/security staging tests                                    | Mismatch, password policy, reset, 5-attempt lock and idle logout pass                              |
| 7–8          | Therapist application and admin review                         | CV/licence/diploma uploaded privately; unapproved profiles stay hidden                             |
| 9–10         | Cross-application QA and bug retest                            | Regression checklist passes on supported desktop/mobile browsers                                   |
| 11           | Hosting cost baseline and architecture review                  | Costed proposal approved; no migration before written approval                                     |
| 12           | Chatbot hand-off integration test and handover                 | Chat session can route to booking without losing approved context                                  |

## Refreshed verification performed for this updated delivery

- Parsed **481 TypeScript/TSX/JavaScript/JSX source files** across the updated backend, web application and official website: **0 syntax parse diagnostics**. This is a syntax scan, not a semantic type-check or production build.
- Parsed **57 JSON** files and **15 YAML** files: no parse errors.
- Ran a manual harness against the actual `preFilter.ts` module for **22 existing crisis/neutral phrase cases: 22/22 expected levels matched**. This is a phrase-matching check, not a clinical accuracy assessment.
- Updated Vitest/Jest test sources, including independent-channel failure regression cases and Voice SDK unit-test source. The full test suites were not executed in this environment.

**Not verified:** complete monorepo/frontend dependency installation, production builds, full Vitest/Jest suites, live Resend delivery, live Africa's Talking SMS, real Redis/RabbitMQ/database staging workflow, production browser end-to-end tests, external Python chatbot behaviour, or a production deploy. The build/test environment provided Node.js 22.16.0; the backend monorepo declares Node.js `>=24.16.0`. Dependency installation did not complete reliably in this environment. Run full CI using the declared runtime before deployment.

## Operational safety notes

- Do not deploy crisis escalation until a qualified clinician signs off the phrase list and the escalation protocol.
- Do not configure crisis/booking email alerts to a public mailbox or a broad distribution list. Use authorised, monitored recipients.
- Do not send full patient transcripts to SMS. SMS messages contain identifiers and direct staff to the restricted inbox/admin workflow.
- Protect CVs, licences and diplomas as sensitive records. Do not expose object-storage URLs publicly.
- No credentials, production user data, `.env` files or private keys are included in this delivery.
