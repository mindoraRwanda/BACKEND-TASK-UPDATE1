import { z } from 'zod';
import { baseEventSchema, type BaseEvent } from './base.js';

export interface AIUsageLoggedEvent extends BaseEvent {
  userId: string;
  /** Platform feature that triggered the AI call (e.g. "mood-summary", "chat-assist") */
  feature: string;
  /** Model identifier (e.g. "claude-sonnet-4-6") */
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export const aiUsageLoggedEventSchema = baseEventSchema.extend({
  userId: z.string().uuid(),
  feature: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  durationMs: z.number(),
});

/**
 * Published by ai-integration-service (routes/ai.routes.ts publishCrisisEvent)
 * directly onto the mindora.ai fanout exchange as a hand-rolled object, not
 * via a shared builder — this type/schema formalizes that existing wire
 * shape rather than changing what's published. `timestamp` duplicates
 * `occurredAt`; kept for backward compatibility with what's already on the
 * wire rather than dropped.
 */
export interface AICrisisEvent {
  eventId: string;
  occurredAt: string;
  userId: string;
  sessionId: string | null;
  crisisLevel: number;
  timestamp: string;
  messageExcerpt?: string;
  conversationExcerpt?: string;
  interactionId?: string;
  /** Origin of the safety event. Older web-app producers may omit this. */
  source?: 'web-chatbot' | 'python-chatbot';
  /** External user reference from a separate chatbot identity system. */
  externalUserRef?: string;
}

export const aiCrisisEventSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  userId: z.string().uuid(),
  sessionId: z.string().nullable(),
  crisisLevel: z.number(),
  timestamp: z.string().datetime(),
  messageExcerpt: z.string().max(1500).optional(),
  conversationExcerpt: z.string().max(5000).optional(),
  interactionId: z.string().uuid().optional(),
  source: z.enum(['web-chatbot', 'python-chatbot']).optional(),
  externalUserRef: z.string().max(120).optional(),
});
