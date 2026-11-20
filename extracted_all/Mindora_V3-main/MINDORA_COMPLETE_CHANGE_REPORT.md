# MINDORA HEALTH — Updated Engineering Progress & Handover Report

**Prepared for:** Kwizera Rulinda, MINDORA Health  
**Reporting date:** 3 November 2026  
**Scope:** Web application, official website, dashboard, backend microservices and supplied conversational-therapy chatbot  
**Release classification:** Pre-production source update — not a production deployment or certification

## 1. Executive summary

This update incorporates the additional MINDORA source archives and the client-edited progress report supplied on 3 November 2026. The source set now includes the MINDORA V3 backend, the existing Next.js web application, the separate official website, the additional Dashboard VII project, and the supplied FastAPI/Python conversational-therapy module with its React client.

The Python chatbot source that was newly supplied has been updated rather than being left as a plan only. A lightweight crisis pre-filter now runs before LLM inference, returns an immediate supportive response for high-risk messages, and can forward a minimal crisis event to the MINDORA V3 internal notification pipeline. Database and JWT secrets are environment-configured; model loading is lazy; and the chatbot signup contract includes password confirmation and stronger password validation.

The V3 backend release includes independent attempts for crisis email, SMS and Voice notifications, an Africa's Talking Voice adapter and callbacks, per-recipient notification deduplication, and a token-protected Python-to-V3 crisis event endpoint. The frontend delivery preserves the existing MINDORA applications and includes the newly supplied dashboard and chatbot client as separate projects.

**Important:** This is a source-level engineering update. Complete Node builds, full Node test suites, browser end-to-end testing, live provider delivery, cross-service staging tests and clinical approval are still required. The packages must not be treated as production-certified or deployed without those steps.

## 2. Source packages reviewed and used

