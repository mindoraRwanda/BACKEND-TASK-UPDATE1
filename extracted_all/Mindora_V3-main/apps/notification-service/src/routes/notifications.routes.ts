import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  verifyJwt,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import { authenticatedRouteLimiter } from '../middleware/rate-limit.js';
import { prisma } from '../notificationLogger.js';
import type { Prisma } from '../generated/prisma/index.js';

export const notificationsRouter = Router();

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Storage stays UTC (createdAt/deliveredAt are 'timestamp without time zone',
// always written via Prisma's now()) — that's the correct place to store it.
// Rwanda (Africa/Kigali) is a fixed UTC+2 with no DST, so a flat offset is
// always correct here — this must NOT be reused for timezones that observe DST.
//
// Fixed: this was previously UTC+3 (Rwanda is Central Africa Time, UTC+2 —
// UTC+3 is East Africa Time, Kenya/Tanzania/Uganda's zone, not Rwanda's).
// Every Kigali-converted timestamp this endpoint has ever returned was an
// hour off. Cross-checked against appointment-service's
// generateCandidateSlotsFromWorkingHours (Milestone 2), which independently
// verified UTC+2 against real booking-hour math.
const KIGALI_OFFSET_MS = 2 * 60 * 60 * 1000;

// Returns an ISO 8601 string carrying the '+02:00' offset explicitly, so the
// timezone is self-evident from the value itself — not just a raw UTC string
// a reader has to remember to mentally shift.
function toKigaliIso(date: Date | null): string | null {
  if (!date) return null;
  return new Date(date.getTime() + KIGALI_OFFSET_MS)
    .toISOString()
    .replace('Z', '+02:00');
}

// notification_logs stores a raw eventType string (e.g.
// "therapist_application.approved") for delivery-log filtering — not
// user-facing copy. This maps the known event types this service actually
// consumes (see consumers.ts) to a short title/body for the in-app feed
// below. Falls back to a humanized version of the raw eventType for
// anything not explicitly listed here, so a notification never renders
// blank just because this map didn't happen to include it yet.
const EVENT_DISPLAY_TEXT: Record<string, { title: string; body: string }> = {
  'appointment.booked': {
    title: 'Appointment Booked',
    body: 'Your appointment has been booked and is pending confirmation.',
  },
  'appointment.confirmed': {
    title: 'Appointment Confirmed',
    body: 'Your appointment has been confirmed.',
  },
  'appointment.cancelled': {
    title: 'Appointment Cancelled',
    body: 'One of your appointments was cancelled.',
  },
  'message.received': {
    title: 'New Message',
    body: 'You have a new message.',
  },
  'community.reply': {
    title: 'New Reply',
    body: 'Someone replied to your post.',
  },
  'ai.crisis': {
    title: 'Crisis Support',
    body: 'A counsellor has been notified and will reach out shortly.',
  },
  'therapist_application.submitted': {
    title: 'Application Received',
    body: 'Your therapist application has been received and is under review.',
  },
  'therapist_application.approved': {
    title: 'Application Approved',
    body: 'Your therapist application has been approved.',
  },
  'therapist_application.rejected': {
    title: 'Application Update',
    body: 'There is an update on your therapist application.',
  },
  'therapist_application.more_info_requested': {
    title: 'More Information Needed',
    body: 'Your therapist application needs more information.',
  },
  'therapist_application.suspended': {
    title: 'Account Suspended',
    body: 'Your therapist account has been suspended.',
  },
  'therapist_application.reactivated': {
    title: 'Account Reactivated',
    body: 'Your therapist account has been reactivated.',
  },
};

function humanizeEventType(eventType: string): string {
  return eventType
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function displayTextFor(eventType: string): { title: string; body: string } {
  return (
    EVENT_DISPLAY_TEXT[eventType] ?? {
      title: humanizeEventType(eventType),
      body: '',
    }
  );
}

/**
 * @swagger
 * /api/v1/notifications:
 *   get:
 *     summary: List the caller's own in-app notifications
 *     description: >
 *       Authenticated user's own notification history, newest first, with
 *       display-ready title/body text and an unread count for a bell-icon
 *       badge. Backed by the same notification_logs table the admin-only
 *       delivery log (GET /api/v1/notifications/logs) reads — this is a
 *       filtered, display-mapped view of it, not a second notifications
 *       system.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *     responses:
 *       200:
 *         description: Paginated notifications
 *       401:
 *         description: Unauthorized
 */
notificationsRouter.get(
  '/api/v1/notifications',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const userId = authReq.user.userId;
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 20), 50);

    const where: Prisma.notification_logsWhereInput = { userId };

    const [rows, total, unreadCount] = await Promise.all([
      prisma.notification_logs.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification_logs.count({ where }),
      prisma.notification_logs.count({ where: { userId, readAt: null } }),
    ]);

    const notifications = rows.map((row) => {
      const { title, body } = displayTextFor(row.eventType);
      return {
        id: row.id,
        eventType: row.eventType,
        title,
        body,
        channel: row.channel,
        status: row.status,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      };
    });

    res.status(200).json({ notifications, total, page, limit, unreadCount });
  })
);

