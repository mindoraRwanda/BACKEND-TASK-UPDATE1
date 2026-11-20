# MINDORA V3 source integration

The Railway backend service builds the application from `extracted_all/Mindora_V3-main/` using the Railway-specific outer-repository Dockerfile at `extracted_all/Mindora_V3-main/Dockerfile.bundle`.

The application source in this directory is synchronized from:

- Repository: `mindoraRwanda/Mindora_V3`
- Branch: `olivi`
- Pinned commit: `b0238d57d3415c4fc0622fbd272de8260151d9ff`

The Railway-specific `Dockerfile.bundle` is intentionally retained from this repository because it uses the outer repository as its Docker build context. The source sync does not alter Railway variables, domains, database contents, or deployment settings. The production environment checklist is maintained alongside this document and must be completed before deploying the new source.

## Existing chatbot boundary

The live `Mindora-chatbot` Railway service is still sourced from `mindoraRwanda/MindoraVersionTwo` at `/backend`, and `MindoraVersionTwo` frontend remains sourced from `/test-frontend` for `ai.mindora.rw`. This PR does not switch either service or replace that chatbot.

The main MINDORA app calls the V3 `/api/v1/ai/chat` endpoint. V3 uses the existing chatbot's `POST /integration/session` contract for normal messages. The backend's `MINDORA_INTEGRATION_KEY` must match the existing chatbot's `INTEGRATION_API_KEY`; its `INTEGRATION_TOKEN_SECRET` remains private to the chatbot service.

The `services/python-conversational-therapy` folder in the upstream source is not part of the Railway bundle runtime and is not a replacement for the existing `MindoraVersionTwo` chatbot. Do not deploy it as a new production chatbot without a separate review.

## Deployment gates

This is a source integration only. Review the migration history, back up production databases, run staging tests, and obtain MINDORA approval before deployment. The integration also adds the additive AUDIO appointment session type and safe legacy-key reads for community/message encryption; production encryption writes require the dedicated keys listed in the checklist. The previous Railway pre-deploy Prisma command failed and may have partially applied migrations. Do not rerun it blindly.

See `extracted_all/Mindora_V3-main/docs/RAILWAY_ENVIRONMENT_CHECKLIST.md` for the exact production variables still required or needing verification.
