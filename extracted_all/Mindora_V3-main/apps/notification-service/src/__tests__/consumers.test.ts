import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EXCHANGES } from '@mindora/events';

const mocks = vi.hoisted(() => ({
  sendPushNotification: vi.fn(),
  subscribeWithRetry: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue(true),
  sendEmailToUser: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
  sendVoiceCall: vi.fn().mockResolvedValue({ accepted: true }),
  claimNotificationAttempt: vi.fn().mockResolvedValue(true),
  finishNotificationAttempt: vi.fn().mockResolvedValue(undefined),
  logNotification: vi.fn().mockResolvedValue(undefined),
  getUserName: vi.fn().mockResolvedValue('Test User'),
  getUserPreferences: vi.fn().mockResolvedValue({
    fcmToken: null,
    email: 'patient@example.com',
    phoneNumber: null,
    notificationPreferences: { push: true, email: true, sms: false },
  }),
}));

vi.mock('../fcm.js', () => ({
  sendPushNotification: mocks.sendPushNotification,
}));

vi.mock('../retry.js', () => ({
  subscribeWithRetry: mocks.subscribeWithRetry,
}));

vi.mock('../email.js', () => ({
  sendEmail: mocks.sendEmail,
  sendEmailToUser: mocks.sendEmailToUser,
  getUserName: mocks.getUserName,
}));

vi.mock('../sms.js', () => ({ sendSms: mocks.sendSms }));
vi.mock('../voice.js', () => ({ sendVoiceCall: mocks.sendVoiceCall }));
vi.mock('../notificationLogger.js', () => ({
  claimNotificationAttempt: mocks.claimNotificationAttempt,
  finishNotificationAttempt: mocks.finishNotificationAttempt,
  logNotification: mocks.logNotification,
}));

vi.mock('../preferences.js', () => ({
  getUserPreferences: mocks.getUserPreferences,
  isChannelEnabled: (
    prefs: { push: boolean; email: boolean; sms: boolean },
    channel: 'push' | 'email' | 'sms'
  ) => prefs[channel],
}));

import { startConsumers, SUBSCRIBED_EXCHANGES } from '../consumers.js';

type Handler = (payload: unknown) => Promise<void>;

function capturedHandler(exchange: string): Handler {
  const call = mocks.subscribeWithRetry.mock.calls.find(
    ([ex]) => ex === exchange
  );
  if (!call) throw new Error(`No handler captured for exchange: ${exchange}`);
  return call[2] as Handler;
}

describe('startConsumers — registration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.subscribeWithRetry.mockResolvedValue(undefined);
    await startConsumers();
  });

  it('subscribes to all 7 required exchanges including auth notifications', () => {
    expect(mocks.subscribeWithRetry).toHaveBeenCalledTimes(7);
  });

  it('SUBSCRIBED_EXCHANGES contains all exchange names', () => {
    for (const exchange of Object.values(EXCHANGES)) {
      expect(SUBSCRIBED_EXCHANGES).toContain(exchange);
    }
  });

  it('registers each exchange with a dedicated queue name', () => {
    const registeredExchanges = mocks.subscribeWithRetry.mock.calls.map(
      ([ex]) => ex as string
    );
    expect(registeredExchanges).toContain(EXCHANGES.APPOINTMENTS);
    expect(registeredExchanges).toContain(EXCHANGES.MESSAGES);
    expect(registeredExchanges).toContain(EXCHANGES.COMMUNITY);
    expect(registeredExchanges).toContain(EXCHANGES.MOOD);
    expect(registeredExchanges).toContain(EXCHANGES.AI);
    expect(registeredExchanges).toContain(EXCHANGES.AUTH);
    expect(registeredExchanges).toContain(EXCHANGES.THERAPIST_APPLICATIONS);
  });
});

