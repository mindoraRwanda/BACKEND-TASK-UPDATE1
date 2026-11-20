import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.NODE_ENV = 'test';
  process.env.THERAPIST_CARE_PLAN_ENCRYPTION_KEY =
    'unit-test-care-plan-encryption-key-32-characters';
});

vi.mock('ioredis', () => {
  const Redis = vi.fn(function () {
    return {
      status: 'ready' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
    };
  });
  return { default: Redis, Redis };
});

const mockCarePlanCreate = vi.fn();
const mockCarePlanFindMany = vi.fn();
const mockCarePlanFindUnique = vi.fn();
const mockCarePlanUpdate = vi.fn();
const mockPatientFindUnique = vi.fn();
const mockPatientUpdate = vi.fn();
const mockTherapistFindUnique = vi.fn();
const mockTherapistUpdate = vi.fn();
const mockTherapistFindMany = vi.fn();
const mockTherapistCount = vi.fn();
const mockTherapistApplicationGroupBy = vi.fn();
const mockQueryRaw = vi.fn();
const mockIsBlacklisted = vi.fn();
const mockHttpGet = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    therapistCarePlan: {
      create: (...args: unknown[]) => mockCarePlanCreate(...args),
      findMany: (...args: unknown[]) => mockCarePlanFindMany(...args),
      findUnique: (...args: unknown[]) => mockCarePlanFindUnique(...args),
      update: (...args: unknown[]) => mockCarePlanUpdate(...args),
    },
    patientProfile: {
      findUnique: (...args: unknown[]) => mockPatientFindUnique(...args),
      update: (...args: unknown[]) => mockPatientUpdate(...args),
    },
    therapistProfile: {
      findUnique: (...args: unknown[]) => mockTherapistFindUnique(...args),
      update: (...args: unknown[]) => mockTherapistUpdate(...args),
      findMany: (...args: unknown[]) => mockTherapistFindMany(...args),
      count: (...args: unknown[]) => mockTherapistCount(...args),
    },
    therapistApplication: {
      groupBy: (...args: unknown[]) => mockTherapistApplicationGroupBy(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

vi.mock('@mindora/http-client', () => ({
  httpClient: { get: (...args: unknown[]) => mockHttpGet(...args) },
  callService: vi.fn(),
}));

vi.mock('@mindora/auth-middleware', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@mindora/auth-middleware')>();
  return {
    ...actual,
    isTokenBlacklisted: (...args: unknown[]) => mockIsBlacklisted(...args),
  };
});

import { createApp } from '../app.js';

function patientToken(userId = 'patient-1') {
  return jwt.sign(
    {
      sub: userId,
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
    { sub: 'therapist-1', email: 'therapist@example.com', role: 'THERAPIST' },
    process.env.JWT_SECRET!,
    { expiresIn: '15m', issuer: process.env.JWT_ISSUER, jwtid: randomUUID() }
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

describe('Therapist care plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('creates an encrypted draft only for a therapist with an appointment relationship', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { hasRelationship: true },
    });
    mockCarePlanCreate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'plan-1',
        ...data,
        patientAcknowledgedAt: null,
        createdAt: new Date('2026-11-10T10:00:00.000Z'),
        updatedAt: new Date('2026-11-10T10:00:00.000Z'),
      })
    );

    const app = createApp();
    const response = await request(app)
      .post('/care-plans')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        patientId: '11111111-1111-4111-8111-111111111111',
        title: 'Stress management goals',
        goals: ['Build a regular sleep routine'],
        milestones: [
          {
            title: 'Review sleep routine',
            dueDate: '2026-11-20T00:00:00.000Z',
          },
        ],
        reviewDate: '2026-11-30T00:00:00.000Z',
      });

    expect(response.status).toBe(201);
    expect(response.body.carePlan).toMatchObject({
      id: 'plan-1',
      status: 'DRAFT',
      title: 'Stress management goals',
      goals: ['Build a regular sleep routine'],
    });
    const stored = mockCarePlanCreate.mock.calls[0][0].data;
    expect(stored.encryptedPayload).not.toContain('Stress management goals');
    expect(stored.therapistId).toBe('therapist-1');
    expect(mockHttpGet).toHaveBeenCalled();
  });

  it('does not create a care plan without a verified therapist-patient relationship', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { hasRelationship: false },
    });
    const app = createApp();
    const response = await request(app)
      .post('/care-plans')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        patientId: '11111111-1111-4111-8111-111111111111',
        title: 'Goals',
        goals: ['Goal one'],
      });

    expect(response.status).toBe(403);
    expect(mockCarePlanCreate).not.toHaveBeenCalled();
  });

  it('allows the owning patient to acknowledge a saved care-plan draft', async () => {
    const patientId = '11111111-1111-4111-8111-111111111111';
    const createdAt = new Date('2026-11-10T10:00:00.000Z');
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { hasRelationship: true },
    });
    mockCarePlanCreate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'plan-1',
        ...data,
        patientAcknowledgedAt: null,
        createdAt,
        updatedAt: createdAt,
      })
    );

    const app = createApp();
    const created = await request(app)
      .post('/care-plans')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        patientId,
        title: 'Wellbeing goals',
        goals: ['Build a regular routine'],
        milestones: [],
      });
    expect(created.status).toBe(201);

    const stored = mockCarePlanCreate.mock.calls[0][0].data;
    mockCarePlanFindUnique.mockResolvedValue({
      id: 'plan-1',
      ...stored,
      status: 'DRAFT',
      patientAcknowledgedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    mockCarePlanUpdate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'plan-1',
        ...stored,
        ...data,
        createdAt,
        updatedAt: new Date('2026-11-10T10:01:00.000Z'),
      })
    );

    const response = await request(app)
      .post('/care-plans/plan-1/acknowledge')
      .set('Authorization', `Bearer ${patientToken(patientId)}`);

    expect(response.status).toBe(200);
    expect(response.body.carePlan.status).toBe('ACTIVE');
    expect(response.body.carePlan.patientAcknowledgedAt).toBeTruthy();
  });
});

