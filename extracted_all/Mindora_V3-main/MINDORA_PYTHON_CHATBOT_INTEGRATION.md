# MINDORA Python Conversational Therapy Integration

## Included source

The separately supplied `mindora-conv-therapy-module-main.zip` is included under:

`services/python-conversational-therapy/`

This is the actual supplied FastAPI/Python conversational-therapy module. The archive name is `mindora-conv-therapy-module-main`; its identity as the same repository/version as `mindoraRwanda/MindoraVersionTwo` has not been independently verified. MINDORA should confirm that these are the intended production chatbot sources.

## Crisis-event handoff

The Python service can forward a detected crisis event to the MINDORA V3 AI Integration Service:

`POST /api/v1/ai/internal/chatbot-crisis-events`

Authentication:

`Authorization: Bearer <CHATBOT_CRISIS_WEBHOOK_TOKEN>`

The same high-entropy token must be configured in both services using deployment secrets. Never commit it or place it in a browser bundle.

Required Python environment:

- `MINDORA_CRISIS_WEBHOOK_URL` — full HTTPS URL to the V3 endpoint.
- `MINDORA_CRISIS_WEBHOOK_TOKEN` — shared secret set in the V3 `CHATBOT_CRISIS_WEBHOOK_TOKEN` environment variable.

Payload fields include a UUID `eventId`, ISO timestamp `occurredAt`, `crisisLevel` 3–5, `conversationId`, `externalUserRef` and bounded `messageExcerpt`. The V3 service validates the payload, publishes it to the AI event exchange and waits for broker confirmation before acknowledging the webhook.

The Python notifier retries a bounded number of transient transport/server failures using the same event ID. The Node notification consumer attempts enabled email, SMS and Voice channels independently and uses per-recipient idempotency records.

## Local configuration and verification

1. Copy `services/python-conversational-therapy/.env.example` to a local `.env` outside version control.
2. Set secure database and JWT secrets; production mode intentionally fails closed when required secrets are missing.
3. Configure Ollama/Qdrant and confirm the provided vector data matches the target collection before enabling RAG.
4. Set the service-to-service webhook URL and shared token in a secret manager.
5. Run `python -m compileall -q app tests` from the Python service directory.
6. Run `python -m pytest -q tests/test_crisis_safety.py`.
7. Run integration tests against a staging V3 AI Integration Service with authorized test data.

## Safety and limitations

The pre-filter is a deterministic technical signal detector, not a clinically validated assessment instrument. It must not be presented as a diagnosis or as 100% detection. MINDORA's clinical/safeguarding lead must approve the taxonomy, risk thresholds, user-facing content, crisis resources, staffing and escalation protocol before production use.

Public MINDORA contact information (+250 783 974-066, Monday–Friday 9:00–17:00; info@mindora.rw, stated response within 24 hours) is displayed only as general support contact information. It is not described as an emergency hotline or 24/7 service.

Live Ollama, Qdrant, database, Resend, Africa's Talking SMS/Voice and cross-service callbacks were not tested against production services in this packaging environment. Apply database migrations and run the complete integration suite in staging first.
