import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.NODE_ENV = 'test';
});

vi.mock('ioredis', () => {
  const Redis = vi.fn(function () {
    return {
      status: 'ready',
      connect: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
    };
  });
  return { default: Redis };
});

const mockAppointmentFindMany = vi.fn();
const mockAppointmentFindUnique = vi.fn();
const mockAppointmentFindFirst = vi.fn();
const mockAppointmentCount = vi.fn();
const mockAppointmentCreate = vi.fn();
const mockAppointmentUpdate = vi.fn();
const mockAppointmentGroupBy = vi.fn();
const mockQueryRaw = vi.fn();
const mockTransaction = vi.fn();
const mockPublishAppointmentEvent = vi.fn();
const mockIsBlacklisted = vi.fn();
const mockScheduleFindUnique = vi.fn();
const mockScheduleUpsert = vi.fn();
const mockWorkingHoursDeleteMany = vi.fn();
const mockWorkingHoursCreateMany = vi.fn();
const mockTimeOffFindMany = vi.fn();
const mockTimeOffFindUnique = vi.fn();
const mockTimeOffCreate = vi.fn();
const mockTimeOffDelete = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    appointment: {
      findMany: (...args: unknown[]) => mockAppointmentFindMany(...args),
      findUnique: (...args: unknown[]) => mockAppointmentFindUnique(...args),
      findFirst: (...args: unknown[]) => mockAppointmentFindFirst(...args),
      count: (...args: unknown[]) => mockAppointmentCount(...args),
      create: (...args: unknown[]) => mockAppointmentCreate(...args),
      update: (...args: unknown[]) => mockAppointmentUpdate(...args),
      groupBy: (...args: unknown[]) => mockAppointmentGroupBy(...args),
    },
    therapistSchedule: {
      findUnique: (...args: unknown[]) => mockScheduleFindUnique(...args),
      upsert: (...args: unknown[]) => mockScheduleUpsert(...args),
    },
    therapistWorkingHours: {
      deleteMany: (...args: unknown[]) => mockWorkingHoursDeleteMany(...args),
      createMany: (...args: unknown[]) => mockWorkingHoursCreateMany(...args),
    },
    therapistTimeOff: {
      findMany: (...args: unknown[]) => mockTimeOffFindMany(...args),
      findUnique: (...args: unknown[]) => mockTimeOffFindUnique(...args),
      create: (...args: unknown[]) => mockTimeOffCreate(...args),
      delete: (...args: unknown[]) => mockTimeOffDelete(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../middleware/authenticate.js', () => ({
  verifyJwt: (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    try {
      const token = header.slice('Bearer '.length);
      const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
        issuer: process.env.JWT_ISSUER,
      });
      if (typeof decoded === 'string' || !decoded.sub) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      req.user = {
        userId: decoded.sub,
        email: String(decoded.email ?? ''),
        role: String(decoded.role ?? ''),
      };
      next();
    } catch {
      res.status(401).json({ message: 'Unauthorized' });
    }
  },
}));

vi.mock('@mindora/auth-middleware', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@mindora/auth-middleware')>();
  return {
    ...actual,
    isTokenBlacklisted: (...args: unknown[]) => mockIsBlacklisted(...args),
  };
});

vi.mock('../lib/publish-appointment-event.js', () => ({
  publishAppointmentEvent: (...args: unknown[]) =>
    mockPublishAppointmentEvent(...args),
}));

import { createApp } from '../app.js';
import { SlotConflictError } from '../lib/book-appointment.js';

const patientId = '11111111-1111-4111-8111-111111111111';
const therapistId = '22222222-2222-4222-8222-222222222222';
const appointmentId = '33333333-3333-4333-8333-333333333333';

function patientToken() {
  return jwt.sign(
    {
      sub: patientId,
      email: 'patient@example.com',
      role: 'PATIENT',
    },
    process.env.JWT_SECRET!,
    {
      expiresIn: '15m',
      issuer: process.env.JWT_ISSUER,
      jwtid: randomUUID(),
    }
  );
}

function therapistToken() {
  return jwt.sign(
    {
      sub: therapistId,
      email: 'therapist@example.com',
      role: 'THERAPIST',
    },
    process.env.JWT_SECRET!,
    {
      expiresIn: '15m',
      issuer: process.env.JWT_ISSUER,
      jwtid: randomUUID(),
    }
  );
}

function serviceToken() {
  return jwt.sign(
    {
      sub: 'admin-service',
      email: 'service@mindora.internal',
      role: 'SERVICE',
    },
    process.env.JWT_SECRET!,
    {
      expiresIn: '15m',
      issuer: process.env.JWT_ISSUER,
      jwtid: randomUUID(),
    }
  );
}

