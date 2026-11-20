import { z } from 'zod';

/** Restricted notification events emitted by Auth Service. Do not log payloads:
 * password reset URLs are bearer secrets and account details are sensitive. */
export interface AuthNotificationEvent {
  eventId: string;
  occurredAt: string;
  eventType: 'password.reset' | 'account.locked';
  recipientEmail: string;
  resetUrl?: string;
  expiresInMinutes?: number;
  lockedUntil?: string;
}

export const authNotificationEventSchema = z.discriminatedUnion('eventType', [
  z.object({
    eventId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    eventType: z.literal('password.reset'),
    recipientEmail: z.string().email(),
    resetUrl: z.string().url(),
    expiresInMinutes: z.number().int().positive().max(60),
  }),
  z.object({
    eventId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    eventType: z.literal('account.locked'),
    recipientEmail: z.string().email(),
    lockedUntil: z.string().datetime(),
  }),
]);
