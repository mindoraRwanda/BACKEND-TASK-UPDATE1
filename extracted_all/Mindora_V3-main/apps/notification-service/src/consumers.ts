import {
  EXCHANGES,
  aiCrisisEventSchema,
  authNotificationEventSchema,
  appointmentDomainEventSchema,
  communityDomainEventSchema,
  messageReceivedEventSchema,
  moodDomainEventSchema,
  therapistApplicationDomainEventSchema,
} from '@mindora/events';
import type {
  AppointmentBookedEvent,
  AppointmentConfirmedEvent,
  AppointmentCancelledEvent,
} from '@mindora/events';
import { sendPushNotification } from './fcm.js';
import { getUserName, sendEmail, sendEmailToUser } from './email.js';
import { sendSms } from './sms.js';
import { sendVoiceCall } from './voice.js';
import {
  claimNotificationAttempt,
  finishNotificationAttempt,
  logNotification,
} from './notificationLogger.js';
import {
  getUserPreferences,
  isChannelEnabled,
  type UserPreferences,
} from './preferences.js';
import {
  appointmentBookedTemplate,
  appointmentConfirmedTemplate,
  appointmentCancelledTemplate,
  therapistApplicationApprovedTemplate,
  therapistApplicationMoreInfoTemplate,
  therapistApplicationRejectedTemplate,
  therapistApplicationSubmittedTemplate,
  therapistReactivatedTemplate,
  therapistSuspendedTemplate,
} from './emailTemplates.js';
import { subscribeWithRetry } from './retry.js';
import { InvalidEventPayloadError } from './errors.js';

const NOTIFICATION_QUEUES = {
  APPOINTMENTS: 'notification.appointments',
  MESSAGES: 'notification.messages',
  MOOD: 'notification.mood',
  AI: 'notification.ai',
  AUTH: 'notification.auth',
  COMMUNITY: 'notification.community',
  THERAPIST_APPLICATIONS: 'notification.therapist-applications',
} as const;

export const SUBSCRIBED_EXCHANGES = Object.values(EXCHANGES);

// Checks the user's channel preference before sending; logs 'skipped' with a
// preference-specific reason and never calls the send function if disabled.
async function sendPushIfEnabled(
  userId: string,
  title: string,
  body: string,
  eventType: string,
  prefs: UserPreferences
): Promise<void> {
  if (!isChannelEnabled(prefs.notificationPreferences, 'push')) {
    await logNotification({
      userId,
      eventType,
      channel: 'push',
      status: 'skipped',
      failureReason: 'Push notifications disabled by user',
    });
    return;
  }
  await sendPushNotification(userId, title, body, prefs.fcmToken, eventType);
}

async function sendEmailIfEnabled(
  userId: string,
  subject: string,
  htmlBody: string,
  eventType: string,
  prefs: UserPreferences
): Promise<void> {
  if (!isChannelEnabled(prefs.notificationPreferences, 'email')) {
    await logNotification({
      userId,
      eventType,
      channel: 'email',
      status: 'skipped',
      failureReason: 'Email notifications disabled by user',
    });
    return;
  }
  await sendEmailToUser(userId, subject, htmlBody, prefs.email, eventType);
}

async function sendSmsIfEnabled(
  userId: string,
  body: string,
  eventType: string,
  prefs: UserPreferences
): Promise<void> {
  if (!isChannelEnabled(prefs.notificationPreferences, 'sms')) {
    await logNotification({
      userId,
      eventType,
      channel: 'sms',
      status: 'skipped',
      failureReason: 'SMS notifications disabled by user',
    });
    return;
  }
  // sendSms() itself also checks SMS_ENABLED and logs its own 'skipped' entry
  // when that feature flag is off — this gate is specifically the user's
  // per-channel preference, checked before sendSms's own flag check runs.
  await sendSms(userId, body, prefs.phoneNumber, eventType);
}

function configuredList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char
  );
}

