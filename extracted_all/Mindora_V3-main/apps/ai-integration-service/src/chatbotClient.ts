import { prisma } from './database.js';

// Client for the external Therapy Chatbot API (separate service, own
// conversation model — see docs at <THERAPY_CHATBOT_BASE_URL>/docs). Each
// Mindora patient gets one chatbot session + one long-lived conversation,
// tracked in the chatbot_accounts table; message history itself lives on the
// chatbot's side, not ours (this service's own AiInteraction rows are our
// audit copy).
//
// Auth model: the vendor exchanges our patient's id/email for a short-lived
// access token via POST /integration/session (server-to-server, proven by
// MINDORA_INTEGRATION_KEY — never sent to a browser). There is no per-patient
// password: calling /integration/session repeatedly is cheap, safe and
// idempotent, so a cached token is simply re-requested once it's stale.

export class ChatbotApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ChatbotApiError';
  }
}

interface ChatbotSession {
  accessToken: string;
  conversationId: string;
}

interface ChatbotMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
}

interface IntegrationSessionResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user_id: string;
}

function baseUrl(): string {
  const url = process.env.THERAPY_CHATBOT_BASE_URL;
  if (!url) {
    throw new Error(
      'Missing required environment variable: THERAPY_CHATBOT_BASE_URL'
    );
  }
  return url.replace(/\/+$/, '');
}

function integrationKey(): string {
  const key = process.env.MINDORA_INTEGRATION_KEY;
  if (!key) {
    throw new Error(
      'Missing required environment variable: MINDORA_INTEGRATION_KEY'
    );
  }
  return key;
}