/**
 * @swagger
 * /api/v1/notifications/read-all:
 *   put:
 *     summary: Mark every one of the caller's unread notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Count of notifications updated
 *       401:
 *         description: Unauthorized
 */
notificationsRouter.put(
  '/api/v1/notifications/read-all',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const result = await prisma.notification_logs.updateMany({
      where: { userId: authReq.user.userId, readAt: null },
      data: { readAt: new Date() },
    });

    res.status(200).json({ updated: result.count });
  })
);

/**
 * @swagger
 * /api/v1/notifications/{id}/read:
 *   put:
 *     summary: Mark one notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated notification
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found, or not owned by the caller
 */
notificationsRouter.put(
  '/api/v1/notifications/:id/read',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const id = req.params.id as string;
    const existing = await prisma.notification_logs.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== authReq.user.userId) {
      res.status(404).json({ message: 'Notification not found' });
      return;
    }

    const updated = await prisma.notification_logs.update({
      where: { id },
      // Idempotent — re-marking an already-read notification keeps its
      // original readAt rather than bumping it forward.
      data: { readAt: existing.readAt ?? new Date() },
    });

    res
      .status(200)
      .json({ id: updated.id, readAt: updated.readAt!.toISOString() });
  })
);

/**
 * @swagger
 * /api/v1/notifications/logs:
 *   get:
 *     summary: List notification delivery logs
 *     description: >
 *       Admin only. Paginated, filterable by userId/status/channel/eventType.
 *       Each log's UTC createdAt/deliveredAt are returned alongside
 *       createdAtKigali/deliveredAtKigali — the same instants converted to
 *       Africa/Kigali (UTC+2, no DST) with the +02:00 offset baked into the string.
 *     tags: [Logs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [delivered, accepted, processing, failed, skipped] }
 *       - in: query
 *         name: channel
 *         schema: { type: string, enum: [push, email, sms, voice] }
 *       - in: query
 *         name: eventType
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated notification logs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 logs:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NotificationLog'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden — admin only
 */
notificationsRouter.get(
  '/api/v1/notifications/logs',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'ADMIN') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 20), 100);

    const { userId, status, channel, eventType } = req.query as Record<
      string,
      string | undefined
    >;

    const where: Prisma.notification_logsWhereInput = {
      ...(userId ? { userId } : {}),
      ...(status ? { status } : {}),
      ...(channel ? { channel } : {}),
      ...(eventType ? { eventType } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.notification_logs.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification_logs.count({ where }),
    ]);

    // createdAt/deliveredAt stay as-is (UTC) for anyone relying on the raw
    // stored value; createdAtKigali/deliveredAtKigali are added for display,
    // explicitly named and carrying the '+02:00' offset so there's no
    // ambiguity about which timezone they're in.
    const logs = rows.map((row) => ({
      ...row,
      createdAtKigali: toKigaliIso(row.createdAt),
      deliveredAtKigali: toKigaliIso(row.deliveredAt),
    }));

    res.status(200).json({ logs, total, page, limit });
  })
);
