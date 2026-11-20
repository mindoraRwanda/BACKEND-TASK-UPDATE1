import {
  createAppointmentCancelledEvent,
  createAppointmentCompletedEvent,
  createAppointmentConfirmedEvent,
  type AppointmentSessionType,
} from '@mindora/events';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '../generated/prisma/index.js';
import {
  analyticsRangeQuerySchema,
  appointmentListQuerySchema,
  availabilityQuerySchema,
  bookAppointmentSchema,
  cancelAppointmentSchema,
  createTimeOffSchema,
  listPatientsQuerySchema,
  rateAppointmentSchema,
  therapistScheduleQuerySchema,
  updateAvailabilitySchema,
} from '@mindora/validation';
import { Router } from 'express';
import {
  defaultAvailabilityRange,
  filterAvailableSlots,
  generateCandidateSlots,
  generateCandidateSlotsFromWorkingHours,
} from '../lib/availability.js';
import {
  bookAppointmentWithLock,
  isSlotConflictError,
} from '../lib/book-appointment.js';
import { publishAppointmentEvent } from '../lib/publish-appointment-event.js';
import { serializeAppointment } from '../lib/serialize-appointment.js';
import { config } from '../config.js';
import {
  verifyJwt,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import { authenticatedRouteLimiter } from '../middleware/rate-limit.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const appointmentRouter = Router();

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

// Appointment Service has no local view of therapist_profiles (mindora_user)
// or users (mindora_auth) — verifying a therapistId belongs to an actual
// THERAPIST goes through Kong to Auth Service's internal endpoint instead of
// a direct database join.
async function isTherapist(userId: string): Promise<boolean> {
  const base = process.env.KONG_URL ?? 'http://localhost:8000';
  try {
    // encodeURIComponent — userId is a caller-supplied route param and must
    // not be able to reshape the request path sent to another service.
    const res = await fetch(
      `${base}/internal/auth/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );
    if (!res.ok) return false;
    const authUser = (await res.json()) as { role: string };
    return authUser.role === 'THERAPIST';
  } catch {
    return false;
  }
}

appointmentRouter.get(
  '/availability/:therapistId',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const therapistId = routeParam(req.params.therapistId);

    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    if (!(await isTherapist(therapistId))) {
      res.status(404).json({ message: 'Therapist not found' });
      return;
    }

    const defaults = defaultAvailabilityRange();
    const from = parsed.data.from ?? defaults.from;
    const to = parsed.data.to ?? defaults.to;

    if (to <= from) {
      res.status(400).json({ message: 'Invalid availability range' });
      return;
    }

    const [bookedAppointments, schedule] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          therapistId,
          status: { in: ['PENDING', 'CONFIRMED'] },
          slotStart: { lt: to },
          slotEnd: { gt: from },
        },
        select: { slotStart: true, slotEnd: true },
      }),
      prisma.therapistSchedule.findUnique({
        where: { therapistId },
        include: {
          workingHours: true,
          timeOff: { where: { startsAt: { lt: to }, endsAt: { gt: from } } },
        },
      }),
    ]);

    // A therapist with no configured schedule (or an empty working-hours
    // list) falls back to the original fixed 9am-5pm-UTC default, so
    // approval doesn't leave them unbookable until they set this up.
    const candidates =
      schedule && schedule.workingHours.length > 0
        ? generateCandidateSlotsFromWorkingHours(
            from,
            to,
            schedule.workingHours
          )
        : generateCandidateSlots(from, to);

    const blocked = [
      ...bookedAppointments,
      ...(schedule?.timeOff.map((t) => ({
        slotStart: t.startsAt,
        slotEnd: t.endsAt,
      })) ?? []),
    ];
    const available = filterAvailableSlots(candidates, blocked);

    res.status(200).json({
      therapistId,
      slots: available.map((slot) => ({
        slotStart: slot.slotStart.toISOString(),
        slotEnd: slot.slotEnd.toISOString(),
      })),
    });
  })
);

appointmentRouter.post(
  '/',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (authReq.user.role !== 'PATIENT') {
      res.status(403).json({ message: 'Only patients can book appointments' });
      return;
    }

    const parsed = bookAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    if (!(await isTherapist(parsed.data.therapistId))) {
      res.status(404).json({ message: 'Therapist not found' });
      return;
    }

    try {
      const appointment = await bookAppointmentWithLock(
        authReq.user.userId,
        parsed.data
      );
      res.status(201).json(serializeAppointment(appointment));
    } catch (error) {
      if (isSlotConflictError(error)) {
        res.status(409).json({ message: 'Slot already booked' });
        return;
      }
      throw error;
    }
  })
);

appointmentRouter.get(
  '/mine',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (authReq.user.role !== 'PATIENT') {
      res.status(403).json({ message: 'Requires PATIENT role' });
      return;
    }

    const parsed = appointmentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit, status } = parsed.data;
    const skip = (page - 1) * limit;
    const where: Prisma.AppointmentWhereInput = {
      patientId: authReq.user.userId,
      ...(status ? { status } : {}),
    };

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { slotStart: 'desc' },
      }),
      prisma.appointment.count({ where }),
    ]);

    res.status(200).json({
      appointments: appointments.map(serializeAppointment),
      total,
      page,
      limit,
    });
  })
);

appointmentRouter.get(
  '/schedule',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = therapistScheduleQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit, date } = parsed.data;
    const skip = (page - 1) * limit;

    const where: Prisma.AppointmentWhereInput = {
      therapistId: authReq.user.userId,
    };

    if (date) {
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      const dayEnd = new Date(`${date}T23:59:59.999Z`);
      where.slotStart = { gte: dayStart, lte: dayEnd };
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { slotStart: 'asc' },
      }),
      prisma.appointment.count({ where }),
    ]);

    res.status(200).json({
      appointments: appointments.map(serializeAppointment),
      total,
      page,
      limit,
    });
  })
);

// GET own schedule for editing (working hours + upcoming time-off).
// Distinct from GET /availability/:therapistId above, which computes
// bookable SLOTS for a patient — this returns the raw configuration a
// therapist edits, including days/windows with no upcoming bookable slots.
appointmentRouter.get(
  '/availability',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const schedule = await prisma.therapistSchedule.findUnique({
      where: { therapistId: authReq.user.userId },
      include: {
        workingHours: {
          orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
        },
        timeOff: {
          where: { endsAt: { gt: new Date() } },
          orderBy: { startsAt: 'asc' },
        },
      },
    });

    res.status(200).json({
      timezone: schedule?.timezone ?? 'Africa/Kigali',
      workingHours:
        schedule?.workingHours.map((w) => ({
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })) ?? [],
      timeOff:
        schedule?.timeOff.map((t) => ({
          id: t.id,
          startsAt: t.startsAt.toISOString(),
          endsAt: t.endsAt.toISOString(),
          reason: t.reason,
        })) ?? [],
    });
  })
);

// Full replace of the working-hours list, upserting the TherapistSchedule
// header row lazily on first use — see the schema comment on
// TherapistSchedule for why there's no separate "set up availability" step.
appointmentRouter.put(
  '/availability',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = updateAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const therapistId = authReq.user.userId;
    const { timezone, workingHours } = parsed.data;

    // Delete-and-recreate, in one transaction — the weekly schedule is
    // small (at most 50 windows) and always sent in full by the client
    // (updateAvailabilitySchema, above), so there's no partial-update
    // case to reconcile against.
    await prisma.$transaction([
      prisma.therapistSchedule.upsert({
        where: { therapistId },
        create: { therapistId, timezone },
        update: { timezone },
      }),
      prisma.therapistWorkingHours.deleteMany({ where: { therapistId } }),
      prisma.therapistWorkingHours.createMany({
        data: workingHours.map((w) => ({
          therapistId,
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
      }),
    ]);

    res.status(200).json({ timezone, workingHours });
  })
);

appointmentRouter.get(
  '/time-off',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const timeOff = await prisma.therapistTimeOff.findMany({
      where: {
        therapistId: authReq.user.userId,
        endsAt: { gt: new Date() },
      },
      orderBy: { startsAt: 'asc' },
    });

    res.status(200).json({
      timeOff: timeOff.map((t) => ({
        id: t.id,
        startsAt: t.startsAt.toISOString(),
        endsAt: t.endsAt.toISOString(),
        reason: t.reason,
      })),
    });
  })
);

appointmentRouter.post(
  '/time-off',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = createTimeOffSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const therapistId = authReq.user.userId;

    // Time-off references the schedule header row (FK) — ensure it exists
    // even for a therapist who has never touched PUT /availability.
    await prisma.therapistSchedule.upsert({
      where: { therapistId },
      create: { therapistId },
      update: {},
    });

    const timeOff = await prisma.therapistTimeOff.create({
      data: {
        therapistId,
        startsAt: parsed.data.startsAt,
        endsAt: parsed.data.endsAt,
        reason: parsed.data.reason,
      },
    });

    res.status(201).json({
      id: timeOff.id,
      startsAt: timeOff.startsAt.toISOString(),
      endsAt: timeOff.endsAt.toISOString(),
      reason: timeOff.reason,
    });
  })
);

appointmentRouter.delete(
  '/time-off/:id',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const timeOff = await prisma.therapistTimeOff.findUnique({
      where: { id: routeParam(req.params.id) },
    });
    if (!timeOff || timeOff.therapistId !== authReq.user.userId) {
      res.status(404).json({ message: 'Time off not found' });
      return;
    }

    await prisma.therapistTimeOff.delete({ where: { id: timeOff.id } });
    res.status(204).send();
  })
);

type PatientNameLookup = { id: string; userName: string | null };

// Same per-id internal lookup pattern as isTherapist() above — Appointment
// Service has no local view of patient_profiles, and page sizes here are
// small (max 50), so N parallel single-id calls is simpler than adding a
// new batch endpoint to User Service for this one caller.
async function resolvePatientNames(
  patientIds: string[]
): Promise<Map<string, string | null>> {
  const base = process.env.KONG_URL ?? 'http://localhost:8000';
  const entries = await Promise.all(
    patientIds.map(async (id): Promise<[string, string | null]> => {
      try {
        const res = await fetch(
          `${base}/internal/users/${encodeURIComponent(id)}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
            },
          }
        );
        if (!res.ok) return [id, null];
        const user = (await res.json()) as PatientNameLookup;
        return [id, user.userName ?? null];
      } catch {
        return [id, null];
      }
    })
  );
  return new Map(entries);
}

