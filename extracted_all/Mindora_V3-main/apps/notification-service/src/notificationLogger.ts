import { createHash } from 'node:crypto';
import { PrismaClient } from './generated/prisma/index.js';

export const prisma = new PrismaClient();

export type NotificationChannel = 'push' | 'email' | 'sms' | 'voice';
export type NotificationStatus =
  'delivered' | 'failed' | 'skipped' | 'processing' | 'accepted';

function hashDedupeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface LogEntry {
  userId: string;
  eventType: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  attempts?: number;
  failureReason?: string;
  dedupeKey?: string;
}

export async function logNotification(entry: LogEntry): Promise<void> {
  try {
    await prisma.notification_logs.create({
      data: {
        userId: entry.userId,
        eventType: entry.eventType,
        channel: entry.channel,
        status: entry.status,
        attempts: entry.attempts ?? 1,
        deliveredAt: entry.status === 'delivered' ? new Date() : null,
        failureReason: entry.failureReason ?? null,
        ...(entry.dedupeKey ? { dedupeKey: entry.dedupeKey } : {}),
      },
    });
  } catch (err) {
    // Logging must never crash the notification flow.
    console.error('[notification-log] Failed to write log entry:', err);
  }
}

/**
 * Atomically claims a durable delivery slot before calling an external provider.
 * Previously accepted/delivered events are not sent again when RabbitMQ retries
 * because another channel failed. A stale processing claim can be reclaimed
 * after five minutes if the worker died before recording the result.
 */
export async function claimNotificationAttempt(entry: {
  dedupeKey: string;
  userId: string;
  eventType: string;
  channel: NotificationChannel;
}): Promise<boolean> {
  const storedDedupeKey = hashDedupeKey(entry.dedupeKey);
  try {
    await prisma.notification_logs.create({
      data: {
        userId: entry.userId,
        eventType: entry.eventType,
        channel: entry.channel,
        status: 'processing',
        attempts: 1,
        dedupeKey: storedDedupeKey,
      },
    });
    return true;
  } catch (error) {
    const isUniqueConflict =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002';
    if (!isUniqueConflict) {
      // Fail open: an idempotency-database outage must never suppress a crisis alert.
      console.error(
        '[notification-log] Could not claim idempotency key; attempting delivery without durable dedupe:',
        error
      );
      return true;
    }
  }

  try {
    const existing = await prisma.notification_logs.findUnique({
      where: { dedupeKey: storedDedupeKey },
    });
    if (!existing) return true;
    if (existing.status === 'delivered' || existing.status === 'accepted')
      return false;

    const stale = Date.now() - existing.createdAt.getTime() > 5 * 60 * 1000;
    if (existing.status === 'processing' && !stale) return false;
    if (
      existing.status !== 'failed' &&
      existing.status !== 'skipped' &&
      existing.status !== 'processing'
    )
      return false;

    const reclaimed = await prisma.notification_logs.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        createdAt: existing.createdAt,
      },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        failureReason: null,
        deliveredAt: null,
        createdAt: new Date(),
      },
    });
    return reclaimed.count === 1;
  } catch (error) {
    console.error(
      '[notification-log] Could not inspect idempotency key; attempting delivery:',
      error
    );
    return true;
  }
}

export async function finishNotificationAttempt(
  dedupeKey: string,
  status: Exclude<NotificationStatus, 'processing'>,
  failureReason?: string
): Promise<void> {
  const storedDedupeKey = hashDedupeKey(dedupeKey);
  try {
    // A provider callback can arrive before the outbound call request finishes.
    // Permit a final callback to replace `accepted`, but never let a late
    // initiation response overwrite a terminal `delivered`/`failed` callback.
    await prisma.notification_logs.updateMany({
      where: {
        dedupeKey: storedDedupeKey,
        status: { in: ['processing', 'accepted'] },
      },
      data: {
        status,
        deliveredAt: status === 'delivered' ? new Date() : null,
        failureReason: failureReason ?? null,
      },
    });
  } catch (err) {
    console.error(
      '[notification-log] Failed to finalize delivery attempt:',
      err
    );
  }
}
