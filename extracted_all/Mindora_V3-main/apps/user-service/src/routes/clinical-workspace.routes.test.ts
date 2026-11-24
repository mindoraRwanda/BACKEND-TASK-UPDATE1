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
  process.env.KONG_URL = 'http://kong.test';
  process.env.INTERNAL_SERVICE_TOKEN = 'service-token-test';
});

const mockPrescriptionCreate = vi.fn();
const mockPrescriptionFindUnique = vi.fn();
const mockPrescriptionFindMany = vi.fn();
const mockPrescriptionUpdate = vi.fn();
const mockMedicationCreate = vi.fn();
const mockMedicationFindUnique = vi.fn();
const mockMedicationFindMany = vi.fn();
const mockMedicationUpdate = vi.fn();
const mockAuditCreate = vi.fn();
const mockTransaction = vi.fn();
const mockIsBlacklisted = vi.fn();
const mockHttpGet = vi.fn();

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

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    therapistPrescriptionDraft: {
      create: (...args: unknown[]) => mockPrescriptionCreate(...args),
      findUnique: (...args: unknown[]) => mockPrescriptionFindUnique(...args),
      findMany: (...args: unknown[]) => mockPrescriptionFindMany(...args),
      update: (...args: unknown[]) => mockPrescriptionUpdate(...args),
    },
    medicationUpdateRequest: {
      create: (...args: unknown[]) => mockMedicationCreate(...args),
      findUnique: (...args: unknown[]) => mockMedicationFindUnique(...args),
      findMany: (...args: unknown[]) => mockMedicationFindMany(...args),
      update: (...args: unknown[]) => mockMedicationUpdate(...args),
    },
    clinicalWorkspaceAuditLog: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
    },
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

const patientId = '11111111-1111-4111-8111-111111111111';
const therapistId = '22222222-2222-4222-8222-222222222222';
const otherTherapistId = '33333333-3333-4333-8333-333333333333';

function tokenFor(role: 'PATIENT' | 'THERAPIST', userId: string) {
  return jwt.sign(
    { sub: userId, email: `${role.toLowerCase()}@example.com`, role },
    process.env.JWT_SECRET!,
    {
      expiresIn: '15m',
      issuer: process.env.JWT_ISSUER,
      jwtid: randomUUID(),
    }
  );
}

const patientToken = () => tokenFor('PATIENT', patientId);
const therapistToken = () => tokenFor('THERAPIST', therapistId);

function makeTransactionClient() {
  return {
    therapistPrescriptionDraft: {
      create: mockPrescriptionCreate,
      update: mockPrescriptionUpdate,
    },
    medicationUpdateRequest: {
      create: mockMedicationCreate,
      update: mockMedicationUpdate,
    },
    clinicalWorkspaceAuditLog: {
      create: mockAuditCreate,
    },
  };
}