// Therapists only see patients they have an actual appointment relationship
// with (any status, including cancelled — same "evidence of contact" rule
// as the internal relationship-check endpoint below), never a raw list of
// platform patients. Grouped/paginated by Appointment, not by a patient
// table this service doesn't have.
appointmentRouter.get(
  '/patients',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = listPatientsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit } = parsed.data;
    const skip = (page - 1) * limit;
    const therapistId = authReq.user.userId;

    const [groups, allPatientIds] = await Promise.all([
      prisma.appointment.groupBy({
        by: ['patientId'],
        where: { therapistId },
        _count: { _all: true },
        _max: { slotStart: true },
        orderBy: { _max: { slotStart: 'desc' } },
        skip,
        take: limit,
      }),
      prisma.appointment.findMany({
        where: { therapistId },
        distinct: ['patientId'],
        select: { patientId: true },
      }),
    ]);

    const names = await resolvePatientNames(groups.map((g) => g.patientId));

    res.status(200).json({
      patients: groups.map((g) => ({
        patientId: g.patientId,
        userName: names.get(g.patientId) ?? null,
        totalSessions: g._count._all,
        lastSessionAt: g._max.slotStart?.toISOString() ?? null,
      })),
      total: allPatientIds.length,
      page,
      limit,
    });
  })
);

