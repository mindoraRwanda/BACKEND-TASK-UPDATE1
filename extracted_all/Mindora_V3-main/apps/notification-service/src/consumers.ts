import {
  EXCHANGES,
  aiCrisisEventSchema,
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
import { logNotification, prisma } from './notificationLogger.js';
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
    await sendPushIfEnabled(
      recipientId,
      'Appointment Cancelled',
      body,
      event.eventType,
      prefs
    );
    await sendEmailIfEnabled(
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
    );
    return;
  }

  if (event.eventType === 'appointment.confirmed') {
    const confirmed = event as AppointmentConfirmedEvent;
    const prefs = await getUserPreferences(confirmed.patientId);
    await sendPushIfEnabled(
      confirmed.patientId,
      'Appointment Confirmed',
      'Your appointment has been confirmed.',
      event.eventType,
      prefs
    );
    await sendEmailIfEnabled(
      confirmed.patientId,
      'Your appointment has been confirmed',
      appointmentConfirmedTemplate(
        patientName,
        therapistName,
        confirmed.slotStart
      ),
      event.eventType,
      prefs
    );
    return;
  }

  if (event.eventType === 'appointment.booked') {
    const booked = event as AppointmentBookedEvent;
    const typeLabel = sessionTypeLabel(booked.sessionType);
    const prefs = await getUserPreferences(booked.patientId);
    await sendPushIfEnabled(
      booked.patientId,
      'Appointment Booked',
      `${typeLabel} appointment scheduled.`,
      event.eventType,
      prefs
    );
    await sendEmailIfEnabled(
      booked.patientId,
      'Your appointment has been booked',
      appointmentBookedTemplate(patientName, therapistName, booked.slotStart),
      event.eventType,
      prefs
    );
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

type CrisisChannel = 'email' | 'sms';

async function deliverAdminCrisisAlert(
  eventId: string,
  crisisLevel: number,
  channel: CrisisChannel,
  recipient: string | undefined
): Promise<void> {
  const delivery = await prisma.crisis_deliveries.upsert({
    where: {
      eventId_channel: { eventId, channel },
    },
    create: {
      eventId,
      channel,
      recipient: recipient ?? 'NOT_CONFIGURED',
      status: 'pending',
    },
    update: {},
  });

  if (
    delivery.status === 'delivered' ||
    delivery.status === 'skipped'
  ) {
    return;
  }

  const claimed = await prisma.crisis_deliveries.updateMany({
    where: {
      id: delivery.id,
      OR: [
        { status: 'pending' },
        { status: 'failed' },
        {
          status: 'processing',
          updatedAt: {
            lt: new Date(Date.now() - 5 * 60 * 1000),
          },
        },
      ],
    },
    data: {
      status: 'processing',
      attempts: { increment: 1 },
      failureReason: null,
      recipient: recipient ?? 'NOT_CONFIGURED',
    },
  });

  if (claimed.count === 0) return;

  try {
    if (!recipient) {
      await prisma.crisis_deliveries.update({
        where: { id: delivery.id },
        data: {
          status: 'skipped',
          failureReason: `ADMIN_CRISIS_${channel.toUpperCase()} not configured`,
        },
      });
      return;
    }

    if (channel === 'email') {
      const sent = await sendEmail(
        recipient,
        'Mindora: Crisis alert requires attention',
        `<h2>Crisis alert</h2>
         <p>A patient interaction has triggered a crisis alert.</p>
         <p>Severity level: ${crisisLevel}</p>
         <p>Please follow the approved crisis-response procedure.</p>`
      );

      if (!sent) {
        await prisma.crisis_deliveries.update({
          where: { id: delivery.id },
          data: {
            status: 'skipped',
            failureReason: 'Resend client not initialized',
          },
        });
        return;
      }
    } else {
      if (
        process.env.SMS_ENABLED !== 'true' ||
        !process.env.AT_API_KEY ||
        !process.env.AT_USERNAME
      ) {
        await prisma.crisis_deliveries.update({
          where: { id: delivery.id },
          data: {
            status: 'skipped',
            failureReason:
              'SMS disabled or Africa Talking credentials missing',
          },
        });
        return;
      }

      const result = await sendSms(
        'ADMIN_CRISIS_ALERT',
        `MINDORA CRISIS ALERT: A patient interaction triggered severity level ${crisisLevel}. Please follow the crisis-response procedure.`,
        recipient,
        'ai.crisis.admin'
      );

      if (result === 'skipped') {
        await prisma.crisis_deliveries.update({
          where: { id: delivery.id },
          data: {
            status: 'skipped',
            failureReason: 'SMS service skipped delivery',
          },
        });
        return;
      }
    }

    await prisma.crisis_deliveries.update({
      where: { id: delivery.id },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
      },
    });

    console.log(
      `[crisis-alert] ${channel} accepted for delivery (event=${eventId})`
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);

    await prisma.crisis_deliveries.update({
      where: { id: delivery.id },
      data: {
        status: 'failed',
        failureReason: reason,
      },
    });

    console.error(
      `[crisis-alert] ${channel} failed (event=${eventId}):`,
      reason
    );

    throw error;
  }
}

async function handleAi(payload: unknown): Promise<void> {
  console.log(`[${EXCHANGES.AI}] received:`, JSON.stringify(payload));

  const parsed = aiCrisisEventSchema.safeParse(payload);

  if (!parsed.success) {
    throw new InvalidEventPayloadError(
      `Invalid AI event: ${parsed.error.message}`,
      EXCHANGES.AI
    );
  }

  const crisis = parsed.data;

  const results = await Promise.allSettled([
    deliverAdminCrisisAlert(
      crisis.eventId,
      crisis.crisisLevel,
      'email',
      process.env.ADMIN_CRISIS_EMAIL
    ),
    deliverAdminCrisisAlert(
      crisis.eventId,
      crisis.crisisLevel,
      'sms',
      process.env.ADMIN_CRISIS_PHONE
    ),
  ]);

  const failures = results.filter(
    (result) => result.status === 'rejected'
  );

  console.log('[crisis-alert] delivery results:', {
    eventId: crisis.eventId,
    email: results[0].status,
    sms: results[1].status,
  });

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} crisis notification channel(s) failed`
    );
  }
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
    EXCHANGES.THERAPIST_APPLICATIONS,
    NOTIFICATION_QUEUES.THERAPIST_APPLICATIONS,
    handleTherapistApplication,
    'topic'
  );
}
