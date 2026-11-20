import { z } from 'zod';

const appointmentStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
]);

// New bookings follow the current product contract. Legacy IN_PERSON/CHAT
// values remain in the database enum so historical appointments still load.
const sessionTypeSchema = z.enum(['VIDEO', 'AUDIO']);

export const availabilityQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const bookAppointmentSchema = z
  .object({
    therapistId: z.string().uuid(),
    slotStart: z.coerce.date(),
    slotEnd: z.coerce.date(),
    sessionType: sessionTypeSchema,
  })
  .refine((data) => data.slotEnd > data.slotStart, {
    message: 'slotEnd must be after slotStart',
    path: ['slotEnd'],
  });

export const appointmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: appointmentStatusSchema.optional(),
});

export const therapistScheduleQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export const cancelAppointmentSchema = z.object({
  cancellationReason: z.string().min(1).max(500),
});

export const rateAppointmentSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
});

// dayOfWeek: 0=Sunday..6=Saturday. start/endMinute: minutes since midnight
// in the therapist's scheduling timezone (Africa/Kigali — fixed UTC+2, no
// DST, so this is a plain minute-of-day, not a real per-user timezone
// conversion problem). A full-week schedule is any number of these rows,
// including multiple windows per day (e.g. a lunch-break split).
export const workingHoursWindowSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6),
    startMinute: z.coerce.number().int().min(0).max(1439),
    endMinute: z.coerce.number().int().min(0).max(1439),
  })
  .refine((data) => data.endMinute > data.startMinute, {
    message: 'endMinute must be after startMinute',
    path: ['endMinute'],
  });

// Full replace, not a patch — the therapist's entire weekly schedule is
// small enough that "send the whole thing back" is simpler and less
// error-prone than a partial-update API for a list of windows.
export const updateAvailabilitySchema = z.object({
  timezone: z.string().min(1).max(64).default('Africa/Kigali'),
  workingHours: z.array(workingHoursWindowSchema).max(50),
});

export const createTimeOffSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().max(500).optional(),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export const listPatientsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type AvailabilityQueryDto = z.infer<typeof availabilityQuerySchema>;
export type BookAppointmentDto = z.infer<typeof bookAppointmentSchema>;
export type AppointmentListQueryDto = z.infer<
  typeof appointmentListQuerySchema
>;
export type TherapistScheduleQueryDto = z.infer<
  typeof therapistScheduleQuerySchema
>;
export type CancelAppointmentDto = z.infer<typeof cancelAppointmentSchema>;
export type RateAppointmentDto = z.infer<typeof rateAppointmentSchema>;
export type WorkingHoursWindowDto = z.infer<typeof workingHoursWindowSchema>;
export type UpdateAvailabilityDto = z.infer<typeof updateAvailabilitySchema>;
export type CreateTimeOffDto = z.infer<typeof createTimeOffSchema>;
export type ListPatientsQueryDto = z.infer<typeof listPatientsQuerySchema>;