async function sendAdminEmailAlerts(
  recipients: string[],
  subject: string,
  html: string,
  eventId?: string,
  eventType = 'admin.alert.email'
): Promise<void> {
  if (recipients.length === 0) {
    throw new Error('No MINDORA operations email recipient is configured');
  }
  const failures: string[] = [];
  await Promise.all(
    recipients.map(async (recipient) => {
      const dedupeKey = eventId ? `${eventId}:email:${recipient}` : undefined;
      if (dedupeKey) {
        const claimed = await claimNotificationAttempt({
          dedupeKey,
          userId: 'mindora-admin',
          eventType,
          channel: 'email',
        });
        if (!claimed) return;
      }
      try {
        const sent = await sendEmail(recipient, subject, html);
        if (!sent)
          throw new Error('Resend is not initialized or email was skipped');
        if (dedupeKey) await finishNotificationAttempt(dedupeKey, 'delivered');
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        if (dedupeKey)
          await finishNotificationAttempt(dedupeKey, 'failed', reason);
        failures.push(`${recipient}: ${reason}`);
      }
    })
  );
  if (failures.length) {
    console.error(
      '[notification] Admin email delivery failures:',
      failures.join('; ')
    );
    throw new Error(
      `Admin alert email delivery failed for ${failures.length} recipient(s)`
    );
  }
}

async function sendAdminSmsAlerts(
  recipients: string[],
  message: string,
  eventType: string,
  eventId?: string
): Promise<void> {
  if (recipients.length === 0) {
    console.warn(
      `[notification] No recipient configured for ${eventType}; SMS skipped`
    );
    return;
  }
  if (process.env.SMS_ENABLED !== 'true') {
    console.warn(
      `[notification] SMS_ENABLED is not true; ${eventType} SMS skipped`
    );
    for (const _phone of recipients) {
      await logNotification({
        userId: 'mindora-admin',
        eventType,
        channel: 'sms',
        status: 'skipped',
        failureReason: 'SMS_ENABLED is not true',
      });
    }
    return;
  }
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    throw new Error(
      `Africa's Talking credentials are missing for ${eventType} SMS`
    );
  }
  const failures: string[] = [];
  await Promise.all(
    recipients.map(async (phone) => {
      const dedupeKey = eventId ? `${eventId}:sms:${phone}` : undefined;
      if (dedupeKey) {
        const claimed = await claimNotificationAttempt({
          dedupeKey,
          userId: 'mindora-admin',
          eventType,
          channel: 'sms',
        });
        if (!claimed) return;
      }
      try {
        await sendSms('mindora-admin', message, phone, eventType);
        if (dedupeKey) await finishNotificationAttempt(dedupeKey, 'delivered');
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        if (dedupeKey)
          await finishNotificationAttempt(dedupeKey, 'failed', reason);
        failures.push(`${phone}: ${reason}`);
      }
    })
  );
  if (failures.length) {
    console.error(
      '[notification] Admin SMS delivery failures:',
      failures.join('; ')
    );
    throw new Error(
      `Admin SMS delivery failed for ${failures.length} recipient(s)`
    );
  }
}

