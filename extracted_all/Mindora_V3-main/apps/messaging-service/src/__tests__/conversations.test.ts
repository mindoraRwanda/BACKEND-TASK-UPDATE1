import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { Conversation } from '../models/Conversation.js';
import { encryptContent } from '../utils/encryption.js';

const request = supertest(app);

const TEST_SECRET = 'mindora-dev-jwt-secret-change-in-production';

// Patient is the requesting user for most tests
const patientToken = jwt.sign(
  { sub: 'patient-123', email: 'patient@mindora.com', role: 'PATIENT' },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'msg-jti-001' }
);

// Therapist is the other participant
const therapistToken = jwt.sign(
  { sub: 'therapist-456', email: 'therapist@mindora.com', role: 'THERAPIST' },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'msg-jti-002' }
);

// Unrelated third user — used to test 403 on GET /:id
const otherToken = jwt.sign(
  { sub: 'other-user-789', email: 'other@mindora.com', role: 'PATIENT' },
  TEST_SECRET,
  { expiresIn: '7d', issuer: 'mindora-auth', jwtid: 'msg-jti-003' }
);

const patientHeader = `Bearer ${patientToken}`;
const therapistHeader = `Bearer ${therapistToken}`;
const otherHeader = `Bearer ${otherToken}`;

beforeAll(async () => {
  await mongoose.connect(
    'mongodb://localhost:27017/mindora_messaging_conversations_test'
  );
});

beforeEach(async () => {
  await Conversation.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ─── POST /api/v1/messaging/conversations ────────────────────────────────────

describe('POST /api/v1/messaging/conversations', () => {
  it('creates a conversation between the authenticated user and participantId', async () => {
    const res = await request
      .post('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader)
      .send({ participantId: 'therapist-456' });

    expect(res.status).toBe(201);
    expect(res.body._id).toBeDefined();
    expect(res.body.participants).toContain('patient-123');
    expect(res.body.participants).toContain('therapist-456');
  });

  it('returns 200 with the existing conversation when one already exists', async () => {
    // First request creates it
    await request
      .post('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader)
      .send({ participantId: 'therapist-456' });

    // Second request returns the same one
    const res = await request
      .post('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader)
      .send({ participantId: 'therapist-456' });

    expect(res.status).toBe(200);
    expect(res.body._id).toBeDefined();
  });

  it('returns 400 when participantId is missing', async () => {
    const res = await request
      .post('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when participantId is an empty string', async () => {
    const res = await request
      .post('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader)
      .send({ participantId: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when trying to start a conversation with yourself', async () => {
    const res = await request
      .post('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader)
      .send({ participantId: 'patient-123' });

    expect(res.status).toBe(400);
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await request
      .post('/api/v1/messaging/conversations')
      .send({ participantId: 'therapist-456' });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/v1/messaging/conversations ─────────────────────────────────────

describe('GET /api/v1/messaging/conversations', () => {
  it('returns the list of conversations for the authenticated user', async () => {
    // Seed a conversation the patient is part of
    await Conversation.create({
      participants: ['patient-123', 'therapist-456'],
    });

    const res = await request
      .get('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('returns empty list when user has no conversations', async () => {
    const res = await request
      .get('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('decrypts lastMessage.content back to plaintext in the response', async () => {
    await Conversation.create({
      participants: ['patient-123', 'therapist-456'],
      lastMessage: {
        content: encryptContent('see you at 3pm'),
        senderId: 'therapist-456',
        sentAt: new Date(),
      },
    });

    const res = await request
      .get('/api/v1/messaging/conversations')
      .set('Authorization', patientHeader);

    expect(res.status).toBe(200);
    expect(res.body.conversations[0].lastMessage).toBe('see you at 3pm');
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await request.get('/api/v1/messaging/conversations');

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/v1/messaging/conversations/:id ─────────────────────────────────

describe('GET /api/v1/messaging/conversations/:id', () => {
  it('returns conversation history for a participant', async () => {
    const conv = await Conversation.create({
      participants: ['patient-123', 'therapist-456'],
    });

    const res = await request
      .get(`/api/v1/messaging/conversations/${conv._id}`)
      .set('Authorization', patientHeader);

    expect(res.status).toBe(200);
    expect(res.body.messages).toBeDefined();
    expect(res.body.nextCursor).toBeDefined();
  });

  it('allows the therapist participant to access conversation history', async () => {
    const conv = await Conversation.create({
      participants: ['patient-123', 'therapist-456'],
    });

    const res = await request
      .get(`/api/v1/messaging/conversations/${conv._id}`)
      .set('Authorization', therapistHeader);

    expect(res.status).toBe(200);
    expect(res.body.messages).toBeDefined();
  });

  it('returns 403 when the requesting user is not a participant', async () => {
    const conv = await Conversation.create({
      participants: ['patient-123', 'therapist-456'],
    });

    const res = await request
      .get(`/api/v1/messaging/conversations/${conv._id}`)
      .set('Authorization', otherHeader);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns 404 for a valid ObjectId that does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request
      .get(`/api/v1/messaging/conversations/${fakeId}`)
      .set('Authorization', patientHeader);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });

  it('returns 400 for a malformed ID', async () => {
    const res = await request
      .get('/api/v1/messaging/conversations/not-a-valid-id')
      .set('Authorization', patientHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid conversation ID');
  });

  it('returns 401 when no auth token is provided', async () => {
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request.get(`/api/v1/messaging/conversations/${fakeId}`);

    expect(res.status).toBe(401);
  });
});