describe('appointment handler', () => {
  beforeEach(async () => {
    process.env.MINDORA_BOOKING_ALERT_EMAILS = 'ops@example.com';
    process.env.MINDORA_BOOKING_ALERT_PHONES = '';
    process.env.SMS_ENABLED = 'false';
    process.env.AT_VOICE_ENABLED = 'false';
    process.env.MINDORA_CRISIS_ALERT_VOICE_PHONES = '';
    process.env.AT_API_KEY = '';
    process.env.AT_USERNAME = '';
    vi.clearAllMocks();
    mocks.sendEmail.mockReset().mockResolvedValue(true);
    mocks.sendSms.mockReset().mockResolvedValue(undefined);
    mocks.sendVoiceCall.mockReset().mockResolvedValue({ accepted: true });
    mocks.claimNotificationAttempt.mockReset().mockResolvedValue(true);
    mocks.finishNotificationAttempt.mockReset().mockResolvedValue(undefined);
    mocks.logNotification.mockReset().mockResolvedValue(undefined);
    mocks.subscribeWithRetry.mockResolvedValue(undefined);
    await startConsumers();
  });

  it('notifies patient for a VIDEO appointment booked', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: '432706a2-d868-412e-837a-62044072e586',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.booked',
      status: 'PENDING',
      appointmentId: 'f406523f-a0fd-42e1-a488-9d97f903c679',
      patientId: '5c4a96c6-f388-4adc-b188-90337ac37120',
      therapistId: '3fc4d56e-7567-46df-9915-cceec7b4cd14',
      slotStart: '2024-02-01T10:00:00Z',
      slotEnd: '2024-02-01T11:00:00Z',
      sessionType: 'VIDEO',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      '5c4a96c6-f388-4adc-b188-90337ac37120',
      'Appointment Booked',
      'Video appointment scheduled.',
      null,
      'appointment.booked'
    );
  });

  it('notifies patient for an IN_PERSON appointment booked', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: 'c53e8830-e8b5-42e7-b9b2-11b7e341c521',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.booked',
      status: 'PENDING',
      appointmentId: '2be3762d-b5f3-416f-b997-0ac12148a72e',
      patientId: '029ff388-2f20-486e-aeda-e54916f4f4cd',
      therapistId: '80a54a15-5ea8-4856-96b6-bfce49f7d668',
      slotStart: '2024-02-02T10:00:00Z',
      slotEnd: '2024-02-02T11:00:00Z',
      sessionType: 'IN_PERSON',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      '029ff388-2f20-486e-aeda-e54916f4f4cd',
      'Appointment Booked',
      'In-person appointment scheduled.',
      null,
      'appointment.booked'
    );
  });

  it('notifies patient for a CHAT appointment booked', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: '0e7552ba-f172-49c0-8111-a10e63bbb720',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.booked',
      status: 'PENDING',
      appointmentId: '29732a25-63c2-48e2-a5c0-0426d3cd1ff0',
      patientId: '69fce016-7e17-4f42-91a4-45878f42b4f8',
      therapistId: 'cef162d9-cd61-4c1b-a200-bdd8d7450446',
      slotStart: '2024-02-03T10:00:00Z',
      slotEnd: '2024-02-03T11:00:00Z',
      sessionType: 'CHAT',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      '69fce016-7e17-4f42-91a4-45878f42b4f8',
      'Appointment Booked',
      'Chat appointment scheduled.',
      null,
      'appointment.booked'
    );
  });

  it('notifies patient when appointment is confirmed', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: 'cdd5d594-29fa-42d2-a8f8-5ea618ba6ed3',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.confirmed',
      status: 'CONFIRMED',
      appointmentId: 'a2e718fe-cbc4-4291-83cf-7b761c9d26b7',
      patientId: '817ed757-ad2c-4443-9dcc-1e59e6197a6d',
      therapistId: 'f9d57f97-07d2-4780-b968-40c32a50dd7f',
      slotStart: '2024-01-05T09:00:00Z',
      slotEnd: '2024-01-05T10:00:00Z',
      sessionType: 'VIDEO',
      confirmedByUserId: 'f9d57f97-07d2-4780-b968-40c32a50dd7f',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      '817ed757-ad2c-4443-9dcc-1e59e6197a6d',
      'Appointment Confirmed',
      'Your appointment has been confirmed.',
      null,
      'appointment.confirmed'
    );
  });

  it('notifies patient when therapist cancels and includes reason', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: '8a5ba852-8026-422c-afb7-27873d26cba6',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.cancelled',
      status: 'CANCELLED',
      appointmentId: '5a626336-fc57-49c6-bf99-dc66ffe07cd6',
      patientId: 'ecebb125-573e-4c73-b999-3406fa67caab',
      therapistId: 'ce087245-57c3-4ceb-83fe-93c487901056',
      slotStart: '2024-02-05T10:00:00Z',
      slotEnd: '2024-02-05T11:00:00Z',
      sessionType: 'VIDEO',
      cancelledByUserId: 'ce087245-57c3-4ceb-83fe-93c487901056',
      cancellationReason: 'Family emergency',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      'ecebb125-573e-4c73-b999-3406fa67caab',
      'Appointment Cancelled',
      'Reason: Family emergency',
      null,
      'appointment.cancelled'
    );
  });

  it('notifies therapist when patient cancels', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: 'f1796f19-9865-4d2c-a24b-934583cfa6d8',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.cancelled',
      status: 'CANCELLED',
      appointmentId: '0d8173b2-21c3-433f-8f4a-64071ea8940c',
      patientId: '10fca248-51b0-4697-a507-d23f7afea3e5',
      therapistId: '6e90b8ff-791f-430a-9b9f-6820feea8f16',
      slotStart: '2024-02-06T10:00:00Z',
      slotEnd: '2024-02-06T11:00:00Z',
      sessionType: 'VIDEO',
      cancelledByUserId: '10fca248-51b0-4697-a507-d23f7afea3e5',
      cancellationReason: 'Schedule conflict',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      '6e90b8ff-791f-430a-9b9f-6820feea8f16',
      'Appointment Cancelled',
      'Reason: Schedule conflict',
      null,
      'appointment.cancelled'
    );
  });

  it('uses default body text when cancellation has no reason', async () => {
    await capturedHandler(EXCHANGES.APPOINTMENTS)({
      eventId: '9aab14f6-be9c-4ef4-81f5-498639defd08',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'appointment.cancelled',
      status: 'CANCELLED',
      appointmentId: '8c20741d-07d5-4d61-a74a-11da504780d5',
      patientId: '51bd60e8-10ee-4705-b762-9d1719dd1144',
      therapistId: '6d416f04-9211-4e8b-96a1-03da34840917',
      slotStart: '2024-02-07T10:00:00Z',
      slotEnd: '2024-02-07T11:00:00Z',
      sessionType: 'VIDEO',
      cancelledByUserId: '6d416f04-9211-4e8b-96a1-03da34840917',
      cancellationReason: '',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      '51bd60e8-10ee-4705-b762-9d1719dd1144',
      'Appointment Cancelled',
      'Your appointment has been cancelled.',
      null,
      'appointment.cancelled'
    );
  });
});

