import { Router, type Request, type Response } from 'express';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { aiCrisisEventSchema, EXCHANGES } from '@mindora/events';
import { connect } from '@mindora/queue';

const router = Router();

function safeTokenEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function bearerToken(req: Request): string | null {
  // Authorization is user-controlled. Bound parsing work and avoid a
  // backtracking regular expression on attacker-supplied whitespace.
  const value = req.header('authorization') ?? '';
  if (value.length > 4096 || value.slice(0, 6).toLowerCase() !== 'bearer') {
    return null;
  }

  let index = 6;
  const separator = value.charCodeAt(index);
  if (separator !== 0x20 && separator !== 0x09) return null;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09) break;
    index += 1;
  }

  const token = value.slice(index);
  if (!token || token.length > 2048) return null;
  // A bearer credential is a single token, not a whitespace-delimited value.
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  return token;
}

/**
 * Private service-to-service endpoint for the separately deployed Python
 * conversational-therapy module. It intentionally bypasses end-user JWT
 * authentication and instead requires a dedicated high-entropy webhook token.
 * Mount this router before the global authenticate middleware.
 */
router.post(
  '/internal/chatbot-crisis-events',
  async (req: Request, res: Response) => {
    const expectedToken =
      process.env.CHATBOT_CRISIS_WEBHOOK_TOKEN?.trim() ?? '';
    if (!expectedToken) {
      res
        .status(503)
        .json({ error: 'Chatbot crisis webhook is not configured' });
      return;
    }

    const suppliedToken = bearerToken(req);
    if (!suppliedToken || !safeTokenEqual(expectedToken, suppliedToken)) {
      res.status(401).json({ error: 'Unauthorized service request' });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    const eventId = typeof body?.eventId === 'string' ? body.eventId : '';
    const occurredAt =
      typeof body?.occurredAt === 'string' ? body.occurredAt : '';
    const crisisLevel =
      typeof body?.crisisLevel === 'number' ? body.crisisLevel : NaN;
    const conversationId =
      typeof body?.conversationId === 'string'
        ? body.conversationId.slice(0, 120)
        : null;
    const externalUserRef =
      typeof body?.externalUserRef === 'string'
        ? body.externalUserRef.slice(0, 120)
        : undefined;
    const messageExcerpt =
      typeof body?.messageExcerpt === 'string'
        ? body.messageExcerpt.slice(0, 1500)
        : undefined;

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      !uuidPattern.test(eventId) ||
      !Number.isFinite(Date.parse(occurredAt)) ||
      !Number.isInteger(crisisLevel) ||
      crisisLevel < 3 ||
      crisisLevel > 5
    ) {
      res.status(400).json({ error: 'Invalid crisis event payload' });
      return;
    }

    const occurredAtIso = new Date(occurredAt).toISOString();
    const event = aiCrisisEventSchema.safeParse({
      eventId,
      occurredAt: occurredAtIso,
      timestamp: occurredAtIso,
      // A separate chatbot's numeric/string user ID is not a MINDORA V3 user UUID.
      // Keep it as an external reference and use a synthetic UUID for the shared event contract.
      userId: randomUUID(),
      sessionId: conversationId,
      crisisLevel,
      messageExcerpt,
      interactionId: eventId,
      source: 'python-chatbot',
      externalUserRef,
    });

    if (!event.success) {
      res.status(400).json({ error: 'Invalid crisis event payload' });
      return;
    }

    let channel:
      | Awaited<
          ReturnType<
            Awaited<ReturnType<typeof connect>>['createConfirmChannel']
          >
        >
      | undefined;
    try {
      const connection = await connect();
      channel = await connection.createConfirmChannel();
      channel.on('error', (error) => {
        console.error('[chatbot-crisis-webhook] channel error:', error);
      });
      await channel.assertExchange(EXCHANGES.AI, 'fanout', { durable: true });
      channel.publish(
        EXCHANGES.AI,
        '',
        Buffer.from(JSON.stringify(event.data)),
        {
          persistent: true,
          contentType: 'application/json',
        }
      );
      // Do not acknowledge the webhook until RabbitMQ confirms durable acceptance.
      await channel.waitForConfirms();
      await channel.close();
      channel = undefined;
      res.status(202).json({ accepted: true, eventId });
    } catch (error) {
      if (channel) {
        try {
          await channel.close();
        } catch {
          /* best-effort cleanup */
        }
      }
      console.error(
        '[chatbot-crisis-webhook] Failed to publish event:',
        error instanceof Error ? error.message : 'unknown error'
      );
      res.status(503).json({
        error:
          'Crisis event could not be accepted; retry with the same eventId',
      });
    }
  }
);

export default router;
