import { Router } from 'express';
import {
  requireRole,
  type AuthenticatedRequest,
} from '@mindora/auth-middleware';
import { connect } from '@mindora/queue';
import { EXCHANGES } from '@mindora/events';
import { runPreFilter } from '../preFilter.js';
import { prisma } from '../database.js';
import { chatWithBot, deleteRemoteConversation } from '../chatbotClient.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { chatRouteLimiter } from '../middleware/rate-limit.js';

const router = Router();

async function publishCrisisEvent(
  userId: string,
  crisisLevel: number,
  sessionId: string | null
): Promise<void> {
  const connection = await connect();
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGES.AI, 'fanout', { durable: true });
  channel.publish(
    EXCHANGES.AI,
    '',
    Buffer.from(
      JSON.stringify({
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        userId,
        sessionId,
        crisisLevel,
        timestamp: new Date().toISOString(),
      })
    ),
    { persistent: true, contentType: 'application/json' }
  );
  await channel.close();
}

// POST /api/v1/ai/chat — submit a message to the AI (PATIENT only)
router.post(
  '/chat',
  chatRouteLimiter,
  requireRole('PATIENT'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { message, sessionId } = req.body as {
      message?: unknown;
      sessionId?: unknown;
    };

    // Basic body validation — full Zod schema will be added with the AI provider integration
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message must be a non-empty string' });
      return;
    }

    const userId = req.user?.userId;
    const email = req.user?.email;
    const resolvedSessionId = typeof sessionId === 'string' ? sessionId : null;

    const crisisLevel = await runPreFilter(message, userId);

    // Level 5 — immediate escalation; AI is never called under any circumstances
   if (crisisLevel === 5) {
  // INTENTIONAL fire-and-forget: never delay the patient's safety response.
  publishCrisisEvent(
    userId ?? 'unknown',
    crisisLevel,
    resolvedSessionId
  ).catch((err) => {
    console.error(
      '[pre-filter] Failed to publish crisis event to RabbitMQ:',
      err
    );
  });

  res.status(200).json({
    response:
      "I'm concerned about your safety right now. If you are in immediate danger, call Rwanda's emergency number 112 or go to the nearest hospital. You can also contact Umutima Counselling Centre at +250 788 386 225. Please reach out to someone you trust and try not to stay alone. You are not alone.",
    crisisLevel: 5,
    sessionId: resolvedSessionId,
  });

  return;
}

    // TODO[clinical-review]: Levels 3 and 4 currently set inputFlagged and continue
    // to the AI call. A formal escalation path for these levels — specifically whether
    // Level 3 (passive ideation) and Level 4 (active ideation without plan) should
    // trigger therapist SMS alerts, in-app safety check prompts, or modified AI system
    // prompts — has NOT been defined yet and requires clinical review before go-live.
    // See: AFSP Safe Messaging Guidelines, Columbia Suicide Severity Rating Scale (C-SSRS).
    const inputFlagged = crisisLevel >= 1;

    if (!userId || !email) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const start = Date.now();
    let botMessage;
    try {
      botMessage = await chatWithBot(userId, email, message);
    } catch (err) {
      console.error('[chat] Therapy chatbot call failed:', err);
      res
        .status(502)
        .json({ message: 'The AI companion is temporarily unavailable' });
      return;
    }
    const responseMs = Date.now() - start;

    await prisma.aiInteraction.create({
      data: {
        user_id: userId,
        session_id: resolvedSessionId ?? botMessage.id,
        user_message: encrypt(message),
        ai_response: encrypt(botMessage.content),
        input_flagged: inputFlagged,
        output_flagged: false,
        crisis_level: crisisLevel,
        response_ms: responseMs,
      },
    });

    res.status(200).json({
      response: botMessage.content,
      crisisLevel,
      sessionId: resolvedSessionId,
    });
  })
);

