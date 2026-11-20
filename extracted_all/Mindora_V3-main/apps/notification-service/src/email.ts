import { Resend } from 'resend';
import { logNotification } from './notificationLogger.js';

let resend: Resend | null = null;

// Use a verified MINDORA sending domain in production. Resend's sandbox sender
// is only suitable for development/testing and may restrict recipients.
let fromAddress =
  process.env.RESEND_FROM_EMAIL?.trim() || 'Mindora <onboarding@resend.dev>';

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  )
    return error.name;
  return 'ProviderError';
}

export function initResend(): void {
  const apiKey = process.env.RESEND_EMAIL_API_KEY?.trim();
  const configuredFrom = process.env.RESEND_FROM_EMAIL?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (
    isProduction &&
    (!apiKey ||
      !configuredFrom ||
      configuredFrom.includes('onboarding@resend.dev'))
  ) {
    throw new Error(
      'Production email requires RESEND_EMAIL_API_KEY and a verified RESEND_FROM_EMAIL sender'
    );
  }
  if (!apiKey) {
    console.warn(
      '[email] RESEND_EMAIL_API_KEY is not configured — email notifications are disabled'
    );
    return;
  }
  fromAddress = configuredFrom || fromAddress;
  resend = new Resend(apiKey);
  console.log('[email] Resend email client initialized');
}

// Calls the same preferences endpoint for a display name, used to personalize
// appointment emails instead of the generic 'Patient'/'[name pending]' role
// labels. Returns null if the user hasn't set one (or the service call fails)
// — callers fall back to a role-based label in that case.
export async function getUserName(userId: string): Promise<string | null> {
  const base = process.env.USER_SERVICE_URL ?? 'http://localhost:3002';
  const url = `${base}/api/v1/users/${userId}/preferences`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });
    if (!res.ok) {
      console.warn(
        `[email] User Service returned ${res.status} for user ${userId} — no userName`
      );
      return null;
    }
    const data = (await res.json()) as { userName?: string };
    return data.userName ?? null;
  } catch (err) {
    console.warn(`[email] User Service unreachable for user ${userId}:`, err);
    return null;
  }
}

// Returns whether an actual send attempt was made — false for the
// 'Resend not initialized' skip case, true once we've reached Resend
// (throws on a real delivery failure rather than returning false for that).
export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string
): Promise<boolean> {
  console.log(
    `[email] sendEmail requested (recipient redacted; subject="${subject}")`
  );

  if (!resend) {
    console.warn('[email] Resend not initialized — email send skipped');
    return false;
  }

  const { error } = await resend.emails.send({
    from: fromAddress,
    to,
    subject,
    html: htmlBody,
  });

  if (error) {
    console.error(
      '[email] Resend provider request failed:',
      safeErrorCode(error)
    );
    throw new Error('EMAIL_PROVIDER_SEND_FAILED');
  }

  console.log(
    '[email] Resend accepted the email request; final mailbox delivery is not confirmed'
  );
  return true;
}

// Sends to a pre-fetched email address (resolved by the caller via
// getUserPreferences() — see preferences.ts). Returns silently (after
// logging) if no email is on file, same graceful pattern as sendPushNotification.
export async function sendEmailToUser(
  userId: string,
  subject: string,
  htmlBody: string,
  email: string | null,
  eventType = 'unknown'
): Promise<void> {
  if (!email) {
    console.warn(`[email] No email address for user ${userId} — skipping`);
    await logNotification({
      userId,
      eventType,
      channel: 'email',
      status: 'skipped',
      failureReason: 'No email address on file',
    });
    return;
  }

  try {
    const sent = await sendEmail(email, subject, htmlBody);
    await logNotification({
      userId,
      eventType,
      channel: 'email',
      status: sent ? 'accepted' : 'skipped',
      failureReason: sent ? undefined : 'Resend client not initialized',
    });
  } catch (err) {
    const failureCode = safeErrorCode(err);
    await logNotification({
      userId,
      eventType,
      channel: 'email',
      status: 'failed',
      failureReason: failureCode,
    });
    throw err;
  }
}
