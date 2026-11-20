import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendVoiceCall, setVoiceClientForTests } from '../voice.js';

describe("Africa's Talking Voice service", () => {
  const call = vi.fn();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AT_VOICE_ENABLED = 'true';
    process.env.AT_VOICE_NUMBER = '+250700000000';
    setVoiceClientForTests({ call });
  });

  afterEach(() => {
    setVoiceClientForTests(null);
    process.env = { ...originalEnv };
  });

  it('submits an outbound call from the issued Voice number', async () => {
    call.mockResolvedValueOnce({
      entries: [{ status: 'Queued', sessionId: 'ATV-test' }],
    });

    const result = await sendVoiceCall('+250700000001', 'event-123');

    expect(result.accepted).toBe(true);
    expect(call).toHaveBeenCalledWith({
      callFrom: '+250700000000',
      callTo: '+250700000001',
      clientRequestId: expect.stringMatching(
        /^mindora-event-123-[0-9a-f]{10}$/
      ),
    });
  });

  it('rejects recipients that are not valid E.164 numbers', async () => {
    await expect(sendVoiceCall('0783000000', 'event-123')).rejects.toThrow(
      'E.164'
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('does not submit a call when Voice is disabled', async () => {
    process.env.AT_VOICE_ENABLED = 'false';
    const result = await sendVoiceCall('+250700000001', 'event-123');
    expect(result.accepted).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('surfaces provider API errors', async () => {
    call.mockResolvedValueOnce({ errorMessage: 'Invalid caller ID' });
    await expect(sendVoiceCall('+250700000001', 'event-123')).rejects.toThrow(
      'Invalid caller ID'
    );
  });
});
