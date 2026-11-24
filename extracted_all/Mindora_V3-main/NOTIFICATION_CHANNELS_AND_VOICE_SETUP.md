# Notification Channels and Africa's Talking Voice Setup

## Independent crisis channels

The AI crisis consumer calls email, SMS and Voice through independent promises. One rejected provider does not prevent the other channels from being attempted. Failed channels bubble to the existing queue retry mechanism. Per-recipient hashed idempotency keys help avoid repeating channels already marked delivered/accepted when another channel fails.

## Environment

Configure through your deployment secret manager:

- `AT_API_KEY`
- `AT_USERNAME`
- `AT_SENDER_ID` (only if approved for the account)
- `SMS_ENABLED=true` after SMS account and recipient verification
- `AT_VOICE_ENABLED=true` only after a Voice number is issued and controlled testing is approved
- `AT_VOICE_NUMBER`
- `AT_VOICE_WEBHOOK_TOKEN` (long random value)
- `MINDORA_CRISIS_ALERT_VOICE_PHONES` (only authorized staff recipients)
- `AT_VOICE_CALLBACK_URL`
- `AT_VOICE_EVENTS_URL`
- `RESEND_EMAIL_API_KEY`
- `RESEND_FROM_EMAIL`
- `MINDORA_CRISIS_ALERT_EMAILS`
- `MINDORA_CRISIS_ALERT_PHONES`

## Voice number dashboard setup

1. Obtain an Africa's Talking-issued Voice number for the MINDORA account.
2. Deploy the notification service behind the public HTTPS API gateway.
3. Configure the Voice number's callback URL to `/webhooks/voice/callback`.
4. Configure its events URL to `/webhooks/voice/events`.
5. Configure the callback token according to the current Africa's Talking portal's supported URL/header behavior. The current routes accept a `token` query parameter or `x-at-voice-token` header. If using a query token, configure gateway/application access logs to redact the query string so the token is not written to logs.
6. Send a controlled test call to an authorized staff test recipient and verify the Voice events callback.
7. Keep Voice disabled until the owner has approved the voice wording and escalation procedure.

The Voice number is the provider-issued caller ID (`AT_VOICE_NUMBER`); it is not the same thing as MINDORA's public contact phone number.

## Current Voice behavior

The service initiates an outbound call using the existing `africastalking` Node SDK and uses `clientRequestId` to tag the provider request. The callback sends a short generic MINDORA operations alert and asks the staff member to consult the restricted admin console. It does not include patient names or crisis message text in audio. The callback event records provider state without logging patient content.

Provider acceptance means the call request was accepted, not that the person answered. Review final events such as Bridged, Completed, NotAnswered or Expired. Automatic repeated call cadence is intentionally not configured until MINDORA approves an escalation policy.

## Security

- Do not commit `.env` or production keys.
- Rotate any API key previously pasted into chat or another plaintext channel.
- Use a long random callback token and HTTPS.
- Use only authorized staff recipients.
- Do not send patient transcripts or sensitive crisis details in voicemail/SMS.
- MINDORA's public phone and info email are general support contacts, not internal escalation destinations unless approved.

## Migration

Apply `apps/notification-service/prisma/migrations/20261101160000_add_notification_dedupe_key/migration.sql` via the service's normal Prisma migration deployment after a backup and a staging validation.