function sampleAppointment(overrides: Record<string, unknown> = {}) {
  const slotStart = new Date('2026-06-10T10:00:00.000Z');
  const slotEnd = new Date('2026-06-10T11:00:00.000Z');
  return {
    id: appointmentId,
    patientId,
    therapistId,
    slotStart,
    slotEnd,
    sessionType: 'VIDEO',
    status: 'PENDING',
    cancellationReason: null,
    rating: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('POST /', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: therapistId,
        email: 'therapist@example.com',
        role: 'THERAPIST',
      }),
    });
    mockPublishAppointmentEvent.mockResolvedValue(undefined);
  });

  it('books an appointment successfully', async () => {
    const created = sampleAppointment();
    mockTransaction.mockImplementation(async (callback) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        $queryRaw: vi.fn().mockResolvedValue([]),
        appointment: {
          create: vi.fn().mockResolvedValue(created),
        },
      };
      return callback(tx);
    });

    const app = createApp();
    const response = await request(app)
      .post('/')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        therapistId,
        slotStart: '2026-06-10T10:00:00.000Z',
        slotEnd: '2026-06-10T11:00:00.000Z',
        sessionType: 'VIDEO',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(appointmentId);
    expect(response.body.status).toBe('PENDING');
    expect(mockPublishAppointmentEvent).toHaveBeenCalledOnce();
  });

  it('returns 409 when slot is already booked', async () => {
    mockTransaction.mockImplementation(async (callback) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'existing' }]),
        appointment: {
          create: vi.fn(),
        },
      };
      return callback(tx);
    });

    const app = createApp();
    const response = await request(app)
      .post('/')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        therapistId,
        slotStart: '2026-06-10T10:00:00.000Z',
        slotEnd: '2026-06-10T11:00:00.000Z',
        sessionType: 'VIDEO',
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Slot already booked');
  });
});

describe('PUT /:id/confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('confirms a pending appointment as therapist', async () => {
    mockAppointmentFindUnique.mockResolvedValue(sampleAppointment());
    mockAppointmentUpdate.mockResolvedValue(
      sampleAppointment({ status: 'CONFIRMED' })
    );

    const app = createApp();
    const response = await request(app)
      .put(`/${appointmentId}/confirm`)
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CONFIRMED');
    expect(mockPublishAppointmentEvent).toHaveBeenCalledOnce();
  });

  it('rejects non-therapist with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .put(`/${appointmentId}/confirm`)
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
  });
});

describe('PUT /:id/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('cancels as patient owner', async () => {
    mockAppointmentFindUnique.mockResolvedValue(sampleAppointment());
    mockAppointmentUpdate.mockResolvedValue(
      sampleAppointment({
        status: 'CANCELLED',
        cancellationReason: 'Schedule conflict',
      })
    );

    const app = createApp();
    const response = await request(app)
      .put(`/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ cancellationReason: 'Schedule conflict' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
    expect(mockPublishAppointmentEvent).toHaveBeenCalledOnce();
  });

  it('cancels as assigned therapist', async () => {
    mockAppointmentFindUnique.mockResolvedValue(sampleAppointment());
    mockAppointmentUpdate.mockResolvedValue(
      sampleAppointment({
        status: 'CANCELLED',
        cancellationReason: 'Therapist unavailable',
      })
    );

    const app = createApp();
    const response = await request(app)
      .put(`/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({ cancellationReason: 'Therapist unavailable' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
  });
});

describe('POST /:id/rate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('rates a completed appointment', async () => {
    mockAppointmentFindUnique.mockResolvedValue(
      sampleAppointment({ status: 'COMPLETED' })
    );
    mockAppointmentUpdate.mockResolvedValue(
      sampleAppointment({ status: 'COMPLETED', rating: 4 })
    );

    const app = createApp();
    const response = await request(app)
      .post(`/${appointmentId}/rate`)
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ rating: 4 });

    expect(response.status).toBe(200);
    expect(response.body.rating).toBe(4);
  });

  it('returns 422 when appointment is not completed', async () => {
    mockAppointmentFindUnique.mockResolvedValue(sampleAppointment());

    const app = createApp();
    const response = await request(app)
      .post(`/${appointmentId}/rate`)
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ rating: 5 });

    expect(response.status).toBe(422);
    expect(response.body.message).toBe(
      'Appointment must be completed before rating'
    );
  });
});

describe('SlotConflictError', () => {
  it('is recognized as a slot conflict', () => {
    expect(new SlotConflictError().name).toBe('SlotConflictError');
  });
});

