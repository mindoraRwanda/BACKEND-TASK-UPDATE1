# MINDORA Voice and Crisis Notification Patch Notes

Prepared: 2026-11-01

## Implemented in this source package

- Crisis email, SMS and Voice notification handlers are invoked independently with `Promise.allSettled`. A failure in one provider no longer prevents the other channels from being attempted.
- Added durable notification idempotency records using `notification_logs.dedupeKey` and a database migration. Successful/accepted channels are not re-sent when the event is retried because another channel failed. Failed or skipped attempts can be reclaimed. Final Voice callback states may replace `accepted`, while a late API response cannot overwrite a terminal callback result.
- Added an Africa's Talking Voice client using the project's existing `africastalking` SDK dependency and its documented `VOICE.call({ callFrom, callTo, clientRequestId })` method.
- Added VoiceXML callback and call-events webhook routes, protected by `AT_VOICE_WEBHOOK_TOKEN`.
- Added public Kong callback routes and environment configuration.
- Voice call requests are recorded as `accepted`; the provider callback records subsequent call state. Accepted means the API accepted the request, not that the staff member answered.

## Required production configuration

- `AT_API_KEY`, `AT_USERNAME`
- `AT_VOICE_ENABLED=true` only after MINDORA's Africa's Talking account has an approved Rwanda Voice number
- `AT_VOICE_NUMBER` (the issued Africa's Talking number, not MINDORA's public contact number)
- `AT_VOICE_WEBHOOK_TOKEN` (long random secret; set the same token in callback URLs)
- `MINDORA_CRISIS_ALERT_VOICE_PHONES` (authorized staff recipients, E.164 format)
- `AT_VOICE_CALLBACK_URL` and `AT_VOICE_EVENTS_URL` configured on the Voice number dashboard
- `SMS_ENABLED=true`, and `MINDORA_CRISIS_ALERT_PHONES` for SMS recipients
- `RESEND_EMAIL_API_KEY`, `RESEND_FROM_EMAIL`, and `MINDORA_CRISIS_ALERT_EMAILS` for email
- Clinical approval of the voice script and crisis escalation procedure

## Callback configuration

Set the Africa's Talking Voice number's callback URL to:
`https://YOUR_PUBLIC_API_HOST/webhooks/voice/callback?token=YOUR_AT_VOICE_WEBHOOK_TOKEN`

Set its events URL to:
`https://YOUR_PUBLIC_API_HOST/webhooks/voice/events?token=YOUR_AT_VOICE_WEBHOOK_TOKEN`

The token must be generated and stored as a secret. Do not commit it. Kong exposes these two POST routes without JWT because the provider cannot present a MINDORA user JWT; the application enforces the dedicated callback token.

## Testing and limitations

- Automated code tests and TypeScript compilation must be run after installing dependencies and running Prisma generation.
- No live call has been made from this package. Live calls require a provisioned Voice number, valid credentials, approved recipients, account credits and a public HTTPS callback. Africa's Talking states that its Voice sandbox is not operational and instructs developers to request a test number.
- A call status of `accepted` means the provider accepted the outbound API request; final call status arrives through the events callback.
- Do not enable crisis voice notifications before MINDORA approves the call script and on-call escalation protocol.
