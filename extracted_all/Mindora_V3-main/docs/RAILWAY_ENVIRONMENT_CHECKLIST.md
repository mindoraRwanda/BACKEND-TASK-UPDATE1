# Railway production environment checklist

This checklist compares the reviewed V3 source requirements with the variable names currently present on the Railway services. It never includes secret values. Add values in the correct Railway service, not globally, and do not paste secrets into GitHub.

## Required before deploying the V3 backend source

Set these on the Railway `Mindora_V3` backend service:

| Variable                     | Value / action                                            | Why                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKIE_DOMAIN`              | `.mindora.rw`                                             | Lets the refresh cookie be shared across `app.mindora.rw` and `api.mindora.rw`; otherwise the frontend edge guard can send a logged-in user back to login. |
| `PUBLIC_KONG_URL`            | `https://api.mindora.rw`                                  | Browser-facing therapist document download links must use the public gateway, not the private `kong:8000` hostname.                                        |
| `OAUTH_SUCCESS_REDIRECT_URL` | `https://app.mindora.rw/oauth/success`                    | Prevents successful Google OAuth from redirecting to the localhost default.                                                                                |
| `COMMUNITY_ENCRYPTION_KEY`   | Generate a new random value: `openssl rand -hex 32`       | AES-256-GCM encryption for community author IDs.                                                                                                           |
| `MESSAGE_ENCRYPTION_KEY`     | Generate a different random value: `openssl rand -hex 32` | AES-256-GCM encryption for private messages.                                                                                                               |

The encryption code in this PR supports reading existing records encrypted with the previous development fallback key, but new production writes fail closed if either dedicated key is missing. Generate separate keys; never reuse the JWT secret, chatbot integration key, or each other's encryption key. Keep them in Railway only.

## Therapist document uploads

Set these on the same `Mindora_V3` service if therapist application credential uploads/downloads must work:

- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_ENDPOINT` (the provider's S3-compatible endpoint; leave empty only for AWS S3)
- `OBJECT_STORAGE_REGION` (for example, `auto` for Cloudflare R2)
- `OBJECT_STORAGE_ACCESS_KEY_ID`
- `OBJECT_STORAGE_SECRET_ACCESS_KEY`

Use a private bucket and least-privilege credentials. Without these values, therapist application document upload/download routes return storage errors; the rest of the application can run without document storage, but that workflow is not complete.

## Crisis and booking alert recipients

Set these on the `Mindora_V3` backend service:

- `MINDORA_CRISIS_ALERT_EMAILS`: comma-separated addresses for the authorised MINDORA clinical/safety response team.
- `MINDORA_BOOKING_ALERT_EMAILS`: comma-separated operations recipients for new appointment alerts (optional).
- `MINDORA_CRISIS_ALERT_PHONES`: comma-separated E.164 phone numbers, only if SMS delivery is enabled.
- `MINDORA_BOOKING_ALERT_PHONES`: comma-separated E.164 phone numbers, only if booking SMS alerts are enabled.

Do not use a general public inbox as the only crisis recipient unless MINDORA explicitly designates it for that purpose. The app's published general support contact is not an emergency hotline.

The backend already has Resend-related variable names. Verify that `RESEND_EMAIL_API_KEY` and `RESEND_FROM_EMAIL` contain valid production values and that the sender domain is verified. Do not replace a working provider key unnecessarily.

## SMS — optional, requires provider setup

The following are not currently present on the V3 Railway service. Add only after the MINDORA Africa's Talking account and sender identity are approved:

- `AT_API_KEY`
- `AT_USERNAME`
- `AT_SENDER_ID`
- `SMS_ENABLED=true`

Then add the authorised `MINDORA_CRISIS_ALERT_PHONES` and, if needed, `MINDORA_BOOKING_ALERT_PHONES`. Test delivery to an approved staff phone before enabling production crisis SMS. Do not enable SMS with placeholder credentials.

## Voice calls — optional, requires an issued Voice number

Only after Africa's Talking has issued/approved the Rwanda Voice number and a test call succeeds, set:

- `AT_VOICE_ENABLED=true`
- `AT_VOICE_NUMBER`: the issued provider number
- `AT_VOICE_WEBHOOK_TOKEN`: a new high-entropy secret
- `AT_VOICE_CALLBACK_URL=https://api.mindora.rw/webhooks/voice/callback?token=<same-token>`
- `AT_VOICE_EVENTS_URL=https://api.mindora.rw/webhooks/voice/events?token=<same-token>`
- `MINDORA_CRISIS_ALERT_VOICE_PHONES`: authorised staff numbers in E.164 format
- `MINDORA_CRISIS_VOICE_SCRIPT`: only the MINDORA-approved short operational message

The Kong gateway routes `POST /webhooks/voice/callback` and `POST /webhooks/voice/events` to the notification service. Keep the webhook token private. Do not enable voice before a real provider test.

## Clinical approval gate

Keep `CRISIS_CONTACTS_APPROVED=false` until MINDORA's clinical lead approves the exact resources and wording in writing. Only then set:

- `CRISIS_CONTACTS_APPROVED=true`
- `CRISIS_APPROVED_RESOURCES`: semicolon-separated, clinically approved contacts/resources.

Do not describe the published MINDORA office phone/email as emergency or 24/7 crisis services. The code labels those as general support contacts.

## Existing integrations — verify values, do not create duplicate keys

The following variable names already exist on the relevant Railway services:

- V3 backend: `MINDORA_INTEGRATION_KEY` and `THERAPY_CHATBOT_BASE_URL`.
- Existing `Mindora-chatbot` service: `INTEGRATION_API_KEY` and `INTEGRATION_TOKEN_SECRET`.

Verify that the V3 backend's `MINDORA_INTEGRATION_KEY` is exactly the same secret as the chatbot's `INTEGRATION_API_KEY`, and that `THERAPY_CHATBOT_BASE_URL` points to the private Railway URL of the existing chatbot service. Do not replace `INTEGRATION_TOKEN_SECRET`; it is used by the chatbot to sign short-lived session tokens.

The live chatbot also has `ALERT_FALLBACK_EMAIL`, `ALERTS_FROM`, `EMAILS_ENABLED`, and `SENDGRID_API_KEY` variable names. Verify that the fallback recipient is an authorised MINDORA response mailbox, `EMAILS_ENABLED=1`, and the sender/provider are valid. This is separate from V3's `MINDORA_CRISIS_ALERT_EMAILS` recipient list.

## Google OAuth verification

The V3 service already has Google OAuth variable names, but a previous login attempt returned `401 invalid_client`. Verify the client ID/secret pair in Google Cloud Console and confirm:

- `GOOGLE_CALLBACK_URL=https://api.mindora.rw/oauth/google/callback`
- `OAUTH_SUCCESS_REDIRECT_URL=https://app.mindora.rw/oauth/success`
- The exact callback URL is authorised in the Google OAuth client.

Do not rotate or replace the client secret unless MINDORA has access to the correct Google Cloud project.

## Migration and deployment warning

Do not deploy the new backend source or rerun Prisma migrations until each of the seven production databases has been checked for its `_prisma_migrations` state. The prior all-database pre-deploy loop failed and may have applied earlier schemas before stopping. Back up each database and reconcile the applied migration history first. No production migration is run by this checklist.
