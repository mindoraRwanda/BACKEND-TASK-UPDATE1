# MINDORA V3 Backend — CI and Security Repair Report

**Prepared:** 4 November 2026  
**Source:** User-supplied `MINDORA_FINAL_BACKEND (1).zip`  
**Target:** Follow-up changes for MINDORA V3 Pull Request #77  
**Status:** Source-level fixes applied; full CI verification remains required.

## Summary of changes

### 1. CodeQL / request parsing

- Replaced the user-input-dependent Bearer-token regular expression in `apps/ai-integration-service/src/routes/chatbot-crisis.routes.ts` with bounded parsing. The parser rejects oversized authorization headers and tokens, accepts a single Bearer token, and avoids regex backtracking on attacker-controlled whitespace.
- Added a regression test for an oversized Bearer header.

### 2. Voice webhook hardening

- Added a dedicated `voiceWebhookLimiter` in the notification service and applied it to both `/webhooks/voice/callback` and `/webhooks/voice/events`.
- Kept webhook token verification and timing-safe comparison in place.
- Corrected unnecessary string/regex escapes flagged by ESLint.

### 3. Notification consumer and lint corrections

- Corrected the reported unused variables in notification consumers.
- Reconnected the existing `sendSmsIfEnabled` helper to patient booking, confirmation, and cancellation notifications. Patient SMS still respects the patient's SMS preference and the `SMS_ENABLED` feature flag; message content does not include clinical details.
- Used independent `Promise.allSettled` channel attempts so a failure in one notification channel does not prevent other channels from being attempted.
- Added a therapist participant-history test so the previously unused therapist authorization header is exercised.
- Removed the unused `AuthUser` import.

### 4. CI and workspace build ordering

- Restricted the test job's Compose startup command to infrastructure dependencies only: PostgreSQL, Redis, MongoDB, RabbitMQ, and Kong. The test setup no longer tries to build/start every application container while running the infrastructure-start step.
- Made workspace tests depend on upstream workspace builds (`^build`) as well as upstream tests (`^test`), so packages that export compiled `dist` files (including `@mindora/events`) are built before dependent workspace tests run.
- Changed Docker build-stage installs from `npm install` to `npm ci` to use the committed lockfile deterministically.

### 5. Production dependency audit remediation

- Updated the root Joi dependency and overrides to `18.3.1` and synchronized the lockfile.
- This addresses the published High-severity advisory GHSA-4528-x5fx-h6hg / CVE-2026-118772 affecting Joi versions `>=18.0.0` and `<18.3.1`, which describes quadratic-time processing in `string().email({ multiple: true })`.

## Validation completed in this environment

The following source-level checks completed successfully:

- 39 JSON files parsed.
- 14 YAML files parsed.
- 223 TypeScript/TSX files passed TypeScript transpilation syntax diagnostics (this is a syntax pass, not a full semantic type-check).
- 6 JavaScript files passed `node --check`.
- 24 Python files parsed successfully.
- Targeted assertions confirmed the reported lint patterns were cleared, Voice routes use the limiter, the Bearer parser is bounded, the CI Compose command starts only infrastructure dependencies, Turbo tests depend on upstream builds, and Joi package/override/lock versions agree.
- No `.env`, PEM, or private-key files were present in the project tree when packaged.

**Static validation summary: 17/17 checks passed.**

## Checks not run / release limitations

This execution environment had Node.js `22.16.0`, while this project declares Node.js `24.16.0`; the npm registry was unreachable from the container, and Docker was unavailable. Therefore the following were **not** run here:

- `npm ci` with the project's supported Node.js version
- `npm audit --audit-level=high --omit=dev --omit=optional`
- ESLint and Prettier checks using the repository's locked dependencies
- Vitest/unit/integration test suites
- Full TypeScript semantic builds and Prisma generation/migrations
- Docker image builds or Compose integration tests
- Live Africa's Talking, Resend, SMS, or Voice provider delivery

The GitHub annotation supplied for the UUID template-literal type error did not identify a source file/line. The Compose infrastructure step and workspace build ordering were corrected because the previous Compose command was also attempting to build application containers and because `@mindora/events` resolves from compiled `dist` exports. Re-run the PR checks; if that UUID type error remains in a dedicated build step, obtain the complete compiler output (including file and line) before making a targeted source change.

## Required next steps

1. Extract this ZIP and update the files in the `main` branch of the contributor's fork (not the upstream `mindoraRwanda:main` branch directly).
2. Commit and push the corrections to the same fork branch used by PR #77 so the existing pull request updates.
3. Review the fresh GitHub Actions results. Do not merge while any required CI/security check fails or while the required approving review is missing.
4. Have MINDORA's authorized maintainer/DevOps team review and deploy to Railway. This package has not been deployed to production.
5. Before enabling real crisis Voice/SMS escalation, confirm clinical escalation contacts, approved scripts, staffed coverage, webhook secrets, and provider configuration with MINDORA.

**This report does not certify production readiness.**