async function sendAdminVoiceAlerts(
  recipients: string[],
  eventId: string,
  eventType: string
): Promise<void> {
  if (recipients.length === 0) {
    console.warn(
      `[notification] No recipient configured for ${eventType}; Voice skipped`
    );
    return;
  }
  if (process.env.AT_VOICE_ENABLED !== 'true') {
    console.warn(
      `[notification] AT_VOICE_ENABLED is not true; ${eventType} Voice skipped`
    );
    for (const _phone of recipients) {
      await logNotification({
        userId: 'mindora-admin',
        eventType,
        channel: 'voice',
        status: 'skipped',
        failureReason: 'AT_VOICE_ENABLED is not true',
      });
    }
    return;
  }

  const failures: string[] = [];
  await Promise.all(
    recipients.map(async (phone) => {
      const dedupeKey = `${eventId}:voice:${phone}`;
      const claimed = await claimNotificationAttempt({
        dedupeKey,
        userId: 'mindora-admin',
        eventType,
        channel: 'voice',
      });
      if (!claimed) return;
      try {
        const result = await sendVoiceCall(phone, eventId);
        if (!result.accepted) {
          await finishNotificationAttempt(
            dedupeKey,
            'skipped',
            'Voice provider is not enabled'
          );
          return;
        }
        await finishNotificationAttempt(
          dedupeKey,
          'accepted',
          "Call request accepted by Africa's Talking; final call outcome is reported through the configured Voice events callback."
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        await finishNotificationAttempt(dedupeKey, 'failed', reason);
        failures.push(`${phone}: ${reason}`);
      }
    })
  );
  if (failures.length) {
    console.error(
      '[notification] Admin Voice call failures:',
      failures.join('; ')
    );
    throw new Error(
      `Admin Voice call failed for ${failures.length} recipient(s)`
    );
  }
}

function failedNotificationChannels(
  results: PromiseSettledResult<void>[],
  labels: string[]
): string[] {
  return results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          `${labels[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : []
  );
}

function sessionTypeLabel(
  sessionType: AppointmentBookedEvent['sessionType']
): string {
  switch (sessionType) {
    case 'VIDEO':
      return 'Video';
    case 'IN_PERSON':
      return 'In-person';
    case 'CHAT':
      return 'Chat';
    default:
      return 'Appointment';
  }
}

async function handleAppointment(payload: unknown): Promise<void> {
  const parsed = appointmentDomainEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid appointment event: ${parsed.error.message}`,
      EXCHANGES.APPOINTMENTS
    );
  }
  const event = parsed.data as
    | AppointmentBookedEvent
    | AppointmentConfirmedEvent
    | AppointmentCancelledEvent;

  const [patientName, therapistName] = await Promise.all([
    getUserName(event.patientId),
    getUserName(event.therapistId),
  ]).then(([patient, therapist]) => [
    patient ?? 'Patient',
    therapist ?? 'your therapist',
  ]);

  if (event.eventType === 'appointment.cancelled') {
    const cancelled = event as AppointmentCancelledEvent;
    const recipientId =
      cancelled.cancelledByUserId === cancelled.therapistId
        ? cancelled.patientId
        : cancelled.therapistId;
    const reason = cancelled.cancellationReason;
    const body = reason
      ? `Reason: ${reason}`
      : 'Your appointment has been cancelled.';
    const prefs = await getUserPreferences(recipientId);
    const results = await Promise.allSettled([
      sendPushIfEnabled(
        recipientId,
        'Appointment Cancelled',
        body,
        event.eventType,
        prefs
      ),
      sendEmailIfEnabled(
        recipientId,
        'Your appointment has been cancelled',
        appointmentCancelledTemplate(
          patientName,
          therapistName,
          cancelled.slotStart,
          reason
        ),
        event.eventType,
        prefs
      ),
      sendSmsIfEnabled(
        recipientId,
        'Your MINDORA appointment has been cancelled. Sign in to view the details.',
        event.eventType,
        prefs
      ),
    ]);
    const failures = failedNotificationChannels(results, [
      'push',
      'email',
      'sms',
    ]);
    if (failures.length)
      throw new Error(
        `Appointment cancellation notifications failed: ${failures.join('; ')}`
      );
    return;
  }

  if (event.eventType === 'appointment.confirmed') {
    const confirmed = event as AppointmentConfirmedEvent;
    const prefs = await getUserPreferences(confirmed.patientId);
    const results = await Promise.allSettled([
      sendPushIfEnabled(
        confirmed.patientId,
        'Appointment Confirmed',
        'Your appointment has been confirmed.',
        event.eventType,
        prefs
      ),
      sendEmailIfEnabled(
        confirmed.patientId,
        'Your appointment has been confirmed',
        appointmentConfirmedTemplate(
          patientName,
          therapistName,
          confirmed.slotStart
        ),
        event.eventType,
        prefs
      ),
      sendSmsIfEnabled(
        confirmed.patientId,
        'Your MINDORA appointment has been confirmed. Sign in to view the details.',
        event.eventType,
        prefs
      ),
    ]);
    const failures = failedNotificationChannels(results, [
      'push',
      'email',
      'sms',
    ]);
    if (failures.length)
      throw new Error(
        `Appointment confirmation notifications failed: ${failures.join('; ')}`
      );
    return;
  }

  if (event.eventType === 'appointment.booked') {
    const booked = event as AppointmentBookedEvent;
    const typeLabel = sessionTypeLabel(booked.sessionType);
    const prefs = await getUserPreferences(booked.patientId);

    const adminEmails = configuredList('MINDORA_BOOKING_ALERT_EMAILS');
    const adminPhones = configuredList('MINDORA_BOOKING_ALERT_PHONES');
    const bookingSummary = `New MINDORA appointment booking\nPatient: ${patientName}\nTherapist: ${therapistName}\nWhen: ${booked.slotStart}\nSession: ${typeLabel}\nBooking ID: ${booked.appointmentId}`;

    // Patient-facing and operations notifications are independent. In
    // particular, a failed patient email or push must never suppress the
    // required MINDORA staff email/SMS booking alerts.
    const results = await Promise.allSettled([
      sendPushIfEnabled(
        booked.patientId,
        'Appointment Booked',
        `${typeLabel} appointment scheduled.`,
        event.eventType,
        prefs
      ),
      sendEmailIfEnabled(
        booked.patientId,
        'Your appointment has been booked',
        appointmentBookedTemplate(patientName, therapistName, booked.slotStart),
        event.eventType,
        prefs
      ),
      sendSmsIfEnabled(
        booked.patientId,
        'Your MINDORA appointment has been booked and is pending confirmation. Sign in to view the details.',
        event.eventType,
        prefs
      ),
      sendAdminEmailAlerts(
        adminEmails,
        'MINDORA — New appointment booking',
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px"><h2>New appointment booking</h2><p><strong>Patient:</strong> ${escapeHtml(patientName)}</p><p><strong>Therapist:</strong> ${escapeHtml(therapistName)}</p><p><strong>When:</strong> ${escapeHtml(booked.slotStart)}</p><p><strong>Session:</strong> ${escapeHtml(typeLabel)}</p><p><strong>Booking ID:</strong> ${escapeHtml(booked.appointmentId)}</p></div>`,
        booked.eventId,
        'appointment.booked.admin.email'
      ),
      sendAdminSmsAlerts(
        adminPhones,
        bookingSummary.slice(0, 500),
        'appointment.booked.admin.sms',
        booked.eventId
      ),
    ]);
    const failures = failedNotificationChannels(results, [
      'patient-push',
      'patient-email',
      'patient-sms',
      'operations-email',
      'operations-sms',
    ]);
    if (failures.length) {
      throw new Error(
        `Appointment booking notifications failed: ${failures.join('; ')}`
      );
    }
  }
}

