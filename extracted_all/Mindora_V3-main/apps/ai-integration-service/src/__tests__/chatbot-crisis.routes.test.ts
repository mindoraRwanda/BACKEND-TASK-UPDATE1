import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockChannel = {
  on: vi.fn(),
  assertExchange: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockReturnValue(true),
  waitForConfirms: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};
const mockConnection = {
  createConfirmChannel: vi.fn().mockResolvedValue(mockChannel),
};

vi.mock('@mindora/queue', () => ({
  connect: vi.fn(async () => mockConnection),
}));

import { connect } from '@mindora/queue';
import router from '../routes/chatbot-crisis.routes.js';

const app = express();
app.use(express.json());
app.use('/api/v1/ai', router);

const validPayload = {
  eventId: '2a035f59-54e3-45d0-8945-79e7030ff435',
  occurredAt: '2026-11-03T10:00:00.000Z',
  conversationId: 'python-chat-123',
  externalUserRef: 'legacy-user-7',
  crisisLevel: 5,
  messageExcerpt: 'I have already hurt myself',
};

describe('private Python chatbot crisis webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CHATBOT_CRISIS_WEBHOOK_TOKEN = 'test-only-shared-secret';
  });

  it('rejects requests without the service token', async () => {
    const response = await request(app)
      .post('/api/v1/ai/internal/chatbot-crisis-events')
      .send(validPayload);
    expect(response.status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects an oversized bearer header without parsing unbounded input', async () => {
    const response = await request(app)
      .post('/api/v1/ai/internal/chatbot-crisis-events')
      .set('Authorization', `Bearer ${' '.repeat(5000)}test-only-shared-secret`)
      .send(validPayload);
    expect(response.status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects an invalid crisis level', async () => {
    const response = await request(app)
      .post('/api/v1/ai/internal/chatbot-crisis-events')
      .set('Authorization', 'Bearer test-only-shared-secret')
      .send({ ...validPayload, crisisLevel: 2 });
    expect(response.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it('publishes a validated Python chatbot crisis event and waits for broker confirmation', async () => {
    const response = await request(app)
      .post('/api/v1/ai/internal/chatbot-crisis-events')
      .set('Authorization', 'Bearer test-only-shared-secret')
      .send(validPayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      accepted: true,
      eventId: validPayload.eventId,
    });
    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      'mindora.ai',
      'fanout',
      { durable: true }
    );
    expect(mockChannel.publish).toHaveBeenCalledOnce();
    expect(mockChannel.waitForConfirms).toHaveBeenCalledOnce();
    expect(mockChannel.close).toHaveBeenCalledOnce();
  });
});
