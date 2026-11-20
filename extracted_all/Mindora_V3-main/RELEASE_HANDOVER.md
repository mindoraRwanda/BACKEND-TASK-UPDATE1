# MINDORA V3 Release Handover

## What's included

- Current MINDORA V3 backend monorepo, updated with independent crisis notification channels, Africa's Talking Voice source integration, webhook/callback routes, per-recipient deduplication and a private chatbot-crisis handoff.
- Supplied FastAPI/Python conversational-therapy module under `services/python-conversational-therapy/`.
- Node and Python environment templates; no production secrets are included.

## Required runtime

The V3 backend package declares Node.js `>=24.16.0`. This release was source-checked in an environment running Node.js 22.16.0, so the complete Node build, semantic type-check and Jest/Vitest suite must be run under the declared version.

## First staging steps

1. Use a non-production staging database and take a backup before applying any migration.
2. Generate Prisma clients and apply migrations using the repository's documented commands.
3. Configure Resend and Africa's Talking credentials using a secret manager.
4. Provision an Africa's Talking Voice number and an HTTPS callback URL.
5. Set a high-entropy shared `CHATBOT_CRISIS_WEBHOOK_TOKEN` in V3 and `MINDORA_CRISIS_WEBHOOK_TOKEN` in Python service.
6. Obtain MINDORA clinical approval before enabling approved crisis contacts or escalation scripts.
7. Run the complete Node tests, service integration tests and actual provider delivery tests.

## Safety and operational gates

- Keep `CRISIS_CONTACTS_APPROVED=false` until written MINDORA clinical approval is received.
- Set `AT_VOICE_ENABLED=false` until Voice is provisioned and authorized recipients/callbacks are verified.
- Do not send crisis transcripts or unnecessary sensitive patient details through SMS or voicemail.
- Keep the public phone +250 783 974-066 (Mon–Fri, 09:00–17:00) and info@mindora.rw (response within 24 hours) as general support channels, not 24/7 emergency channels or internal alert recipients unless MINDORA separately authorizes this.
- Do not deploy, migrate hosting or change DNS until MINDORA approves the release.