async function handleMessage(payload: unknown): Promise<void> {
  const parsed = messageReceivedEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid message event: ${parsed.error.message}`,
      EXCHANGES.MESSAGES
    );
  }
  const event = parsed.data;
  const preview =
    event.content.length > 80
      ? `${event.content.slice(0, 77)}…`
      : event.content;
  const prefs = await getUserPreferences(event.recipientId);
  await sendPushIfEnabled(
    event.recipientId,
    'New Message',
    preview,
    'message.received',
    prefs
  );
}

async function handleCommunity(payload: unknown): Promise<void> {
  const parsed = communityDomainEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid community event: ${parsed.error.message}`,
      EXCHANGES.COMMUNITY
    );
  }
  // Only reply events trigger a push; reported events are admin-facing
  if (!('replyId' in parsed.data)) return;
  const event = parsed.data;
  const prefs = await getUserPreferences(event.postAuthorId);
  await sendPushIfEnabled(
    event.postAuthorId,
    'New Reply',
    event.excerpt,
    'community.reply',
    prefs
  );
}

async function handleAi(payload: unknown): Promise<void> {
  // Never log the raw payload: it may contain a person's crisis disclosure.
  const parsed = aiCrisisEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid AI event: ${parsed.error.message}`,
      EXCHANGES.AI
    );
  }
  const crisis = parsed.data;
  const adminEmails = configuredList('MINDORA_CRISIS_ALERT_EMAILS');
  const adminPhones = configuredList('MINDORA_CRISIS_ALERT_PHONES');
  const excerpt = crisis.messageExcerpt
    ? escapeHtml(crisis.messageExcerpt.slice(0, 1500))
    : 'No message excerpt was attached. Review the encrypted interaction using the secure admin workflow.';
  const transcript = crisis.conversationExcerpt
    ? escapeHtml(crisis.conversationExcerpt.slice(0, 5000))
    : 'No recent transcript excerpt was available.';
  const subject = `URGENT: MINDORA chatbot crisis alert (level ${crisis.crisisLevel})`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:24px;color:#15242c"><h1 style="color:#a61b1b">Urgent chatbot safety alert</h1><p>A chatbot message was flagged for possible suicide or self-harm risk.</p><p><strong>Crisis level:</strong> ${crisis.crisisLevel}</p><p><strong>User ID:</strong> ${escapeHtml(crisis.userId)}</p><p><strong>Session ID:</strong> ${escapeHtml(crisis.sessionId ?? 'Unavailable')}</p><p><strong>Interaction ID:</strong> ${escapeHtml(crisis.interactionId ?? 'Unavailable')}</p><p><strong>Source:</strong> ${escapeHtml(crisis.source ?? 'web-chatbot')}</p><p><strong>External chatbot user reference:</strong> ${escapeHtml(crisis.externalUserRef ?? 'Not supplied')}</p><p><strong>Detected at:</strong> ${escapeHtml(crisis.occurredAt)}</p><h2>Flagged message excerpt</h2><blockquote style="border-left:4px solid #c53030;padding-left:12px;white-space:pre-wrap">${excerpt}</blockquote><h2>Recent conversation context</h2><blockquote style="border-left:4px solid #718096;padding-left:12px;white-space:pre-wrap">${transcript}</blockquote><p>Please follow MINDORA's approved clinical escalation protocol. This alert is not a substitute for emergency services.</p></div>`;
  const voicePhones = configuredList('MINDORA_CRISIS_ALERT_VOICE_PHONES');
  // Each channel is attempted independently. Promise.allSettled prevents a
  // rejected email provider call from suppressing SMS or Voice. Durable
  // per-recipient idempotency records prevent successful channels from being
  // re-sent when RabbitMQ retries an event because another channel failed.
  const channelResults = await Promise.allSettled([
    sendAdminEmailAlerts(
      adminEmails,
      subject,
      html,
      crisis.eventId,
      'ai.crisis.admin.email'
    ),
    sendAdminSmsAlerts(
      adminPhones,
      `URGENT MINDORA crisis alert level ${crisis.crisisLevel}. A safety event requires attention. Review the restricted admin console.`,
      'ai.crisis.admin.sms',
      crisis.eventId
    ),
    sendAdminVoiceAlerts(voicePhones, crisis.eventId, 'ai.crisis.admin.voice'),
  ]);
  const failures = channelResults.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          `${['email', 'sms', 'voice'][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : []
  );
  if (failures.length) {
    throw new Error(
      `One or more crisis notification channels failed: ${failures.join('; ')}`
    );
  }
}

async function handleAuth(payload: unknown): Promise<void> {
  const parsed = authNotificationEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid auth notification event: ${parsed.error.message}`,
      EXCHANGES.AUTH
    );
  }
  const event = parsed.data;
  if (event.eventType === 'password.reset') {
    const safeUrl = escapeHtml(event.resetUrl);
    try {
      const accepted = await sendEmail(
        event.recipientEmail,
        'Reset your MINDORA password',
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#15242c"><h1>Reset your password</h1><p>We received a request to reset the password for your MINDORA account.</p><p><a href="${safeUrl}" style="display:inline-block;background:#279eae;color:white;padding:12px 20px;border-radius:8px;text-decoration:none">Reset password</a></p><p>This secure link expires in ${event.expiresInMinutes} minutes and can only be used once. If you did not request this, you can ignore this email.</p></div>`
      );
      if (!accepted) throw new Error('EMAIL_PROVIDER_NOT_INITIALIZED');
      await logNotification({
        userId: `password-reset:${event.eventId}`,
        eventType: event.eventType,
        channel: 'email',
        status: 'accepted',
        failureReason:
          'Provider accepted request; mailbox delivery is not confirmed',
      });
      return;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      await logNotification({
        userId: `password-reset:${event.eventId}`,
        eventType: event.eventType,
        channel: 'email',
        status: 'failed',
        failureReason: errorName,
      });
      throw error;
    }
  }
  const sent = await sendEmail(
    event.recipientEmail,
    'MINDORA account temporarily locked',
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#15242c"><h1>Account temporarily locked</h1><p>We detected five unsuccessful sign-in attempts for your MINDORA account.</p><p>For your protection, sign-in is blocked for 15 minutes, until ${escapeHtml(event.lockedUntil)}.</p><p>If this was not you, reset your password and contact MINDORA support.</p></div>`
  );
  if (!sent)
    throw new Error(
      'Account lock notification email provider is not initialized'
    );
}

