export {
  eventMetadataSchema,
  type EventMetadata,
  type IsoDateTimeString,
  type UuidString,
  type WithMetadata,
} from './common.js';

export type { BaseEvent, QueueName, ExchangeName } from './base.js';
export { QUEUES, EXCHANGES, baseEventSchema } from './base.js';
export {
  communityDomainEventSchema,
  communityReportedEventSchema,
  communityReplyEventSchema,
  type CommunityReportedEvent,
  type CommunityReplyEvent,
} from './community.js';
export {
  messageReceivedEventSchema,
  type MessageReceivedEvent,
} from './messaging.js';
export {
  aiCrisisEventSchema,
  aiUsageLoggedEventSchema,
  type AICrisisEvent,
  type AIUsageLoggedEvent,
} from './ai.js';

export {
  APPOINTMENTS_EXCHANGE,
  APPOINTMENT_ROUTING_KEYS,
  APPOINTMENT_SESSION_TYPES,
  APPOINTMENT_STATUSES,
  appointmentBookedEventSchema,
  appointmentCancelledEventSchema,
  appointmentCompletedEventSchema,
  appointmentConfirmedEventSchema,
  appointmentDomainEventSchema,
  createAppointmentBookedEvent,
  createAppointmentCancelledEvent,
  createAppointmentCompletedEvent,
  createAppointmentConfirmedEvent,
  type AppointmentBookedEvent,
  type AppointmentCancelledEvent,
  type AppointmentCompletedEvent,
  type AppointmentConfirmedEvent,
  type AppointmentDomainEvent,
  type AppointmentRoutingKey,
  type AppointmentSessionType,
  type AppointmentSlotPayload,
  type AppointmentStatus,
} from './appointments/index.js';

export {
  MOOD_EXCHANGE,
  MOOD_ROUTING_KEYS,
  MOOD_STREAK_MILESTONES,
  createMoodConcernEvent,
  createMoodStreakEvent,
  moodConcernEventSchema,
  moodDomainEventSchema,
  moodStreakEventSchema,
  type MoodConcernEvent,
  type MoodDomainEvent,
  type MoodRoutingKey,
  type MoodStreakEvent,
} from './mood/index.js';

export {
  THERAPIST_APPLICATION_EXCHANGE,
  THERAPIST_APPLICATION_ROUTING_KEYS,
  createTherapistApplicationApprovedEvent,
  createTherapistApplicationMoreInfoRequestedEvent,
  createTherapistApplicationReactivatedEvent,
  createTherapistApplicationRejectedEvent,
  createTherapistApplicationSubmittedEvent,
  createTherapistApplicationSuspendedEvent,
  therapistApplicationApprovedEventSchema,
  therapistApplicationDomainEventSchema,
  therapistApplicationMoreInfoRequestedEventSchema,
  therapistApplicationReactivatedEventSchema,
  therapistApplicationRejectedEventSchema,
  therapistApplicationSubmittedEventSchema,
  therapistApplicationSuspendedEventSchema,
  type TherapistApplicationApprovedEvent,
  type TherapistApplicationDomainEvent,
  type TherapistApplicationMoreInfoRequestedEvent,
  type TherapistApplicationReactivatedEvent,
  type TherapistApplicationRejectedEvent,
  type TherapistApplicationRoutingKey,
  type TherapistApplicationSubmittedEvent,
  type TherapistApplicationSuspendedEvent,
} from './therapist-application/index.js';

export {
  authNotificationEventSchema,
  type AuthNotificationEvent,
} from './auth.js';
