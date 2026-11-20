import { z } from 'zod';
import {
  eventMetadataSchema,
  type IsoDateTimeString,
  type UuidString,
  type WithMetadata,
} from '../common.js';
import type { APPOINTMENT_ROUTING_KEYS } from './constants.js';

export const APPOINTMENT_SESSION_TYPES = [
  'VIDEO',
  'AUDIO',
  'IN_PERSON',
  'CHAT',
] as const;
export type AppointmentSessionType = (typeof APPOINTMENT_SESSION_TYPES)[number];

export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Core appointment fields shared across event payloads. */
export interface AppointmentSlotPayload {
  appointmentId: UuidString;
  patientId: UuidString;
  therapistId: UuidString;
  slotStart: IsoDateTimeString;
  slotEnd: IsoDateTimeString;
  sessionType: AppointmentSessionType;
}

/** Published after POST /appointments succeeds (routing key: appointment.booked). */
export type AppointmentBookedEvent = WithMetadata<
  AppointmentSlotPayload & {
    eventType: typeof APPOINTMENT_ROUTING_KEYS.BOOKED;
    status: 'PENDING';
  }
>;

/** Published after therapist PUT /appointments/:id/confirm (routing key: appointment.confirmed). */
export type AppointmentConfirmedEvent = WithMetadata<
  AppointmentSlotPayload & {
    eventType: typeof APPOINTMENT_ROUTING_KEYS.CONFIRMED;
    status: 'CONFIRMED';
    confirmedByUserId: UuidString;
  }
>;

/** Published after PUT /appointments/:id/cancel (routing key: appointment.cancelled). */
export type AppointmentCancelledEvent = WithMetadata<
  AppointmentSlotPayload & {
    eventType: typeof APPOINTMENT_ROUTING_KEYS.CANCELLED;
    status: 'CANCELLED';
    cancelledByUserId: UuidString;
    cancellationReason: string;
  }
>;

/** Published after therapist PUT /appointments/:id/complete (routing key: appointment.completed). */
export type AppointmentCompletedEvent = WithMetadata<
  AppointmentSlotPayload & {
    eventType: typeof APPOINTMENT_ROUTING_KEYS.COMPLETED;
    status: 'COMPLETED';
    completedByUserId: UuidString;
  }
>;

export type AppointmentDomainEvent =
  | AppointmentBookedEvent
  | AppointmentConfirmedEvent
  | AppointmentCancelledEvent
  | AppointmentCompletedEvent;

const appointmentSlotPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  patientId: z.string().uuid(),
  therapistId: z.string().uuid(),
  slotStart: z.string().datetime(),
  slotEnd: z.string().datetime(),
  sessionType: z.enum(APPOINTMENT_SESSION_TYPES),
});

export const appointmentBookedEventSchema = eventMetadataSchema.merge(
  appointmentSlotPayloadSchema.extend({
    eventType: z.literal('appointment.booked'),
    status: z.literal('PENDING'),
  })
);

export const appointmentConfirmedEventSchema = eventMetadataSchema.merge(
  appointmentSlotPayloadSchema.extend({
    eventType: z.literal('appointment.confirmed'),
    status: z.literal('CONFIRMED'),
    confirmedByUserId: z.string().uuid(),
  })
);

export const appointmentCancelledEventSchema = eventMetadataSchema.merge(
  appointmentSlotPayloadSchema.extend({
    eventType: z.literal('appointment.cancelled'),
    status: z.literal('CANCELLED'),
    cancelledByUserId: z.string().uuid(),
    cancellationReason: z.string(),
  })
);

export const appointmentCompletedEventSchema = eventMetadataSchema.merge(
  appointmentSlotPayloadSchema.extend({
    eventType: z.literal('appointment.completed'),
    status: z.literal('COMPLETED'),
    completedByUserId: z.string().uuid(),
  })
);

/** Matches any event published to the mindora.appointments exchange. */
export const appointmentDomainEventSchema = z.union([
  appointmentBookedEventSchema,
  appointmentConfirmedEventSchema,
  appointmentCancelledEventSchema,
  appointmentCompletedEventSchema,
]);