async function handleMood(payload: unknown): Promise<void> {
  console.log(`[${EXCHANGES.MOOD}] received:`, JSON.stringify(payload));
  const parsed = moodDomainEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid mood event: ${parsed.error.message}`,
      EXCHANGES.MOOD
    );
  }
  // No push/email/SMS wired to mood events yet — validation only, for now.
}

async function handleTherapistApplication(payload: unknown): Promise<void> {
  const parsed = therapistApplicationDomainEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid therapist application event: ${parsed.error.message}`,
      EXCHANGES.THERAPIST_APPLICATIONS
    );
  }
  const event = parsed.data;
  const name = (await getUserName(event.userId)) ?? 'there';
  const prefs = await getUserPreferences(event.userId);

  switch (event.eventType) {
    case 'therapist_application.submitted':
      await sendEmailIfEnabled(
        event.userId,
        'Your therapist application has been received',
        therapistApplicationSubmittedTemplate(name),
        event.eventType,
        prefs
      );
      return;
    case 'therapist_application.approved':
      await sendPushIfEnabled(
        event.userId,
        'Application Approved',
        'Your therapist application has been approved.',
        event.eventType,
        prefs
      );
      await sendEmailIfEnabled(
        event.userId,
        'Your therapist application has been approved',
        therapistApplicationApprovedTemplate(name),
        event.eventType,
        prefs
      );
      return;
    case 'therapist_application.rejected':
      await sendEmailIfEnabled(
        event.userId,
        'An update on your therapist application',
        therapistApplicationRejectedTemplate(name, event.reason),
        event.eventType,
        prefs
      );
      return;
    case 'therapist_application.more_info_requested':
      await sendEmailIfEnabled(
        event.userId,
        'More information needed for your therapist application',
        therapistApplicationMoreInfoTemplate(name, event.note),
        event.eventType,
        prefs
      );
      return;
    case 'therapist_application.suspended':
      await sendEmailIfEnabled(
        event.userId,
        'Your Mindora therapist account has been suspended',
        therapistSuspendedTemplate(name),
        event.eventType,
        prefs
      );
      return;
    case 'therapist_application.reactivated':
      await sendEmailIfEnabled(
        event.userId,
        'Your Mindora therapist account has been reactivated',
        therapistReactivatedTemplate(name),
        event.eventType,
        prefs
      );
      return;
  }
}

