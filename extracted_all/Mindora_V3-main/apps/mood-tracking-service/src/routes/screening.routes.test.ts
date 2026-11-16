import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.NODE_ENV = 'test';
  process.env.SCREENING_ENCRYPTION_KEY =
    'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
});

const mockScreeningCreate = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    screeningResult: {
      create: (...args: unknown[]) => mockScreeningCreate(...args),
    },
    moodEntry: {},
  },
}));

vi.mock('../middleware/authenticate.js', () => ({
  verifyJwt: (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    try {
      const decoded = jwt.verify(
        header.slice('Bearer '.length),
        process.env.JWT_SECRET!,
        {
          issuer: process.env.JWT_ISSUER,
        }
      );
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

import { createApp } from '../app.js';
import { decryptScreeningAnswers } from '../lib/screening-crypto.js';

const patientId = '11111111-1111-4111-8111-111111111111';
const otherPatientId = '22222222-2222-4222-8222-222222222222';

function token(role = 'PATIENT', subject = patientId) {
  return jwt.sign(
    { sub: subject, email: 'patient@example.com', role },
    process.env.JWT_SECRET!,
    {
      expiresIn: '15m',
      issuer: process.env.JWT_ISSUER,
      jwtid: randomUUID(),
    }
  );
}

function validAnswers(count = 7) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [index, 1])
  );
}

function savedResult(data: Record<string, unknown>) {
  const timestamp = new Date('2026-11-15T12:00:00.000Z');
  return { ...data, completedAt: timestamp, createdAt: timestamp };
}

describe('POST /screenings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCREENING_ENCRYPTION_KEY =
      'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
    mockScreeningCreate.mockImplementation(({ data }) =>
      Promise.resolve(savedResult(data))
    );
  });

  it('requires an authenticated patient', async () => {
    const app = createApp();
    const missing = await request(app)
      .post('/screenings')
      .send({ instrumentId: 'gad7', answers: validAnswers() });
    expect(missing.status).toBe(401);

    const therapist = await request(app)
      .post('/screenings')
      .set('Authorization', `Bearer ${token('THERAPIST')}`)
      .send({ instrumentId: 'gad7', answers: validAnswers() });
    expect(therapist.status).toBe(403);
    expect(mockScreeningCreate).not.toHaveBeenCalled();
  });

  it('rejects unknown instruments, incomplete/invalid answers, and client scores or patient IDs', async () => {
    const app = createApp();
    const auth = { Authorization: `Bearer ${token()}` };
    const invalidInstrument = await request(app)
      .post('/screenings')
      .set(auth)
      .send({ instrumentId: 'unknown', answers: validAnswers() });
    const incomplete = await request(app)
      .post('/screenings')
      .set(auth)
      .send({ instrumentId: 'gad7', answers: { 0: 1 } });
    const outOfRange = await request(app)
      .post('/screenings')
      .set(auth)
      .send({ instrumentId: 'gad7', answers: { ...validAnswers(), 6: 4 } });
    const extraIndex = await request(app)
      .post('/screenings')
      .set(auth)
      .send({ instrumentId: 'gad7', answers: { ...validAnswers(), 7: 0 } });
    const clientScore = await request(app)
      .post('/screenings')
      .set(auth)
      .send({ instrumentId: 'gad7', answers: validAnswers(), rawScore: 1 });
    const clientPatient = await request(app)
      .post('/screenings')
      .set(auth)
      .send({
        instrumentId: 'gad7',
        answers: validAnswers(),
        patientId: otherPatientId,
      });

    expect(invalidInstrument.status).toBe(400);
    expect(incomplete.status).toBe(400);
    expect(outOfRange.status).toBe(400);
    expect(extraIndex.status).toBe(400);
    expect(clientScore.status).toBe(400);
    expect(clientPatient.status).toBe(400);
    expect(mockScreeningCreate).not.toHaveBeenCalled();
  });

  it('persists encrypted answers under the JWT patient and returns the saved result only', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/screenings')
      .set('Authorization', `Bearer ${token('PATIENT', patientId)}`)
      .send({ instrumentId: 'gad7', answers: validAnswers() });

    expect(response.status).toBe(201);
    const createData = mockScreeningCreate.mock.calls[0][0].data;
    expect(createData.userId).toBe(patientId);
    expect(createData.instrumentId).toBe('gad7');
    expect(createData.scoringVersion).toBe('public-screenings-v1');
    expect(createData.rawScore).toBe(7);
    expect(createData.severity).toBe('Mild');
    expect(createData.answersEncrypted).not.toContain(
      JSON.stringify(validAnswers())
    );
    expect(decryptScreeningAnswers(createData.answersEncrypted)).toEqual(
      validAnswers()
    );
    expect(response.body).toMatchObject({
      patientId,
      instrumentId: 'gad7',
      scoringVersion: 'public-screenings-v1',
      rawScore: 7,
      displayScore: '7',
      maxScore: '21',
      severity: 'Mild',
      label: 'Mild Anxiety',
      completedAt: '2026-11-15T12:00:00.000Z',
      createdAt: '2026-11-15T12:00:00.000Z',
    });
    expect(response.body).not.toHaveProperty('answers');
    expect(response.body).not.toHaveProperty('answersEncrypted');
    expect(response.body).not.toHaveProperty('extras');
  });

  it('does not persist when the dedicated encryption key is missing', async () => {
    delete process.env.SCREENING_ENCRYPTION_KEY;
    const app = createApp();
    const response = await request(app)
      .post('/screenings')
      .set('Authorization', `Bearer ${token()}`)
      .send({ instrumentId: 'gad7', answers: validAnswers() });

    expect(response.status).toBe(503);
    expect(mockScreeningCreate).not.toHaveBeenCalled();
  });
});