describe('message handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.subscribeWithRetry.mockResolvedValue(undefined);
    await startConsumers();
  });

  it('sends full content as preview when under 80 characters', async () => {
    const shortContent = 'Hey, how are you doing today?';
    await capturedHandler(EXCHANGES.MESSAGES)({
      eventId: '3644de84-4d3c-4d61-bea6-ba9a0926f507',
      occurredAt: '2024-01-01T00:00:00Z',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'sender-1',
      recipientId: 'recipient-1',
      content: shortContent,
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      'recipient-1',
      'New Message',
      shortContent,
      null,
      'message.received'
    );
  });

  it('sends content exactly 80 characters without truncation', async () => {
    const exactContent = 'B'.repeat(80);
    await capturedHandler(EXCHANGES.MESSAGES)({
      eventId: '44b847c2-2047-47fc-8240-9d6c96f55b50',
      occurredAt: '2024-01-01T00:00:00Z',
      messageId: 'msg-2',
      conversationId: 'conv-2',
      senderId: 'sender-2',
      recipientId: 'recipient-2',
      content: exactContent,
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      'recipient-2',
      'New Message',
      exactContent,
      null,
      'message.received'
    );
  });

  it('truncates content over 80 characters to 77 chars + ellipsis', async () => {
    const longContent = 'A'.repeat(90);
    await capturedHandler(EXCHANGES.MESSAGES)({
      eventId: 'c86f8cf3-be1e-4dd1-a67f-bfd80a583b55',
      occurredAt: '2024-01-01T00:00:00Z',
      messageId: 'msg-3',
      conversationId: 'conv-3',
      senderId: 'sender-3',
      recipientId: 'recipient-3',
      content: longContent,
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      'recipient-3',
      'New Message',
      `${'A'.repeat(77)}…`,
      null,
      'message.received'
    );
  });

  it('notifies the recipient, not the sender', async () => {
    await capturedHandler(EXCHANGES.MESSAGES)({
      eventId: '5da3e5c0-14dc-467b-bf7b-8bbc460d9858',
      occurredAt: '2024-01-01T00:00:00Z',
      messageId: 'msg-4',
      conversationId: 'conv-4',
      senderId: 'alice',
      recipientId: 'bob',
      content: 'Hello Bob!',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      'bob',
      'New Message',
      'Hello Bob!',
      null,
      'message.received'
    );
    expect(mocks.sendPushNotification).not.toHaveBeenCalledWith(
      'alice',
      expect.anything(),
      expect.anything()
    );
  });
});

describe('community handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.subscribeWithRetry.mockResolvedValue(undefined);
    await startConsumers();
  });

  it('notifies the post author when a reply is posted', async () => {
    await capturedHandler(EXCHANGES.COMMUNITY)({
      eventId: '017fde59-ffe6-46d6-9f78-450216956020',
      occurredAt: '2024-01-01T00:00:00Z',
      replyId: 'reply-1',
      postId: 'post-1',
      postAuthorId: 'post-author-1',
      replyAuthorId: 'commenter-1',
      excerpt: 'Great insight, I totally agree!',
    });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(
      'post-author-1',
      'New Reply',
      'Great insight, I totally agree!',
      null,
      'community.reply'
    );
  });

  it('does not send push for community report events (no replyId)', async () => {
    await capturedHandler(EXCHANGES.COMMUNITY)({
      eventId: 'baf06faa-9a53-4587-becc-9a34d063d737',
      occurredAt: '2024-01-01T00:00:00Z',
      reportId: 'report-1',
      contentId: 'post-1',
      contentType: 'POST',
      reportedBy: 'user-1',
      reason: 'Spam',
      status: 'PENDING',
    });
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
  });
});