export async function startConsumers(): Promise<void> {
  // 'topic' here because appointment-service/mood-tracking-service publish
  // via publishToExchange, which declares these two exchanges as 'topic'.
  // Left as default 'fanout' for MESSAGES/COMMUNITY/AI — messaging-service
  // doesn't publish to mindora.messages yet, and ai-integration-service
  // already declares mindora.ai as 'fanout' itself (see ai.routes.ts).
  await subscribeWithRetry(
    EXCHANGES.APPOINTMENTS,
    NOTIFICATION_QUEUES.APPOINTMENTS,
    handleAppointment,
    'topic'
  );

  await subscribeWithRetry(
    EXCHANGES.MESSAGES,
    NOTIFICATION_QUEUES.MESSAGES,
    handleMessage
  );

  await subscribeWithRetry(
    EXCHANGES.COMMUNITY,
    NOTIFICATION_QUEUES.COMMUNITY,
    handleCommunity
  );

  await subscribeWithRetry(
    EXCHANGES.MOOD,
    NOTIFICATION_QUEUES.MOOD,
    handleMood,
    'topic'
  );

  await subscribeWithRetry(EXCHANGES.AI, NOTIFICATION_QUEUES.AI, handleAi);

  await subscribeWithRetry(
    EXCHANGES.AUTH,
    NOTIFICATION_QUEUES.AUTH,
    handleAuth,
    'topic'
  );

  await subscribeWithRetry(
    EXCHANGES.THERAPIST_APPLICATIONS,
    NOTIFICATION_QUEUES.THERAPIST_APPLICATIONS,
    handleTherapistApplication,
    'topic'
  );
}
