# MINDORA Conversational Therapy Module — Update Notes

## Supplied source reviewed

This update uses the user-supplied `mindora-conv-therapy-module-main.zip`, which contains a FastAPI/Python chatbot backend, a separate React test frontend, Ollama/Llama integration, Qdrant retrieval, emotion analysis and a local mental-health knowledge index. It is not assumed to be identical to the GitHub repository named `MindoraVersionTwo`; that repository identity should be confirmed by MINDORA if they are separate deployments.

## Changes in this update

- Added a deterministic, lightweight crisis pre-filter that runs before LLM inference.
- Added a consistent immediate supportive response for explicit high-risk disclosures.
- Added asynchronous service-to-service event forwarding to the MINDORA V3 notification pipeline.
- Added configurable clinical contact fields; unapproved emergency and hotline numbers from the original chatbot source were removed from hardcoded responses.
- Clarified MINDORA's published public contact details (+250 783 974-066, Monday–Friday 9:00 AM–5:00 PM; info@mindora.rw, stated response within 24 hours) as general support, not emergency services.
- Made transformer/emotion-analysis dependencies lazy so importing the API does not trigger model downloads.
- Moved database credentials and JWT signing secret to environment configuration; production startup fails closed if required secrets are missing.
- Made the Python requirements file UTF-8 for portable pip installation.
- Removed duplicate emotion-router registration and made CORS origins configurable.
- Replaced the committed PostgreSQL password in the Docker Compose file with required environment variables.

## Service integration

Configure `MINDORA_CRISIS_WEBHOOK_URL` to the MINDORA V3 AI integration service route:
`/api/v1/ai/internal/chatbot-crisis-events`
Configure the same high-entropy `MINDORA_CRISIS_WEBHOOK_TOKEN` in both services. The webhook is optional in local development; without it, the chatbot still displays the immediate safety response, but automated staff notifications are not forwarded to MINDORA V3.

## Clinical safety gate

The technical signal detector is not a validated clinical instrument. A MINDORA clinical/safeguarding lead must approve the taxonomy, thresholds, user-facing content, local contacts, staff recipients, service hours and escalation protocol before production activation. The chatbot does not hardcode unverified hotline or emergency numbers.

## Known limitations

- Full dependency installation and runtime inference were not executed in this build environment; the pinned Python dependency set includes large machine-learning dependencies and requires an appropriate supported Python/runtime environment.
- Live Ollama, Qdrant, database and Node webhook connectivity were not tested against a running MINDORA deployment.
- The supplied chat module's existing database schema stores chat messages and emotion logs. Review encryption, retention and access policy before production use.
- The existing RAG service expects a Qdrant collection. The packaged vector index files are preserved but must be checked against the target Qdrant deployment and collection schema.
