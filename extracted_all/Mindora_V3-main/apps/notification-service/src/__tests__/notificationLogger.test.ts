import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('../generated/prisma/index.js', () => ({
  PrismaClient: vi.fn(function () {
    return { notification_logs: { create: mocks.create } };
  }),
}));

import { logNotification } from '../notificationLogger.js';

describe('logNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(undefined);
  });

  it('persists a delivered notification with delivery time and default attempts', async () => {
    await logNotification({
      userId: 'user-1',
      eventType: 'appointment.booked',
      channel: 'email',
      status: 'delivered',
    });

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        eventType: 'appointment.booked',
        channel: 'email',
        status: 'delivered',
        attempts: 1,
        deliveredAt: expect.any(Date),
        failureReason: null,
      }),
    });
  });

  it('persists a failed notification with its reason and explicit attempts', async () => {
    await logNotification({
      userId: 'user-2',
      eventType: 'appointment.confirmed',
      channel: 'push',
      status: 'failed',
      attempts: 3,
      failureReason: 'Provider unavailable',
    });

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-2',
        status: 'failed',
        attempts: 3,
        deliveredAt: null,
        failureReason: 'Provider unavailable',
      }),
    });
  });

  it('does not let database logging errors interrupt notification delivery', async () => {
    const error = new Error('database unavailable');
    mocks.create.mockRejectedValue(error);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logNotification({
        userId: 'user-3',
        eventType: 'appointment.booked',
        channel: 'push',
        status: 'skipped',
        failureReason: 'No FCM token on file',
      })
    ).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      '[notification-log] Failed to write log entry:',
      error
    );
    logError.mockRestore();
  });
});