describe('Clinical workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { hasRelationship: true },
    });
    mockAuditCreate.mockResolvedValue({ id: randomUUID() });
    mockTransaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: unknown) => Promise<unknown>;
      return callback(makeTransactionClient());
    });
  });

  it('creates an encrypted therapist prescription draft only for an assigned patient', async () => {
    const createdAt = new Date('2026-11-10T10:00:00.000Z');
    mockPrescriptionCreate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: '44444444-4444-4444-8444-444444444444',
        ...data,
        createdAt,
        updatedAt: createdAt,
      })
    );

    const app = createApp();
    const response = await request(app)
      .post('/api/v1/users/prescription-drafts')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        patientId,
        medicationName: 'Medicine name for test',
        strength: '10 mg',
        frequency: 'Once daily',
        instructions: 'Take with food',
      });

    expect(response.status).toBe(201);
    expect(response.body.prescriptionDraft).toMatchObject({
      patientId,
      therapistId,
      medicationName: 'Medicine name for test',
      strength: '10 mg',
      frequency: 'Once daily',
      instructions: 'Take with food',
      status: 'DRAFT',
    });

    const saved = mockPrescriptionCreate.mock.calls[0][0].data;
    expect(saved.encryptedPayload).not.toContain('Medicine name for test');
    expect(saved.encryptedPayload).not.toContain('Take with food');
    expect(saved.status).toBe('DRAFT');
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://kong.test',
      expect.stringContaining(
        `/internal/appointments/relationship/${therapistId}/${patientId}`
      ),
      expect.objectContaining({
        headers: { Authorization: 'Bearer service-token-test' },
      })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: therapistId,
          recordType: 'PRESCRIPTION_DRAFT',
          actionType: 'PRESCRIPTION_DRAFT_CREATED',
        }),
      })
    );
  });

  it('does not create a prescription draft without an existing appointment relationship', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { hasRelationship: false },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/v1/users/prescription-drafts')
      .set('Authorization', `Bearer ${therapistToken()}`)
      .send({
        patientId,
        medicationName: 'Medicine name',
        strength: '',
        frequency: '',
        instructions: '',
      });

    expect(response.status).toBe(403);
    expect(mockPrescriptionCreate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('prevents patients from creating therapist-only prescription drafts', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/v1/users/prescription-drafts')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        patientId,
        medicationName: 'Medicine name',
      });

    expect(response.status).toBe(403);
    expect(mockPrescriptionCreate).not.toHaveBeenCalled();
  });

  it('allows a patient to send an encrypted medication update to a therapist they have seen', async () => {
    const createdAt = new Date('2026-11-10T10:00:00.000Z');
    mockMedicationCreate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: '55555555-5555-4555-8555-555555555555',
        ...data,
        reviewedAt: null,
        reviewedBy: null,
        createdAt,
        updatedAt: createdAt,
      })
    );

    const app = createApp();
    const response = await request(app)
      .post('/api/v1/users/medication-updates')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        therapistId,
        medicationName: 'Medicine name for test',
        updateType: 'SIDE_EFFECT',
        note: 'A private patient note for testing',
      });

    expect(response.status).toBe(201);
    expect(response.body.medicationUpdate).toMatchObject({
      therapistId,
      patientId,
      medicationName: 'Medicine name for test',
      updateType: 'SIDE_EFFECT',
      note: 'A private patient note for testing',
      status: 'PENDING',
    });

    const saved = mockMedicationCreate.mock.calls[0][0].data;
    expect(saved.encryptedPayload).not.toContain('Medicine name for test');
    expect(saved.encryptedPayload).not.toContain(
      'A private patient note for testing'
    );
    expect(saved.status).toBe('PENDING');
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://kong.test',
      expect.stringContaining(
        `/internal/appointments/relationship/${therapistId}/${patientId}`
      ),
      expect.any(Object)
    );
  });

  it('rejects patient medication updates for a therapist without an appointment relationship', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { hasRelationship: false },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/v1/users/medication-updates')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        therapistId: otherTherapistId,
        medicationName: 'Medicine name',
        updateType: 'CHANGED',
        note: '',
      });

    expect(response.status).toBe(403);
    expect(mockMedicationCreate).not.toHaveBeenCalled();
  });

  it('returns 503 rather than storing clinical text when encryption is not configured', async () => {
    const original = process.env.THERAPIST_CARE_PLAN_ENCRYPTION_KEY;
    delete process.env.THERAPIST_CARE_PLAN_ENCRYPTION_KEY;

    try {
      const app = createApp();
      const response = await request(app)
        .post('/api/v1/users/prescription-drafts')
        .set('Authorization', `Bearer ${therapistToken()}`)
        .send({
          patientId,
          medicationName: 'Medicine name',
          strength: '',
          frequency: '',
          instructions: '',
        });

      expect(response.status).toBe(503);
      expect(mockPrescriptionCreate).not.toHaveBeenCalled();
    } finally {
      process.env.THERAPIST_CARE_PLAN_ENCRYPTION_KEY = original;
    }
  });

  it('does not expose an endpoint to issue or dispense a prescription draft', async () => {
    const app = createApp();
    const response = await request(app)
      .post(
        '/api/v1/users/prescription-drafts/44444444-4444-4444-8444-444444444444/issue'
      )
      .set('Authorization', `Bearer ${therapistToken()}`);

    expect(response.status).toBe(404);
  });
});
