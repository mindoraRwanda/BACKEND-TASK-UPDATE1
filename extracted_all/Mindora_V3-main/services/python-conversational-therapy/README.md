# MINDORA Conversational Therapy Service

This is the supplied FastAPI/Python conversational-therapy service. It is packaged as a separate service inside the MINDORA backend release because it has its own API, database models, authentication and runtime dependencies.

The companion React client is packaged separately in the frontend release under `CHATBOT_WEB_CLIENT/`. It is not part of this Python service directory.

## Safety and integration updates

- A deterministic crisis pre-filter runs before LLM inference in both the legacy `/api/chat` route and the authenticated `/auth/messages` route.
- High-risk messages receive an immediate supportive response before LLM/model initialization or network calls.
- Clinical resources are configuration-gated. Unapproved emergency numbers and hospital contacts are not hardcoded into the safety response.
- General MINDORA public contact details are shown with their supplied hours: **+250 783 974-066**, Monday–Friday, 9:00 AM–5:00 PM; **info@mindora.rw**, stated response time within 24 hours. These are general support contacts, not emergency services or a 24/7 crisis hotline.
- Crisis events can be forwarded to the MINDORA V3 AI integration service using a dedicated service-to-service bearer token. V3 performs email/SMS/Voice notification routing.
- Database and JWT secrets are read from environment variables. Production startup fails when required secrets are absent.
- Heavy emotion/insight models are lazy-loaded so importing the API does not immediately download models or block on an inference service.

This is a technical safety aid, not a validated clinical risk instrument. MINDORA's clinical/safeguarding lead must approve wording, risk rules, referral contacts, staff recipients, hours, escalation protocol and Voice script before production activation.

## Project layout in the final delivery

- `app/` — FastAPI routes, authentication, database models and chatbot services.
- `tests/` — focused deterministic crisis-safety tests.
- `mental_health_knowledge/` and `app/services/mental_health_knowledge/` — supplied local vector-index artifacts. Their compatibility with the production Qdrant collection and embedding model must be checked before use.
- `Dockerfile` — builds this Python service from the current directory.
- `docker-compose.yml` — local PostgreSQL, Qdrant and Python API services.
- `.env.example` — configuration template; replace placeholders in a local `.env` file and never commit the real file.

The React companion is in the separate frontend ZIP at `CHATBOT_WEB_CLIENT/`.

## Prerequisites

- Python 3.10 or later; the supplied Dockerfile uses Python 3.10.
- Docker Compose for local PostgreSQL, Qdrant and the API.
- Ollama with the configured model, or a separately configured compatible model endpoint.
- Node.js/npm compatible with `CHATBOT_WEB_CLIENT/package.json` if running the companion client.

## Local setup with Docker Compose

1. Copy `.env.example` to `.env` in this directory.
2. Replace `POSTGRES_PASSWORD` and `CHATBOT_JWT_SECRET` with unique high-entropy values. Use a URL-safe database password in the Compose example, or URL-encode reserved characters in `DATABASE_URL` if configuring it manually.
3. Review `CHATBOT_CORS_ORIGINS`, `OLLAMA_BASE_URL`, and the Qdrant settings.
4. Run `docker compose up -d --build` from this directory.
5. The Python API will be available at `http://localhost:8000`; check `/health` before connecting the React client.
6. The local Qdrant volume starts empty. The supplied HNSW/index artifacts are retained but are not automatically imported into the Qdrant volume. Validate the collection schema and embedding dimensions, then perform an approved data import/migration if required.

For a manual Python setup instead of Docker:

```bash
python -m venv .venv
# Activate the virtual environment for your operating system
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Use a configured PostgreSQL `DATABASE_URL` and Qdrant/Ollama endpoints. Do not use the local SQLite fallback or development JWT behavior in production.

## Running the React companion client

Use the separate frontend release's `CHATBOT_WEB_CLIENT/` directory:

1. Copy its `.env.example` to `.env`.
2. Set `REACT_APP_API_URL` to the reachable FastAPI base URL.
3. Run `npm ci`, then `npm start` for local development or `npm run build` for a production build.

Do not place any API key, database password, JWT secret or internal webhook token in this React environment. React build variables are public to browsers.

## Environment variables

Important Python service variables include:

- `APP_ENV` — `development` or `production`.
- `DATABASE_URL` / `CHATBOT_DATABASE_URL` — database connection string.
- `CHATBOT_JWT_SECRET` — high-entropy JWT signing secret; required in production.
- `CHATBOT_ACCESS_TOKEN_EXPIRE_MINUTES` — access-token lifetime.
- `CHATBOT_CREATE_TABLES_ON_STARTUP` — development convenience only; use reviewed migrations in production.
- `CHATBOT_CORS_ORIGINS` — comma-separated allowlist of frontend origins.
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL` — model runtime settings.
- `QDRANT_HOST`, `QDRANT_PORT`, `QDRANT_COLLECTION`, `QDRANT_EMBEDDING_MODEL` — retrieval settings.
- `MINDORA_CRISIS_WEBHOOK_URL` — V3 internal webhook endpoint, normally `/api/v1/ai/internal/chatbot-crisis-events`.
- `MINDORA_CRISIS_WEBHOOK_TOKEN` — shared high-entropy service secret; must match `CHATBOT_CRISIS_WEBHOOK_TOKEN` in V3.
- `CRISIS_CONTACTS_APPROVED` — must remain `false` until written approval by MINDORA's clinical lead.
- `CRISIS_APPROVED_RESOURCES`, `CRISIS_APPROVED_THERAPIST_ROUTE` — only populate with clinically approved information.

If the V3 webhook is not configured, the chatbot still displays its immediate supportive response, but crisis events are not forwarded to V3 and internal staff notifications are not triggered by this module.

## Testing

Run the focused deterministic safety and webhook suites from this directory:

```bash
python -m pytest -q
python -m compileall -q app tests
```

The local test suite includes crisis pre-filter/support-response cases and mocked service-to-service webhook cases for Bearer authentication, accepted delivery, transient retries, non-retryable authorization failures and bounded transport retries. These tests do not call a live MINDORA V3 endpoint or Africa's Talking provider.

The full pinned requirements include large ML/vector dependencies. Full dependency installation, model downloads, live Qdrant/Ollama calls, browser end-to-end tests, V3 cross-service connectivity, provider delivery and clinical validation must be completed in a configured staging environment before production release.

## Source identity note

This source came from the user-supplied `mindora-conv-therapy-module-main.zip`. Its identity as the public GitHub repository `MindoraVersionTwo` has not been independently established from the uploaded archive alone. MINDORA should confirm whether this is the intended production chatbot source or whether another repository revision must be merged.
