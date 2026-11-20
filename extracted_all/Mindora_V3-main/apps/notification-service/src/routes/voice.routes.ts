import { Router, type Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  finishNotificationAttempt,
  logNotification,
} from '../notificationLogger.js';
import { voiceWebhookLimiter } from '../middleware/rate-limit.js';

export const voiceWebhooksRouter = Router();

function safeTokenMatch(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorizedWebhook(req: Request): boolean {
  const expected = process.env.AT_VOICE_WEBHOOK_TOKEN;
  if (!expected) return false;
  const received = String(
    req.query.token ?? req.header('x-at-voice-token') ?? ''
  );
  return safeTokenMatch(received, expected);
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char] ?? char
  );
}

/**
 * Africa's Talking calls this URL to obtain VoiceXML instructions after a
 * recipient answers an outbound call. Configure the issued Voice number's
 * callback URL to this endpoint, including the AT_VOICE_WEBHOOK_TOKEN query.
 */
voiceWebhooksRouter.post(
  '/webhooks/voice/callback',
  voiceWebhookLimiter,
  (req, res) => {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).type('text/plain').send('Unauthorized');
    }
    const script =
      process.env.MINDORA_CRISIS_VOICE_SCRIPT?.trim() ||
      'This is an automated MINDORA operations alert. A safety event requires your attention. Please access the secure MINDORA administration console and follow the approved escalation procedure.';
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(script)}</Say><Hangup/></Response>`;
    return res.status(200).type('text/xml').send(xml);
  }
);

/** Receives Voice call event updates; no patient message or transcript is logged. */
voiceWebhooksRouter.post(
  '/webhooks/voice/events',
  voiceWebhookLimiter,
  async (req, res) => {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).type('text/plain').send('Unauthorized');
    }
    const body = req.body as Record<string, unknown> | undefined;
    // Africa's Talking posts event fields, while some deployments/proxies can
    // preserve callback tags in the query string. Read both without trusting
    // arbitrary values or logging phone numbers.
    const field = (name: string): unknown => body?.[name] ?? req.query[name];
    const state = String(
      field('callSessionState') ?? field('status') ?? 'unknown'
    ).slice(0, 40);
    const sessionId = String(field('sessionId') ?? 'unknown').slice(0, 100);
    const normalized = state.toLowerCase();
    // Bridged means the call connected and may still be active; Completed is
    // the terminal successful state. NotAnswered/Expired indicate no answer.
    const status =
      normalized === 'completed'
        ? 'delivered'
        : ['notanswered', 'expired', 'failed', 'aborted'].includes(normalized)
          ? 'failed'
          : 'accepted';

    const clientRequestId = String(field('clientRequestId') ?? '');
    const destinationNumber = String(field('destinationNumber') ?? '');
    const requestIdMatch = /^mindora-([0-9a-f-]{36})-[0-9a-f]{10}$/i.exec(
      clientRequestId
    );
    const eventId = requestIdMatch?.[1] ?? '';
    if (eventId && /^\+[1-9]\d{7,14}$/.test(destinationNumber)) {
      await finishNotificationAttempt(
        `${eventId}:voice:${destinationNumber}`,
        status,
        status === 'failed'
          ? `Africa's Talking call ended with state=${state}`
          : undefined
      );
    }

    // Keep a provider event audit row as well; do not log the caller or
    // destination phone number or any patient-related data.
    await logNotification({
      userId: 'mindora-system',
      eventType: `africastalking.voice.${normalized}`,
      channel: 'voice',
      status,
      failureReason: `Africa's Talking call session ${sessionId}; state=${state}`,
    });
    return res.status(200).type('text/plain').send('OK');
  }
);
