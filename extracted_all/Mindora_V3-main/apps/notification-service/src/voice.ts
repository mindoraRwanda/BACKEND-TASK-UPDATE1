import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

interface VoiceCallResponse {
  entries?: Array<{
    status?: string;
    phoneNumber?: string;
    sessionId?: string;
  }>;
  errorMessage?: string;
}

interface VoiceClient {
  call(options: {
    callFrom: string;
    callTo: string;
    clientRequestId?: string;
  }): Promise<VoiceCallResponse>;
}

interface AfricaTalkingClient {
  VOICE: VoiceClient;
}

type AfricaTalkingFactory = (options: {
  apiKey: string;
  username: string;
}) => AfricaTalkingClient;

// The same official Africa's Talking Node SDK is already used by sms.ts.
// The Voice API accepts an AT-issued virtual number as callFrom and an
// international-format recipient number as callTo.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const makeAfricasTalking = require('africastalking') as AfricaTalkingFactory;

let voiceClient: VoiceClient | null = null;

export function initVoice(): void {
  if (process.env.AT_VOICE_ENABLED !== 'true') {
    console.warn(
      '[voice] AT_VOICE_ENABLED is not true — Voice notifications disabled'
    );
    return;
  }

  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const voiceNumber = process.env.AT_VOICE_NUMBER;
  if (!apiKey || !username || !voiceNumber) {
    console.warn(
      '[voice] Voice enabled but AT_API_KEY, AT_USERNAME or AT_VOICE_NUMBER is missing'
    );
    return;
  }

  voiceClient = makeAfricasTalking({ apiKey, username }).VOICE;
  console.log("✓ Africa's Talking Voice client initialized");
}

export interface VoiceCallResult {
  accepted: boolean;
  response?: VoiceCallResponse;
}

/** Initiates one outbound call to an authorized MINDORA staff recipient. */
export async function sendVoiceCall(
  recipient: string,
  eventId: string
): Promise<VoiceCallResult> {
  if (process.env.AT_VOICE_ENABLED !== 'true') {
    return { accepted: false };
  }
  if (!voiceClient) {
    throw new Error("Africa's Talking Voice client is not initialized");
  }

  const callFrom = process.env.AT_VOICE_NUMBER?.trim();
  if (!callFrom || !/^\+[1-9]\d{7,14}$/.test(callFrom)) {
    throw new Error(
      "AT_VOICE_NUMBER must be an Africa's Talking-issued E.164 number"
    );
  }
  if (!/^\+[1-9]\d{7,14}$/.test(recipient)) {
    throw new Error('Voice recipient must be an E.164 phone number');
  }

  // Each staff recipient gets a unique provider request ID while the callback
  // still contains the original event UUID. The recipient hash avoids placing
  // the staff phone number in a provider request identifier.
  const recipientTag = createHash('sha256')
    .update(recipient)
    .digest('hex')
    .slice(0, 10);
  const response = await voiceClient.call({
    callFrom,
    callTo: recipient,
    clientRequestId: `mindora-${eventId}-${recipientTag}`.slice(0, 64),
  });

  if (response?.errorMessage) {
    throw new Error(
      `Africa's Talking Voice request failed: ${response.errorMessage}`
    );
  }
  const providerStatus = response?.entries?.[0]?.status?.toLowerCase() ?? '';
  if (
    providerStatus.includes('fail') ||
    providerStatus.includes('reject') ||
    providerStatus.includes('error')
  ) {
    throw new Error(
      `Africa's Talking Voice call was not accepted (status=${providerStatus})`
    );
  }
  return { accepted: true, response };
}

// A small injection point keeps Voice behavior unit-testable without live calls.
export function setVoiceClientForTests(client: VoiceClient | null): void {
  voiceClient = client;
}