// Aggregate counts for the therapist dashboard overview — deliberately
// appointment-data-only (no cross-service calls) so this stays fast; a
// therapist's accepting-patients/profile status is shown from data the
// frontend already has via GET /users/me, not duplicated here.
appointmentRouter.get(
  '/dashboard',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const therapistId = authReq.user.userId;
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setUTCHours(23, 59, 59, 999);

    const [todaysSessions, pendingCount, upcomingCount, distinctPatients] =
      await Promise.all([
        prisma.appointment.findMany({
          where: {
            therapistId,
            status: 'CONFIRMED',
            slotStart: { gte: todayStart, lte: todayEnd },
          },
          orderBy: { slotStart: 'asc' },
        }),
        prisma.appointment.count({
          where: { therapistId, status: 'PENDING' },
        }),
        prisma.appointment.count({
          where: {
            therapistId,
            status: 'CONFIRMED',
            slotStart: { gt: now },
          },
        }),
        prisma.appointment.findMany({
          where: { therapistId },
          distinct: ['patientId'],
          select: { patientId: true },
        }),
      ]);

    res.status(200).json({
      todaysSessions: todaysSessions.map(serializeAppointment),
      pendingCount,
      upcomingCount,
      patientCount: distinctPatients.length,
    });
  })
);

appointmentRouter.put(
  '/:id/confirm',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: routeParam(req.params.id) },
    });
    if (!appointment) {
      res.status(404).json({ message: 'Appointment not found' });
      return;
    }

    if (appointment.therapistId !== authReq.user.userId) {
      res.status(403).json({ message: 'Not assigned to this appointment' });
      return;
    }

    if (appointment.status !== 'PENDING') {
      res
        .status(409)
        .json({ message: 'Appointment is not pending confirmation' });
      return;
    }

    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CONFIRMED' },
    });

    await publishAppointmentEvent(
      createAppointmentConfirmedEvent({
        appointmentId: updated.id,
        patientId: updated.patientId,
        therapistId: updated.therapistId,
        slotStart: updated.slotStart.toISOString(),
        slotEnd: updated.slotEnd.toISOString(),
        sessionType: updated.sessionType as AppointmentSessionType,
        confirmedByUserId: authReq.user.userId,
      }),
      config.rabbitUrl
    );

    res.status(200).json(serializeAppointment(updated));
  })
);