async function chatbotFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ChatbotApiError(
      `Therapy chatbot request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    throw new ChatbotApiError(
      `Therapy chatbot returned ${response.status} for ${path}`,
      response.status
    );
  }
  return response;
}

// external_id is Mindora's own (stable, never-changing) user id — the
// chatbot keys all conversation/crisis history to it, so this must always be
// the same value for the same patient.
async function requestSession(
  externalId: string,
  email: string
): Promise<IntegrationSessionResponse> {
  const res = await chatbotFetch(
    '/integration/session',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': integrationKey(),
      },
      body: JSON.stringify({ external_id: externalId, email }),
    },
    15_000
  );
  return (await res.json()) as IntegrationSessionResponse;
}

async function createConversation(accessToken: string): Promise<string> {
  const res = await chatbotFetch(
    '/auth/conversations',
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
    15_000
  );
  const body = (await res.json()) as { id?: unknown };
  if (
    (typeof body.id !== 'number' && typeof body.id !== 'string') ||
    String(body.id).trim() === ''
  ) {
    throw new ChatbotApiError(
      'Therapy chatbot returned an invalid conversation id'
    );
  }
  return String(body.id);
}

async function provisionOrRefreshSession(
  mindoraUserId: string,
  email: string,
  existingConversationId: string | null
): Promise<{
  chatbotUserId: string;
  accessToken: string;
  tokenExpiresAt: Date;
  conversationId: string;
}> {
  const session = await requestSession(mindoraUserId, email);
  const conversationId =
    existingConversationId ?? (await createConversation(session.access_token));

  return {
    chatbotUserId: session.user_id,
    accessToken: session.access_token,
    tokenExpiresAt: new Date(Date.now() + session.expires_in * 1000),
    conversationId,
  };
}

// 60s buffer so a token doesn't expire mid-request.
const EXPIRY_BUFFER_MS = 60_000;

async function refreshAndPersistSession(
  mindoraUserId: string,
  email: string,
  existingConversationId: string | null
): Promise<ChatbotSession> {
  const refreshed = await provisionOrRefreshSession(
    mindoraUserId,
    email,
    existingConversationId
  );

  await prisma.chatbotAccount.upsert({
    where: { mindora_user_id: mindoraUserId },
    create: {
      mindora_user_id: mindoraUserId,
      chatbot_user_id: refreshed.chatbotUserId,
      chatbot_email: email,
      access_token: refreshed.accessToken,
      token_expires_at: refreshed.tokenExpiresAt,
      conversation_id: refreshed.conversationId,
    },
    update: {
      chatbot_user_id: refreshed.chatbotUserId,
      chatbot_email: email,
      access_token: refreshed.accessToken,
      token_expires_at: refreshed.tokenExpiresAt,
      conversation_id: refreshed.conversationId,
    },
  });

  return {
    accessToken: refreshed.accessToken,
    conversationId: refreshed.conversationId,
  };
}

async function getOrCreateSession(
  mindoraUserId: string,
  email: string
): Promise<ChatbotSession> {
  const existing = await prisma.chatbotAccount.findUnique({
    where: { mindora_user_id: mindoraUserId },
  });

  const tokenIsFresh =
    existing?.access_token &&
    existing.conversation_id &&
    existing.token_expires_at &&
    existing.token_expires_at.getTime() - EXPIRY_BUFFER_MS > Date.now();

  if (existing && tokenIsFresh) {
    return {
      accessToken: existing.access_token!,
      conversationId: existing.conversation_id!,
    };
  }

  return refreshAndPersistSession(
    mindoraUserId,
    email,
    existing?.conversation_id ?? null
  );
}

async function sendMessage(
  session: ChatbotSession,
  content: string
): Promise<ChatbotMessage> {
  const conversationId = Number(session.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    throw new ChatbotApiError('Therapy chatbot conversation id is invalid');
  }
  const res = await chatbotFetch(
    '/auth/messages',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        content,
      }),
    },
    // Observed latency for this LLM-backed pipeline is ~20-25s.
    45_000
  );
  const body = (await res.json()) as {
    id?: unknown;
    sender?: unknown;
    content?: unknown;
    timestamp?: unknown;
  };
  if (
    (typeof body.id !== 'number' && typeof body.id !== 'string') ||
    String(body.id).trim() === '' ||
    typeof body.sender !== 'string' ||
    typeof body.content !== 'string' ||
    typeof body.timestamp !== 'string'
  ) {
    throw new ChatbotApiError(
      'Therapy chatbot returned an invalid message payload'
    );
  }
  return {
    id: String(body.id),
    sender: body.sender,
    content: body.content,
    timestamp: body.timestamp,
  };
}

// Entry point used by DELETE /history. Best-effort: the vendor conversation
// (and its transcript) is the vendor's data, not ours, so a failure here
// must not block deleting our own AiInteraction audit rows — it only
// affects what the caller reports as `remoteConversationDeleted`. Clears
// conversation_id on success so the next chat starts a fresh conversation
// rather than reusing one the vendor no longer has.
export async function deleteRemoteConversation(
  mindoraUserId: string
): Promise<boolean> {
  const account = await prisma.chatbotAccount.findUnique({
    where: { mindora_user_id: mindoraUserId },
  });
  if (!account?.conversation_id || !account.access_token) {
    return true; // nothing remote exists to delete
  }

  try {
    await chatbotFetch(
      `/auth/conversations/${encodeURIComponent(account.conversation_id)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${account.access_token}` },
      },
      15_000
    );
  } catch (err) {
    console.error(
      `[chatbotClient] Failed to delete remote conversation for user ${mindoraUserId}:`,
      err
    );
    return false;
  }

  await prisma.chatbotAccount.update({
    where: { mindora_user_id: mindoraUserId },
    data: { conversation_id: null },
  });
  return true;
}

// Entry point used by the /chat route. Provisions/refreshes the patient's
// chatbot session as needed, then sends the message — retrying once with a
// forced session refresh if the cached token was rejected (clock skew,
// revoked session, etc.) rather than only trusting our own expiry bookkeeping.
export async function chatWithBot(
  mindoraUserId: string,
  email: string,
  content: string
): Promise<ChatbotMessage> {
  const session = await getOrCreateSession(mindoraUserId, email);
  try {
    return await sendMessage(session, content);
  } catch (err) {
    if (err instanceof ChatbotApiError && err.status === 401) {
      const account = await prisma.chatbotAccount.findUnique({
        where: { mindora_user_id: mindoraUserId },
      });
      const refreshed = await refreshAndPersistSession(
        mindoraUserId,
        email,
        account?.conversation_id ?? null
      );
      return sendMessage(refreshed, content);
    }
    throw err;
  }
}