// GET /api/v1/ai/history — retrieve session interaction history (PATIENT only)
router.get(
  '/history',
  requireRole('PATIENT'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.aiInteraction.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      prisma.aiInteraction.count({ where: { user_id: userId } }),
    ]);

    // message/response are independently nullable — a row that can't be
    // decrypted (wrong/rotated AI_INTERACTION_ENCRYPTION_KEY, corruption)
    // must not take down the whole page of history.
    const interactions = rows.map((row) => {
      let message: string | null;
      try {
        message = decrypt(row.user_message);
      } catch {
        message = null;
      }
      let response: string | null;
      try {
        response = decrypt(row.ai_response);
      } catch {
        response = null;
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        message,
        response,
        crisisLevel: row.crisis_level,
        createdAt: row.created_at.toISOString(),
      };
    });

    res.status(200).json({ interactions, total, page, limit });
  })
);

// DELETE /api/v1/ai/history — delete all interaction history (PATIENT only)
router.delete(
  '/history',
  requireRole('PATIENT'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const { count } = await prisma.aiInteraction.deleteMany({
      where: { user_id: userId },
    });
    // Best-effort — the vendor's own conversation/transcript is separate
    // from our audit rows just deleted above; a failure there must not
    // undo (or block reporting) the deletion of what we actually own.
    const remoteConversationDeleted = await deleteRemoteConversation(userId);

    res.status(200).json({
      message: 'History deleted',
      localInteractionsDeleted: count,
      remoteConversationDeleted,
    });
  })
);

// GET /api/v1/ai/usage — aggregate token usage report (ADMIN only)
router.get(
  '/usage',
  requireRole('ADMIN'),
  asyncHandler(async (_req, res) => {
    type DailyRow = { date: Date; count: bigint | number };

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // All five queries run in parallel — this is an analytics endpoint and latency matters.
    const [
      aggregate,
      totalInteractions,
      totalCrisisEvents,
      topUsersRaw,
      dailyRaw,
    ] = await Promise.all([
      // 1. Sum of tokens + average response time across all interactions
      prisma.aiInteraction.aggregate({
        _sum: { tokens_used: true },
        _avg: { response_ms: true },
      }),
      // 2. Total row count
      prisma.aiInteraction.count(),
      // 3. Rows where the pre-filter triggered immediate escalation
      prisma.aiInteraction.count({ where: { crisis_level: 5 } }),
      // 4. Top 10 users by interaction volume, descending
      prisma.aiInteraction.groupBy({
        by: ['user_id'],
        _count: { user_id: true },
        orderBy: { _count: { user_id: 'desc' } },
        take: 10,
      }),
      // 5. Daily interaction counts for the last 30 days.
      // Prisma 6 groupBy cannot group by a derived date expression (DATE_TRUNC),
      // so $queryRaw is used only here; all other queries use the type-safe Prisma API.
      prisma.$queryRaw<DailyRow[]>`
        SELECT DATE_TRUNC('day', created_at)::date AS date,
               COUNT(*)::int                        AS count
        FROM   ai_interactions
        WHERE  created_at >= ${thirtyDaysAgo}
        GROUP  BY 1
        ORDER  BY 1 ASC
      `,
    ]);

    res.status(200).json({
      totalInteractions,
      totalTokensUsed: aggregate._sum.tokens_used ?? 0,
      totalCrisisEvents,
      avgResponseMs: Math.round(aggregate._avg.response_ms ?? 0),
      topUsers: topUsersRaw.map((row) => ({
        userId: row.user_id,
        interactionCount: row._count.user_id,
      })),
      // COUNT(*)::int comes back as a JS number from pg; Number() handles the rare
      // BigInt case if the driver ever returns one.
      dailyBreakdown: (dailyRaw as DailyRow[]).map((row) => ({
        date: new Date(row.date).toISOString().split('T')[0],
        count: Number(row.count),
      })),
    });
  })
);

export default router;