appointmentRouter.put(
  '/:id/cancel',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const parsed = cancelAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: routeParam(req.params.id) },
    });
    if (!appointment) {
      res.status(404).json({ message: 'Appointment not found' });
      return;
    }

    const isPatientOwner =
      authReq.user.role === 'PATIENT' &&
      appointment.patientId === authReq.user.userId;
    const isAssignedTherapist =
      authReq.user.role === 'THERAPIST' &&
      appointment.therapistId === authReq.user.userId;

    if (!isPatientOwner && !isAssignedTherapist) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    if (
      appointment.status === 'CANCELLED' ||
      appointment.status === 'COMPLETED'
    ) {
      res.status(409).json({ message: 'Appointment cannot be cancelled' });
      return;
    }

    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        status: 'CANCELLED',
        cancellationReason: parsed.data.cancellationReason,
      },
    });

    await publishAppointmentEvent(
      createAppointmentCancelledEvent({
        appointmentId: updated.id,
        patientId: updated.patientId,
        therapistId: updated.therapistId,
        slotStart: updated.slotStart.toISOString(),
        slotEnd: updated.slotEnd.toISOString(),
        sessionType: updated.sessionType as AppointmentSessionType,
        cancelledByUserId: authReq.user.userId,
        cancellationReason: parsed.data.cancellationReason,
      }),
      config.rabbitUrl
    );

    res.status(200).json(serializeAppointment(updated));
  })
);

appointmentRouter.put(
  '/:id/complete',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (authReq.user.role !== 'THERAPIST') {
      res.status(403).json({ message: 'Requires THERAPIST role' });
      return;
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: routeParam(req.params.id) },
    });
    if (!appointment) {
      res.status(404).json({ message: 'Appointment not found' });
      return;
    }

    if (appointment.therapistId !== authReq.user.userId) {
      res.status(403).json({ message: 'Not assigned to this appointment' });
      return;
    }

    if (appointment.status !== 'CONFIRMED') {
      res.status(409).json({ message: 'Appointment must be confirmed first' });
      return;
    }

    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'COMPLETED' },
    });

    await publishAppointmentEvent(
      createAppointmentCompletedEvent({
        appointmentId: updated.id,
        patientId: updated.patientId,
        therapistId: updated.therapistId,
        slotStart: updated.slotStart.toISOString(),
        slotEnd: updated.slotEnd.toISOString(),
        sessionType: updated.sessionType as AppointmentSessionType,
        completedByUserId: authReq.user.userId,
      }),
      config.rabbitUrl
    );

    res.status(200).json(serializeAppointment(updated));
  })
);

