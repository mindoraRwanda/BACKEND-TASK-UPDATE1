import { createRequire } from 'node:module';
import { FatalNotificationError } from './errors.js';
import { logNotification } from './notificationLogger.js';

const require = createRequire(import.meta.url);

interface SMSMessageData {
  Message: string;
  Recipients: {
    statusCode: number;
    number: string;
    // AT returns the code name as a string ("Sent", "Queued", "InvalidPhoneNumber", etc.)
    // — NOT "fulfilled"/"failed". Use statusCode for all outcome decisions.
    status: string;
    cost: string;
    messageId: string;
  }[];
}

// AT statusCodes 100–102 all represent successful delivery or acceptance.
// 100 Processed, 101 Sent, 102 Queued
const AT_SUCCESS_CODES = new Set([100, 101, 102]);

// Africa's Talking status codes that will never succeed on retry.
// 402 InvalidSenderId      — account-level sender ID misconfiguration; every send fails until admin fixes it
// 403 InvalidPhoneNumber   — number format is permanently malformed
// 404 UnsupportedNumberType — number type (landline, data-only SIM) cannot receive SMS
// 406 UserInBlacklist      — recipient opted out (DND/GDPR); must not attempt re-send
const FATAL_AT_CODES = new Set([402, 403, 404, 406]);

const FATAL_AT_CODE_LABELS: Record<number, string> = {
  402: 'InvalidSenderId',
  403: 'InvalidPhoneNumber',
  404: 'UnsupportedNumberType',
  406: 'UserInBlacklist',
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const makeAfricasTalking = require('africastalking') as (opts: {
  apiKey: string;
  username: string;
}) => {
  SMS: {
    send(opts: {
      to: string[];
      message: string;
      from?: string;
    }): Promise<{ SMSMessageData: SMSMessageData }>;
  };
};

let smsClient: ReturnType<typeof makeAfricasTalking>['SMS'] | null = null;

export function initSms(): void {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  if (!apiKey || !username) {
    console.warn(
      '[sms] AT_API_KEY or AT_USERNAME not set — SMS notifications disabled'
    );
    return;
  }
  smsClient = makeAfricasTalking({ apiKey, username }).SMS;
  console.log("✓ Africa's Talking SMS client initialized");
}

/**
 * Sends an SMS to the user identified by `to`, using a pre-fetched phone
 * number (resolved by the caller via getUserPreferences() — see preferences.ts).
 * Throws `FatalNotificationError` for permanently undeliverable numbers (invalid format,
 * blacklisted, unsupported type). Throws a plain `Error` for transient failures
 * (balance, routing, gateway) so retry.ts can schedule backoff retries.
 *
 * SMS_ENABLED gates actual delivery here (not at the call site) so every
 * attempt — including ones made while disabled — gets logged consistently.
 *
 * @param to    - User ID, used only for logging (phone number comes from `phoneNumber`).
 * @param body  - SMS message body (160 chars per segment; AT auto-splits multi-part messages).
 * @param phoneNumber - Pre-fetched phone number, or null if none on file.
 */
export async function sendSms(
  to: string,
  body: string,
  phoneNumber: string | null,
  eventType = 'unknown'
): Promise<void> {
  console.log(`[sms] sendSms → user=${to}`);

  // SMS is disabled by default until operations configures verified recipients
  // and Africa's Talking credentials. Enable explicitly with SMS_ENABLED=true.
  if (process.env.SMS_ENABLED !== 'true') {
    console.warn(
      `[sms] SMS disabled (SMS_ENABLED!=true) — skipping user ${to}`
    );
    await logNotification({
      userId: to,
      eventType,
      channel: 'sms',
      status: 'skipped',
      failureReason: 'SMS disabled until operations configuration is completed',
    });
    return;
  }

  if (!smsClient) {
    console.warn(
      `[sms] SMS client not initialized — skipping SMS to user ${to}`
    );
    await logNotification({
      userId: to,
      eventType,
      channel: 'sms',
      status: 'skipped',
      failureReason: 'SMS client not initialized',
    });
    return;
  }

  const phone = phoneNumber;
  if (!phone) {
    console.warn(`[sms] No phone number for user ${to} — skipping SMS`);
    await logNotification({
      userId: to,
      eventType,
      channel: 'sms',
      status: 'skipped',
      failureReason: 'No phone number on file',
    });
    return;
  }

  const senderId = process.env.AT_SENDER_ID?.trim();
  const result = await smsClient.send({
    to: [phone],
    message: body,
    ...(senderId ? { from: senderId } : {}),
  });
  const recipient = result.SMSMessageData.Recipients[0];

  if (!recipient || AT_SUCCESS_CODES.has(recipient.statusCode)) {
    console.log(
      `[sms] SMS delivered → user=${to} phone=${phone} status=${recipient?.status ?? 'unknown'}`
    );
    await logNotification({
      userId: to,
      eventType,
      channel: 'sms',
      status: 'delivered',
    });
    return;
  }

  const { statusCode } = recipient;

  if (FATAL_AT_CODES.has(statusCode)) {
    const label = FATAL_AT_CODE_LABELS[statusCode] ?? `code ${statusCode}`;
    console.error(
      `[sms] Fatal AT error (${label}) for user ${to} — number ${phone} is permanently unreachable, routing straight to DLQ`
    );
    await logNotification({
      userId: to,
      eventType,
      channel: 'sms',
      status: 'failed',
      failureReason: `Fatal AT error (${label})`,
    });
    throw new FatalNotificationError(
      `AT ${label} for user ${to}`,
      String(statusCode),
      to
    );
  }

  // Transient: balance low (405), risk hold (401), routing failure (407), gateway errors (500/501/502)
  await logNotification({
    userId: to,
    eventType,
    channel: 'sms',
    status: 'failed',
    failureReason: `AT status ${statusCode}`,
  });
  throw new Error(
    `SMS delivery failed (AT status ${statusCode}) for user ${to} — will retry`
  );
}