describe('GET /internal/appointments/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('returns totalAppointments and completedAppointments plus the range-scoped breakdown/trend', async () => {
    mockAppointmentCount.mockResolvedValueOnce(30).mockResolvedValueOnce(18);
    mockAppointmentGroupBy.mockResolvedValueOnce([
      { status: 'COMPLETED', _count: { _all: 5 } },
      { status: 'CANCELLED', _count: { _all: 2 } },
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      {
        bucket: new Date('2026-06-10T00:00:00.000Z'),
        completed: 5n,
        cancelled: 2n,
        pending: 0n,
        confirmed: 0n,
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .get('/internal/appointments/analytics')
      .set('Authorization', `Bearer ${serviceToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalAppointments: 30,
      completedAppointments: 18,
      statusBreakdown: { COMPLETED: 5, CANCELLED: 2 },
      completionRate: 5 / 7,
      cancellationRate: 2 / 7,
      sessionTrend: [
        {
          date: '2026-06-10',
          completed: 5,
          cancelled: 2,
          pending: 0,
          confirmed: 0,
        },
      ],
    });
    expect(mockAppointmentCount).toHaveBeenCalledTimes(2);
    expect(mockAppointmentCount.mock.calls[1]?.[0]).toEqual({
      where: { status: 'COMPLETED' },
    });
  });

  it('rejects a non-SERVICE (PATIENT) token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/internal/appointments/analytics')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockAppointmentCount).not.toHaveBeenCalled();
  });

  it('rejects a request with no token with 401', async () => {
    const app = createApp();
    const response = await request(app).get('/internal/appointments/analytics');

    expect(response.status).toBe(401);
  });
});

describe('GET /internal/appointments/relationship/:therapistId/:patientId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('returns hasRelationship: true when an appointment exists between the two', async () => {
    mockAppointmentFindFirst.mockResolvedValueOnce({ id: 'appt-1' });

    const app = createApp();
    const response = await request(app)
      .get('/internal/appointments/relationship/therapist-1/patient-1')
      .set('Authorization', `Bearer ${serviceToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hasRelationship: true });
    expect(mockAppointmentFindFirst).toHaveBeenCalledWith({
      where: { therapistId: 'therapist-1', patientId: 'patient-1' },
      select: { id: true },
    });
  });

  it('returns hasRelationship: false when no appointment exists between the two', async () => {
    mockAppointmentFindFirst.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await request(app)
      .get('/internal/appointments/relationship/therapist-1/patient-1')
      .set('Authorization', `Bearer ${serviceToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hasRelationship: false });
  });

  it('rejects a non-SERVICE (PATIENT) token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/internal/appointments/relationship/therapist-1/patient-1')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockAppointmentFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a request with no token with 401', async () => {
    const app = createApp();
    const response = await request(app).get(
      '/internal/appointments/relationship/therapist-1/patient-1'
    );

    expect(response.status).toBe(401);
  });
});

describe('GET /availability (own schedule)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('returns the default timezone and empty lists when no schedule exists yet', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await request(app)
      .get('/availability')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      timezone: 'Africa/Kigali',
      workingHours: [],
      timeOff: [],
    });
  });

  it('returns the configured schedule', async () => {
    mockScheduleFindUnique.mockResolvedValueOnce({
      therapistId,
      timezone: 'Africa/Kigali',
      workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
      timeOff: [
        {
          id: 'off-1',
          startsAt: new Date('2026-07-01T00:00:00.000Z'),
          endsAt: new Date('2026-07-03T00:00:00.000Z'),
          reason: 'Vacation',
        },
      ],
    });

    const app = createApp();
    const response = await request(app)
      .get('/availability')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.workingHours).toEqual([
      { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
    ]);
    expect(response.body.timeOff[0]).toMatchObject({
      id: 'off-1',
      reason: 'Vacation',
    });
  });

  it('rejects a PATIENT-role token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/availability')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockScheduleFindUnique).not.toHaveBeenCalled();
  });
});

describe('PUT /availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
    // PUT /availability uses the array form of $transaction (each op is
    // already a live promise from the mocks below by the time it's
    // collected into the array) — unlike POST /'s interactive-callback
    // form mocked elsewhere in this file, so this needs its own
    // implementation, set fresh per test since mockImplementation isn't
    // cleared by vi.clearAllMocks().
    mockTransaction.mockImplementation(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : ops
    );
    mockScheduleUpsert.mockResolvedValue({
      therapistId,
      timezone: 'Africa/Kigali',
    });
    mockWorkingHoursDeleteMany.mockResolvedValue({ count: 0 });
    mockWorkingHoursCreateMany.mockResolvedValue({ count: 1 });
  });

  it('replaces the working-hours list', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/availability')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        timezone: 'Africa/Kigali',
        workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
      });

    expect(response.status).toBe(200);
    expect(mockWorkingHoursDeleteMany).toHaveBeenCalledWith({
      where: { therapistId },
    });
    expect(mockWorkingHoursCreateMany).toHaveBeenCalledWith({
      data: [{ therapistId, dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
    });
  });

  it('400s when endMinute is not after startMinute', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/availability')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        workingHours: [{ dayOfWeek: 1, startMinute: 600, endMinute: 500 }],
      });

    expect(response.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects a PATIENT-role token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/availability')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ workingHours: [] });

    expect(response.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('time off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('POST /time-off creates a block, ensuring the schedule row exists first', async () => {
    mockScheduleUpsert.mockResolvedValueOnce({ therapistId });
    mockTimeOffCreate.mockResolvedValueOnce({
      id: 'off-1',
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-03T00:00:00.000Z'),
      reason: 'Vacation',
    });

    const app = createApp();
    const response = await request(app)
      .post('/time-off')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-07-03T00:00:00.000Z',
        reason: 'Vacation',
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: 'off-1', reason: 'Vacation' });
    expect(mockScheduleUpsert).toHaveBeenCalled();
  });

  it('POST /time-off 400s when endsAt is not after startsAt', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/time-off')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        startsAt: '2026-07-03T00:00:00.000Z',
        endsAt: '2026-07-01T00:00:00.000Z',
      });

    expect(response.status).toBe(400);
    expect(mockTimeOffCreate).not.toHaveBeenCalled();
  });

  it('DELETE /time-off/:id 404s when the block belongs to a different therapist', async () => {
    mockTimeOffFindUnique.mockResolvedValueOnce({
      id: 'off-1',
      therapistId: 'someone-else',
    });

    const app = createApp();
    const response = await request(app)
      .delete('/time-off/off-1')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(404);
    expect(mockTimeOffDelete).not.toHaveBeenCalled();
  });

  it('DELETE /time-off/:id succeeds for the owning therapist', async () => {
    mockTimeOffFindUnique.mockResolvedValueOnce({ id: 'off-1', therapistId });
    mockTimeOffDelete.mockResolvedValueOnce({ id: 'off-1' });

    const app = createApp();
    const response = await request(app)
      .delete('/time-off/off-1')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(204);
  });
});

describe('GET /patients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('returns paginated patients with resolved names and never exposes patients with no relationship', async () => {
    mockAppointmentGroupBy.mockResolvedValueOnce([
      {
        patientId,
        _count: { _all: 3 },
        _max: { slotStart: new Date('2026-06-01T10:00:00.000Z') },
      },
    ]);
    mockAppointmentFindMany.mockResolvedValueOnce([{ patientId }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: patientId, userName: 'Jane Patient' }),
    });

    const app = createApp();
    const response = await request(app)
      .get('/patients')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      patients: [
        {
          patientId,
          userName: 'Jane Patient',
          totalSessions: 3,
          lastSessionAt: '2026-06-01T10:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
    expect(mockAppointmentGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { therapistId } })
    );
  });

  it('falls back to a null name when User Service is unreachable', async () => {
    mockAppointmentGroupBy.mockResolvedValueOnce([
      { patientId, _count: { _all: 1 }, _max: { slotStart: null } },
    ]);
    mockAppointmentFindMany.mockResolvedValueOnce([{ patientId }]);
    mockFetch.mockResolvedValueOnce({ ok: false });

    const app = createApp();
    const response = await request(app)
      .get('/patients')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.patients[0].userName).toBeNull();
  });

  it('rejects a PATIENT-role token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/patients')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockAppointmentGroupBy).not.toHaveBeenCalled();
  });
});

describe('GET /dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('aggregates today, pending, upcoming and patient counts', async () => {
    mockAppointmentFindMany
      .mockResolvedValueOnce([sampleAppointment()]) // todaysSessions
      .mockResolvedValueOnce([{ patientId }]); // distinct patients
    mockAppointmentCount
      .mockResolvedValueOnce(2) // pendingCount
      .mockResolvedValueOnce(5); // upcomingCount

    const app = createApp();
    const response = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.pendingCount).toBe(2);
    expect(response.body.upcomingCount).toBe(5);
    expect(response.body.patientCount).toBe(1);
    expect(response.body.todaysSessions).toHaveLength(1);
  });

  it('rejects a PATIENT-role token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
  });
});