describe('mood and AI handlers', () => {
  beforeEach(async () => {
    process.env.MINDORA_CRISIS_ALERT_EMAILS = 'crisis@example.com';
    process.env.MINDORA_CRISIS_ALERT_PHONES = '';
    process.env.MINDORA_CRISIS_ALERT_VOICE_PHONES = '';
    process.env.SMS_ENABLED = 'false';
    process.env.AT_VOICE_ENABLED = 'false';
    process.env.AT_API_KEY = '';
    process.env.AT_USERNAME = '';
    vi.clearAllMocks();
    mocks.sendEmail.mockReset().mockResolvedValue(true);
    mocks.sendSms.mockReset().mockResolvedValue(undefined);
    mocks.sendVoiceCall.mockReset().mockResolvedValue({ accepted: true });
    mocks.claimNotificationAttempt.mockReset().mockResolvedValue(true);
    mocks.finishNotificationAttempt.mockReset().mockResolvedValue(undefined);
    mocks.logNotification.mockReset().mockResolvedValue(undefined);
    mocks.subscribeWithRetry.mockResolvedValue(undefined);
    await startConsumers();
  });

  it('does not send push for mood events — log only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await capturedHandler(EXCHANGES.MOOD)({
      eventId: 'aa82e5f2-33d6-412c-95fc-c91b01288646',
      occurredAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
      eventType: 'mood.concern',
      userId: 'ee556d7f-77fc-4f8f-acff-0da09f6a376d',
      avgMoodScore: 2.4,
      recentScores: [2, 3, 2, 2, 3],
    });
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
  });

  it('sends the operations email for a valid AI crisis event without sending user push', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await capturedHandler(EXCHANGES.AI)({
      eventId: '714ccdf3-af66-48be-b051-1eedfc17d1a6',
      occurredAt: '2024-01-01T00:00:00Z',
      userId: 'afdaad18-1241-47c8-a633-f912fa3f9d03',
      sessionId: null,
      crisisLevel: 3,
      timestamp: '2024-01-01T00:00:00Z',
      messageExcerpt: 'I am thinking about suicide',
      conversationExcerpt: 'User: I feel unsafe\nMINDORA: I am here with you',
      interactionId: 'b4a9da11-4ce5-44e1-a8bc-f2f2e26c56c3',
    });
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      'crisis@example.com',
      expect.stringContaining('URGENT'),
      expect.stringContaining('I am thinking about suicide')
    );
  });

  it('attempts SMS and Voice even when crisis email fails', async () => {
    process.env.MINDORA_CRISIS_ALERT_EMAILS = 'crisis@example.com';
    process.env.MINDORA_CRISIS_ALERT_PHONES = '+250700000001';
    process.env.MINDORA_CRISIS_ALERT_VOICE_PHONES = '+250700000002';
    process.env.SMS_ENABLED = 'true';
    process.env.AT_API_KEY = 'test-key';
    process.env.AT_USERNAME = 'sandbox';
    process.env.AT_VOICE_ENABLED = 'true';
    mocks.sendEmail.mockRejectedValueOnce(new Error('Resend unavailable'));
    mocks.sendSms.mockResolvedValueOnce(undefined);
    mocks.sendVoiceCall.mockResolvedValueOnce({ accepted: true });

    await expect(
      capturedHandler(EXCHANGES.AI)({
        eventId: '714ccdf3-af66-48be-b051-1eedfc17d1a6',
        occurredAt: '2026-11-01T00:00:00Z',
        userId: 'afdaad18-1241-47c8-a633-f912fa3f9d03',
        sessionId: null,
        crisisLevel: 4,
        timestamp: '2026-11-01T00:00:00Z',
        messageExcerpt: 'I have already hurt myself',
        conversationExcerpt: 'User disclosed recent self-harm',
        interactionId: 'b4a9da11-4ce5-44e1-a8bc-f2f2e26c56c3',
      })
    ).rejects.toThrow('One or more crisis notification channels failed');

    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.sendVoiceCall).toHaveBeenCalledTimes(1);
  });

  it('attempts email when crisis SMS fails', async () => {
    process.env.MINDORA_CRISIS_ALERT_EMAILS = 'crisis@example.com';
    process.env.MINDORA_CRISIS_ALERT_PHONES = '+250700000001';
    process.env.SMS_ENABLED = 'true';
    process.env.AT_API_KEY = 'test-key';
    process.env.AT_USERNAME = 'sandbox';
    mocks.sendSms.mockRejectedValueOnce(
      new Error('Africa Talking unavailable')
    );

    await expect(
      capturedHandler(EXCHANGES.AI)({
        eventId: 'c53e8830-e8b5-42e7-b9b2-11b7e341c521',
        occurredAt: '2026-11-01T00:00:00Z',
        userId: '029ff388-2f20-486e-aeda-e54916f4f4cd',
        sessionId: null,
        crisisLevel: 3,
        timestamp: '2026-11-01T00:00:00Z',
        messageExcerpt: 'I am thinking about suicide',
        conversationExcerpt: 'User asked for urgent support',
        interactionId: '80a54a15-5ea8-4856-96b6-bfce49f7d668',
      })
    ).rejects.toThrow('One or more crisis notification channels failed');

    expect(mocks.sendEmail).toHaveBeenCalled();
  });

  it('attempts all crisis channels even when both email and SMS fail', async () => {
    process.env.MINDORA_CRISIS_ALERT_EMAILS = 'crisis@example.com';
    process.env.MINDORA_CRISIS_ALERT_PHONES = '+250700000001';
    process.env.MINDORA_CRISIS_ALERT_VOICE_PHONES = '+250700000002';
    process.env.SMS_ENABLED = 'true';
    process.env.AT_API_KEY = 'test-key';
    process.env.AT_USERNAME = 'sandbox';
    process.env.AT_VOICE_ENABLED = 'true';
    mocks.sendEmail.mockRejectedValueOnce(new Error('Resend unavailable'));
    mocks.sendSms.mockRejectedValueOnce(new Error('SMS unavailable'));
    mocks.sendVoiceCall.mockResolvedValueOnce({ accepted: true });

    await expect(
      capturedHandler(EXCHANGES.AI)({
        eventId: '0e7552ba-f172-49c0-8111-a10e63bbb720',
        occurredAt: '2026-11-01T00:00:00Z',
        userId: '69fce016-7e17-4f42-91a4-45878f42b4f8',
        sessionId: null,
        crisisLevel: 5,
        timestamp: '2026-11-01T00:00:00Z',
        messageExcerpt: 'I may hurt myself tonight',
        conversationExcerpt: 'User indicated immediate danger',
        interactionId: 'cef162d9-cd61-4c1b-a200-bdd8d7450446',
      })
    ).rejects.toThrow('One or more crisis notification channels failed');

    expect(mocks.sendEmail).toHaveBeenCalled();
    expect(mocks.sendSms).toHaveBeenCalled();
    expect(mocks.sendVoiceCall).toHaveBeenCalled();
  });
});