describe('GET /me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('returns patient profile', async () => {
    const profile = {
      id: 'profile-1',
      userId: 'patient-1',
      userName: 'Patient One',
      bio: 'Hello',
      timezone: 'Africa/Kigali',
      languagePreference: 'en',
    };
    mockPatientFindUnique.mockResolvedValue(profile);

    const app = createApp();
    const response = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ role: 'PATIENT', profile });
  });

  it('rejects missing auth with 401', async () => {
    const app = createApp();
    const response = await request(app).get('/me');

    expect(response.status).toBe(401);
  });
});

describe('PUT /me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('updates patient profile', async () => {
    const updated = {
      id: 'profile-1',
      userId: 'patient-1',
      userName: 'Updated Name',
      bio: 'New bio',
      timezone: 'UTC',
      languagePreference: 'fr',
    };
    mockPatientUpdate.mockResolvedValue(updated);

    const app = createApp();
    const response = await request(app)
      .put('/me')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        userName: 'Updated Name',
        bio: 'New bio',
        timezone: 'UTC',
        languagePreference: 'fr',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ role: 'PATIENT', profile: updated });
  });
});

describe('GET /therapists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
    mockTherapistFindMany.mockResolvedValue([
      { id: 't1', userName: 'Dr. A', isAcceptingPatients: true },
    ]);
    mockTherapistCount.mockResolvedValue(1);
  });

  it('returns paginated therapists', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/therapists?page=1&limit=10')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      therapists: [{ id: 't1', userName: 'Dr. A', isAcceptingPatients: true }],
      total: 1,
      page: 1,
      limit: 10,
    });
  });
});

describe('GET /internal/users/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('proxies to Auth Service and merges in the local therapist-application analytics — not shadowed by /internal/users/:id', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { totalUsers: 17, activeUsersLast30Days: 5 },
    });
    mockTherapistApplicationGroupBy.mockResolvedValueOnce([
      { status: 'APPROVED', _count: { _all: 3 } },
      { status: 'REJECTED', _count: { _all: 1 } },
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      { bucket: new Date('2026-06-10T00:00:00.000Z'), count: 2n },
    ]);
    mockTherapistCount
      .mockResolvedValueOnce(3) // totalTherapists (APPROVED, not suspended)
      .mockResolvedValueOnce(1); // suspendedTherapists

    const app = createApp();
    const response = await request(app)
      .get('/internal/users/analytics')
      .set('Authorization', `Bearer ${serviceToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalUsers: 17,
      activeUsersLast30Days: 5,
      totalTherapists: 3,
      suspendedTherapists: 1,
      therapistApplications: {
        byStatus: { APPROVED: 3, REJECTED: 1 },
        approvalRate: 3 / 4,
        rejectionRate: 1 / 4,
        applicationTrend: [{ date: '2026-06-10', count: 2 }],
      },
    });
    // If /internal/users/:id had shadowed this route (the exact bug found
    // live earlier — "analytics" matched as :id), httpClient.get would
    // never be called at all; that handler only queries prisma directly.
    expect(mockHttpGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('/internal/auth/analytics'),
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(mockPatientFindUnique).not.toHaveBeenCalled();
    expect(mockTherapistFindUnique).not.toHaveBeenCalled();
  });

  it('returns 503 when Auth Service is unreachable', async () => {
    mockHttpGet.mockResolvedValue({ ok: false, status: 503, data: null });
    mockTherapistApplicationGroupBy.mockResolvedValueOnce([]);
    mockQueryRaw.mockResolvedValueOnce([]);
    mockTherapistCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const app = createApp();
    const response = await request(app)
      .get('/internal/users/analytics')
      .set('Authorization', `Bearer ${serviceToken()}`);

    expect(response.status).toBe(503);
  });

  it('rejects a non-SERVICE (PATIENT) token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/internal/users/analytics')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockHttpGet).not.toHaveBeenCalled();
  });
});