appointmentRouter.post(
  '/:id/rate',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (authReq.user.role !== 'PATIENT') {
      res.status(403).json({ message: 'Requires PATIENT role' });
      return;
    }

    const parsed = rateAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: routeParam(req.params.id) },
    });
    if (!appointment) {
      res.status(404).json({ message: 'Appointment not found' });
      return;
    }

    if (appointment.patientId !== authReq.user.userId) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    if (appointment.status !== 'COMPLETED') {
      res.status(422).json({
        message: 'Appointment must be completed before rating',
      });
      return;
    }

    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { rating: parsed.data.rating },
    });

    res.status(200).json(serializeAppointment(updated));
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as Auth/User
// Service's /internal/* routes. Backs Admin Service's platform analytics.
appointmentRouter.get(
  '/internal/appointments/analytics',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const parsed = analyticsRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const rangeFrom = parsed.data.from ?? thirtyDaysAgo;
    const rangeTo = parsed.data.to ?? now;

    // totalAppointments/completedAppointments stay all-time and unscoped by
    // range - existing consumer (admin-service's original GET /analytics).
    // Everything else below is scoped to [rangeFrom, rangeTo] and additive,
    // for the newer GET /analytics/detailed.
    const [
      totalAppointments,
      completedAppointments,
      statusBreakdownRaw,
      sessionTrendRaw,
    ] = await Promise.all([
      prisma.appointment.count(),
      prisma.appointment.count({ where: { status: 'COMPLETED' } }),
      prisma.appointment.groupBy({
        by: ['status'],
        where: { slotStart: { gte: rangeFrom, lte: rangeTo } },
        _count: { _all: true },
      }),
      prisma.$queryRaw<
        {
          bucket: Date;
          completed: bigint;
          cancelled: bigint;
          pending: bigint;
          confirmed: bigint;
        }[]
      >`
        SELECT
          date_trunc('day', "slot_start") AS bucket,
          COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::bigint AS completed,
          COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::bigint AS cancelled,
          COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS pending,
          COUNT(*) FILTER (WHERE "status" = 'CONFIRMED')::bigint AS confirmed
        FROM "appointments"
        WHERE "slot_start" >= ${rangeFrom} AND "slot_start" <= ${rangeTo}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    ]);

    const statusBreakdown = Object.fromEntries(
      statusBreakdownRaw.map((r) => [r.status, r._count._all])
    );
    const rangeTotal = statusBreakdownRaw.reduce(
      (sum, r) => sum + r._count._all,
      0
    );
    const rangeCompleted = statusBreakdown.COMPLETED ?? 0;
    const rangeCancelled = statusBreakdown.CANCELLED ?? 0;

    res.status(200).json({
      totalAppointments,
      completedAppointments,
      statusBreakdown,
      completionRate: rangeTotal > 0 ? rangeCompleted / rangeTotal : 0,
      cancellationRate: rangeTotal > 0 ? rangeCancelled / rangeTotal : 0,
      sessionTrend: sessionTrendRaw.map((r) => ({
        date: r.bucket.toISOString().slice(0, 10),
        completed: Number(r.completed),
        cancelled: Number(r.cancelled),
        pending: Number(r.pending),
        confirmed: Number(r.confirmed),
      })),
    });
  })
);

// INTERNAL SERVICE ENDPOINT — paginated appointment register for Admin Service.
// Only the SERVICE role can call this endpoint; end-user admin JWTs are never
// accepted directly by the appointment database service.
appointmentRouter.get(
  '/internal/appointments/list',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const parsed = appointmentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit, status } = parsed.data;
    const where: Prisma.AppointmentWhereInput = status ? { status } : {};
    const skip = (page - 1) * limit;
    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { slotStart: 'desc' },
      }),
      prisma.appointment.count({ where }),
    ]);

    res.status(200).json({
      appointments: appointments.map(serializeAppointment),
      total,
      page,
      limit,
    });
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as above.
// Lets another service (currently: mood-tracking-service's therapist mood
// report) verify that a therapist actually has a treatment relationship with
// a given patient before handing over that patient's data, the same way
// isTherapist() above lets this service verify a role it has no local copy
// of. Existence of any appointment row between the two, any status —
// including a cancelled one — is treated as evidence the therapist has
// legitimately been in contact with this patient.
appointmentRouter.get(
  '/internal/appointments/relationship/:therapistId/:patientId',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const therapistId = routeParam(req.params.therapistId);
    const patientId = routeParam(req.params.patientId);

    const appointment = await prisma.appointment.findFirst({
      where: { therapistId, patientId },
      select: { id: true },
    });

    res.status(200).json({ hasRelationship: appointment !== null });
  })
);
