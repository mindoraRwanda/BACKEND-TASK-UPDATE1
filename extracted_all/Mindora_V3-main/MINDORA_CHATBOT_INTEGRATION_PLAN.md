# MINDORA Chatbot-to-Booking and Crisis Integration

## Supplied chatbot source

The newly supplied `mindora-conv-therapy-module-main.zip` has been inspected and its FastAPI/Python backend is included under `services/python-conversational-therapy/`. Its separate React test client is included in the frontend delivery under `CHATBOT_WEB_CLIENT/`.

The supplied archive is not proven to be byte-for-byte or version-identical to the public `MindoraVersionTwo` GitHub repository. MINDORA should confirm whether this is the intended deployment source or whether an additional repository should be merged.

## Crisis event flow

1. The Python chatbot runs a lightweight deterministic crisis pre-filter before constructing or calling an LLM.
2. When the configured high-risk thresholds are met, it immediately returns a supportive, non-diagnostic safety response.
3. A bounded background notification function sends a minimal event to the V3 internal endpoint using a shared service token.
4. V3 validates the event, publishes it to the durable AI event exchange and acknowledges only after broker confirmation.
5. The notification consumer independently attempts configured email, SMS and Voice channels and records per-channel/per-recipient status with deduplication.
6. Clinical contacts and escalation instructions remain disabled until MINDORA approves and configures them.

## Internal endpoint

`POST /api/v1/ai/internal/chatbot-crisis-events`

Authentication: `Authorization: Bearer <CHATBOT_CRISIS_WEBHOOK_TOKEN>`.

Set `MINDORA_CRISIS_WEBHOOK_URL` and `MINDORA_CRISIS_WEBHOOK_TOKEN` in the Python service. Set the same secret in the Node V3 secret manager. Do not expose the token to browser code.

## Chatbot-to-booking journey

1. User chats with the MINDORA chatbot.
2. If human support is requested, show a clear therapist-discovery handoff.
3. Transfer only a short-lived, opaque handoff ID or allowlisted non-sensitive summary after user consent. Do not put transcripts, diagnoses, crisis details or bearer tokens into URLs.
4. The signed-in user opens therapist discovery using their normal application identity.
5. The user selects an approved therapist and an available slot.
6. The existing booking API persists and confirms the appointment.
7. Booking notifications use the existing configured email/SMS paths.
8. Crisis escalation remains separate and takes priority; booking must never be required before immediate safety support is shown.

## Dashboard integration boundary

The separately supplied `Mindora-dashboard_VII` is preserved under the frontend delivery. Its previous hardcoded API base was converted to `VITE_API_BASE_URL`. Its existing `/api/...` route contract has not yet been verified against V3's current gateway routes; the dashboard remains a separate legacy-compatible UI until endpoint mapping and staging tests are completed.

## Remaining staging work

- Confirm the supplied chatbot archive is the intended production chatbot source.
- Configure database/JWT, Ollama, Qdrant and webhook secrets.
- Validate the provided Qdrant index against the target collection and embedding model.
- Configure Resend and Africa's Talking credentials, voice number, HTTPS callbacks and authorized test recipients.
- Obtain written clinical approval for crisis taxonomy, messages, contacts, staff coverage and acknowledgement/fallback policy.
- Run cross-service staging tests and confirm privacy, retention and consent requirements.