| Supplied source                                           | Use in this update                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Mindora_V3-main (3).zip`                                 | Primary, newly supplied V3 backend source                                                                                      |
| `Mindora_III-frontend-main (4).zip`                       | Original MINDORA web-app source and comparison baseline                                                                        |
| `MINDORA_FRONTEND_OPTIMIZED_UNDER_4MB.zip`                | Optimized derivative of the original web app, used for asset/source comparison                                                 |
| `mindora-website_v2-main.zip`                             | Separate official MINDORA marketing website source                                                                             |
| `Mindora-dashboard_VII-main.zip`                          | Additional dashboard source, retained as a separate Vite/React application                                                     |
| `mindora-conv-therapy-module-main.zip`                    | Supplied FastAPI/Python chatbot backend and associated React client; actual source updated                                     |
| `mindora-final-backend.zip`, `mindora-final-frontend.zip` | Earlier intermediate implementations; inspected as references for selected changes, not treated as the client's primary source |
| Client-edited progress report                             | Reviewed as the requirements/progress baseline for this update                                                                 |

The supplied conversational-therapy archive is not independently proven to be identical to the public `MindoraVersionTwo` GitHub repository. MINDORA should confirm whether it is the intended production chatbot source or whether another repository version must also be merged.

## 3. Progress against the eight client requirements

| #   | Requirement                    | Work completed in source                                                                                                                                                                                                                                                                                                                                                                                                | Status and remaining work                                                                                                                                                                                                         |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Crisis escalation              | Node V3 pre-filter/response pipeline retained; independent email/SMS/Voice channel attempts; Python crisis pre-filter and immediate support response added; Python webhook forwards events to V3 using a shared service token.                                                                                                                                                                                          | **Implemented in source.** Python focused tests passed 28/28. Clinical approval, real provider tests and cross-service staging verification remain required. The detector is not a clinically validated instrument.               |
| 2   | Appointment booking            | Existing V3 availability and booking APIs, validation and anti-double-booking logic retained; main web-app booking flow is connected to the existing backend APIs; email/SMS notification paths are present.                                                                                                                                                                                                            | **Existing source flow retained.** Full staging booking, database and real notification end-to-end tests remain outstanding.                                                                                                      |
| 3   | Login and password security    | V3 source includes Argon2id hashing, five-attempt/15-minute lockout, hashed short-lived single-use reset tokens and refresh/session revocation. Existing web-app password confirmation/strength and inactivity timeout are retained. Python chatbot registration now confirms passwords, validates minimum length/letter/number requirements and uses Argon2 for new hashes while retaining legacy bcrypt verification. | **Implemented in source.** Complete Node auth/security suite and live email reset testing remain outstanding.                                                                                                                     |
| 4   | Therapist login and onboarding | Existing separate therapist application routes, CV/licence/diploma categories, admin review and pending/approved/rejected statuses retained in V3 and web app.                                                                                                                                                                                                                                                          | **Implemented in source.** Verify private document storage, permissions and full admin approval workflow in staging.                                                                                                              |
| 5   | Business page same-tab         | Existing business route uses same-tab internal navigation in the web-app source.                                                                                                                                                                                                                                                                                                                                        | **Implemented in source.** Browser behavior still needs verification.                                                                                                                                                             |
| 6   | Bug fixes                      | Crisis consumer updated so email, SMS and Voice attempts are independent; per-recipient dedupe reduces duplicates during queue retries. Python chatbot issues found during source review were corrected, including premature LLM/model loading, undefined classifier references, empty-list guardrail handling, duplicate router registration and unsafe hardcoded credentials/contact information.                     | **Targeted source fixes included.** Full application/browser/API/device QA has not been completed. Node regression tests are present but were not run in this environment.                                                        |
| 7   | Cheaper hosting                | Preliminary hosting comparison material for Vercel, Netlify, MongoDB Atlas, Render and Fly.io is retained in backend documentation.                                                                                                                                                                                                                                                                                     | **Comparison material prepared.** Reconcile estimates against MINDORA's current usage/invoices. No production hosting, database or DNS migration was performed.                                                                   |
| 8   | Chatbot integration            | The newly supplied Python/FastAPI conversational-therapy module is included and updated. Added token-authenticated webhook handoff to V3 crisis notification pipeline; chatbot crisis response is returned before LLM calls. The chatbot React client is included separately in the frontend package.                                                                                                                   | **Partially implemented in source.** Live chatbot-to-V3 event delivery and chatbot-to-therapist booking journey must be verified in staging. Confirm whether supplied archive is the exact production `MindoraVersionTwo` source. |

## 4. Additional source projects included

### 4.1 MINDORA Dashboard VII

The supplied Dashboard VII Vite/React project is preserved in `DASHBOARD_VII/`. Its previously hardcoded old backend base URL has been moved to a configurable `VITE_API_BASE_URL` setting. Its existing `/api/...` route contract is legacy-compatible but has not yet been mapped and verified against the current V3 gateway. It remains a separately identified dashboard application, not falsely represented as integrated with V3.

### 4.2 Official MINDORA website and chatbot client

The official website remains in `OFFICIAL_WEBSITE/`, separately from the main Next.js web app. The React client supplied with the conversational-therapy module is preserved in `CHATBOT_WEB_CLIENT/`. These projects have not been collapsed into one application or represented as a single tested deployment.

## 5. Key technical changes

### 5.1 Crisis event and notification reliability

- The V3 `handleAi` consumer uses independent settled asynchronous channel operations for configured email, SMS and Voice notifications.
- A failure in one notification provider does not prevent the other channels from being attempted.
- Per-recipient deduplication records and hashed dedupe keys reduce duplicate notifications when the event queue retries.
- The notification event includes source and external chatbot reference metadata where supplied.
- The new Python-to-V3 internal endpoint validates the service token, event ID, timestamp and crisis level, publishes the event to the AI event exchange and waits for broker confirmation before acknowledging receipt.

### 5.2 Africa's Talking Voice

- Added an outbound Voice adapter using the Africa's Talking SDK.
- Added protected VoiceXML callback and call-event routes.
- Added callback gateway routes and environment configuration examples.
- Live call initiation, number provisioning and callback delivery have not been tested with MINDORA's production account.

### 5.3 Python chatbot safety and configuration

- Crisis pre-filter executes before LLM construction or model inference.
- Immediate safety responses do not depend on successful LLM inference.
- Clinical resources are configurable and remain disabled until MINDORA approves them.
- Database URL, JWT signing secret, CORS origins, Qdrant configuration and webhook settings are environment-driven.
- New chatbot password hashes use Argon2; legacy bcrypt hashes remain verifiable.
- Transformer/emotion models load lazily; model unavailability falls back safely rather than blocking application import.
- The supplied Qdrant index files are retained; their schema/embedding compatibility must be checked against the target deployment.

### 5.4 Public contact information

The supplied MINDORA public contact details are presented as general support contacts:

- Phone: **+250 783 974-066**, Monday–Friday, 9:00 AM–5:00 PM.
- Email: **info@mindora.rw**, stated response time within 24 hours.

These details are not described as a 24/7 emergency hotline and are not automatically used as internal crisis alert recipients.

## 6. Verification performed in this update

| Check                                     | Result                                                                                                             | Meaning / limitation                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Python compile check                      | Passed for the supplied chatbot backend source                                                                     | Confirms Python source compiles; does not prove external services run correctly.                                                      |
| Python crisis-safety focused tests        | **28 / 28 passed**                                                                                                 | Tests deterministic pre-filter and response behavior in the focused local suite; not clinical validation or a full application suite. |
| TypeScript/TSX/JavaScript/JSX syntax scan | **576 files scanned; 0 parse diagnostics** (229 backend, 347 frontend)                                             | Syntax parsing only; not semantic type checking, bundling or runtime verification.                                                    |
| Strict JSON files                         | 69 parsed; 0 errors                                                                                                | Syntax only.                                                                                                                          |
| TypeScript config JSONC                   | 2 parsed; 0 errors                                                                                                 | JSON-with-comments config parsing only.                                                                                               |
| YAML files                                | 18 parsed; 0 errors                                                                                                | YAML syntax only; not a successful Docker or Kong deployment.                                                                         |
| Source secret scan                        | No actual `.env` files, private-key blocks or obvious live provider key patterns found in the release source trees | Environment example files contain placeholders; rotate any API key previously pasted into a chat or other public location.            |
| ZIP integrity                             | To be verified on the final packaged archives                                                                      | Archive check does not certify application runtime.                                                                                   |

## 7. Validation not yet completed

- Full backend installation/build, semantic type-check and Jest/Vitest suites were not run. The V3 repository declares Node.js `>=24.16.0`; the available runtime is Node.js 22.16.0 and project dependencies were not installed.
- Full Next.js, official website, Dashboard VII and chatbot React dependency installation, type-check, production builds and browser E2E tests were not run.
- Resend email, Africa's Talking SMS, real Voice calls and provider callbacks have not been live-tested with MINDORA credentials.
- The V3 database migration for notification deduplication has not been applied to production; apply and validate in staging after a database backup.
- The Python webhook has not been tested against a live V3 service, RabbitMQ, database, Ollama or Qdrant deployment.
- The supplied chatbot's local crisis tests passed, but no clinical validation has been performed and no claim of 100% detection accuracy is made.
- Screenshot-by-screenshot Shezlong comparison and browser visual regression have not been completed; no pixel-perfect match is claimed.
- Dashboard VII endpoint compatibility with V3 has not been confirmed.
- No live deployment, hosting migration or DNS change was made.

## 8. Configuration and approvals required from MINDORA

### Email

- Provide Resend API key through the deployment secret manager.
- Verify sender domain/address and approve booking, password/security and crisis notification recipients.

### SMS and Voice

- Configure Africa's Talking username and a rotated API key using deployment secrets.
- Confirm SMS sender configuration and recipient numbers.
- Provision the Africa's Talking Voice number, enable Voice service, configure the public HTTPS callbacks and authorize test recipients/credits.
- Do not reuse any exposed key; rotate it in the Africa's Talking dashboard.

### Python chatbot runtime

- Configure secure database credentials and a strong JWT secret.
- Configure Ollama and Qdrant endpoints/models/collection.
- Set the same high-entropy service token in Python (`MINDORA_CRISIS_WEBHOOK_TOKEN`) and V3 (`CHATBOT_CRISIS_WEBHOOK_TOKEN`).
- Confirm supplied Python module is the production source intended by MINDORA.
- Validate the included Qdrant index files against the target collection and embedding model.

### Clinical and operational approval

- A qualified MINDORA clinical/safeguarding lead must approve risk taxonomy, thresholds, user-facing messages, local referral/emergency resources, Voice script and escalation protocol.
- Confirm authorized alert recipients, coverage hours, backup contacts and acknowledgement/fallback procedure.
- Confirm what minimum information may be included in email/SMS/voicemail and who may access detailed case records.

### Release and deployment

- Use Node.js 24.16.0 or later for V3 build/test validation.
- Install dependencies and run complete application test suites in CI/staging.
- Apply the notification migration in staging after backup.
- Map Dashboard VII's legacy endpoint contract to V3 and test it.
- Perform browser E2E, mobile/responsive and accessibility checks.
- Obtain written release approval before production deployment or hosting migration.

## 9. Recommended next steps

1. Prepare a staging environment matching the declared Node/Python runtimes and connect a test database, RabbitMQ, Redis and Qdrant/Ollama as required.
2. Configure Resend and Africa's Talking with rotated secrets, provisioned Voice number and approved test recipients.
3. Obtain clinical/safeguarding sign-off for crisis content, referrals, escalation ownership and staff coverage.
4. Run complete Node, Python, frontend, integration and browser E2E suites; resolve all failures.
5. Verify Dashboard VII API route mapping and chatbot-to-therapist booking journey.
6. Review hosting cost estimates against actual bills and agree on a migration/rollback plan.
7. Obtain MINDORA's written approval before any production deployment or migration.

---

**Confidential — Prepared for MINDORA Health.** This report distinguishes source implementation and local checks from live provider tests, staging verification and clinical approval. It should not be read as a production-readiness certification.
