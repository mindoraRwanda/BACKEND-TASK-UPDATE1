import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.THERAPY_CHATBOT_BASE_URL = 'https://chatbot.example.test';
  process.env.MINDORA_INTEGRATION_KEY = 'test-integration-key';
});

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();

vi.mock('../database.js', () => ({
  prisma: {
    chatbotAccount: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

const { chatWithBot, ChatbotApiError } = await import('../chatbotClient.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('chatWithBot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFindUnique.mockReset();
    mockUpsert.mockReset();
  });

  it('exchanges the external id + email for a session via POST /integration/session, then sends the message', async () => {
    mockFindUnique.mockResolvedValueOnce(null); // no cached account yet
    mockUpsert.mockResolvedValueOnce({});

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe('https://chatbot.example.test/integration/session');
        expect(init?.method).toBe('POST');
        expect(
          (init?.headers as Record<string, string>)['X-Integration-Key']
        ).toBe('test-integration-key');
        expect(JSON.parse(init?.body as string)).toEqual({
          external_id: 'patient-1',
          email: 'patient@example.com',
        });
        return jsonResponse({
          access_token: 'session-token',
          token_type: 'bearer',
          expires_in: 1800,
          user_id: 'chatbot-user-1',
        });
      })
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe('https://chatbot.example.test/auth/conversations');
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer session-token'
        );
        return jsonResponse({ id: 1 });
      })
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe('https://chatbot.example.test/auth/messages');
        expect(JSON.parse(init?.body as string)).toEqual({
          conversation_id: 1,
          content: 'hello',
        });
        return jsonResponse({
          id: 2,
          sender: 'bot',
          content: 'hi there',
          timestamp: '2026-09-06T00:00:00.000Z',
        });
      });

    const result = await chatWithBot(
      'patient-1',
      'patient@example.com',
      'hello'
    );

    expect(result.content).toBe('hi there');
    expect(result.id).toBe('2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mindora_user_id: 'patient-1' },
        create: expect.objectContaining({
          chatbot_user_id: 'chatbot-user-1',
          chatbot_email: 'patient@example.com',
          access_token: 'session-token',
          conversation_id: '1',
        }),
      })
    );
  });

  it('reuses a cached, still-fresh token without calling /integration/session again', async () => {
    mockFindUnique.mockResolvedValueOnce({
      access_token: 'cached-token',
      conversation_id: '1',
      token_expires_at: new Date(Date.now() + 10 * 60 * 1000),
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe('https://chatbot.example.test/auth/messages');
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer cached-token'
        );
        return jsonResponse({
          id: 'msg-2',
          sender: 'bot',
          content: 'still here',
          timestamp: '2026-09-06T00:00:00.000Z',
        });
      });

    const result = await chatWithBot(
      'patient-1',
      'patient@example.com',
      'hi again'
    );

    expect(result.content).toBe('still here');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('re-requests a session when the cached token has expired', async () => {
    mockFindUnique.mockResolvedValueOnce({
      access_token: 'stale-token',
      conversation_id: '1',
      token_expires_at: new Date(Date.now() - 1000),
    });
    mockUpsert.mockResolvedValueOnce({});

    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (url) => {
        expect(url).toBe('https://chatbot.example.test/integration/session');
        return jsonResponse({
          access_token: 'fresh-token',
          token_type: 'bearer',
          expires_in: 1800,
          user_id: 'chatbot-user-1',
        });
      })
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe('https://chatbot.example.test/auth/messages');
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer fresh-token'
        );
        return jsonResponse({
          id: 'msg-3',
          sender: 'bot',
          content: 'renewed',
          timestamp: '2026-09-06T00:00:00.000Z',
        });
      });

    const result = await chatWithBot(
      'patient-1',
      'patient@example.com',
      'again'
    );

    expect(result.content).toBe('renewed');
    // Existing conversation id is reused rather than creating a new one.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ conversation_id: '1' }),
      })
    );
  });

  it('retries once with a forced session refresh when the bot rejects the cached token with 401', async () => {
    mockFindUnique
      .mockResolvedValueOnce({
        access_token: 'cached-token',
        conversation_id: 1,
        token_expires_at: new Date(Date.now() + 10 * 60 * 1000),
      })
      .mockResolvedValueOnce({
        conversation_id: '1',
      });
    mockUpsert.mockResolvedValueOnce({});

    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () =>
        jsonResponse({ message: 'expired' }, 401)
      )
      .mockImplementationOnce(async (url) => {
        expect(url).toBe('https://chatbot.example.test/integration/session');
        return jsonResponse({
          access_token: 'new-token',
          token_type: 'bearer',
          expires_in: 1800,
          user_id: 'chatbot-user-1',
        });
      })
      .mockImplementationOnce(async (url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer new-token'
        );
        return jsonResponse({
          id: 'msg-4',
          sender: 'bot',
          content: 'recovered',
          timestamp: '2026-09-06T00:00:00.000Z',
        });
      });

    const result = await chatWithBot(
      'patient-1',
      'patient@example.com',
      'retry me'
    );

    expect(result.content).toBe('recovered');
  });

  it('throws ChatbotApiError with the upstream status when /integration/session is rejected', async () => {
    mockFindUnique.mockResolvedValue(null);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ detail: 'Invalid integration key' }, 403)
    );

    const error = await chatWithBot(
      'patient-1',
      'patient@example.com',
      'hello'
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChatbotApiError);
    expect(error).toMatchObject({ name: 'ChatbotApiError', status: 403 });
  });
});
