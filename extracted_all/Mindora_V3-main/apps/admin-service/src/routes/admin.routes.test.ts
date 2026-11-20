import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-service-token';
  process.env.KONG_URL = 'http://localhost:8000';
  process.env.NODE_ENV = 'test';
});

vi.mock('ioredis', () => {
  const Redis = vi.fn(function () {
    return {
      status: 'ready' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(0), // never blacklisted/suspended in these tests
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
    };
  });
  return { default: Redis, Redis };
});

const mockHttpGet = vi.fn();
const mockCallService = vi.fn();

vi.mock('@mindora/http-client', () => ({
  httpClient: { get: (...args: unknown[]) => mockHttpGet(...args) },
  callService: (...args: unknown[]) => mockCallService(...args),
  sanitizeForLog: (value: string) => value,
}));

const mockAuditCreate = vi.fn();
const mockAuditFindMany = vi.fn();
const mockAuditCount = vi.fn();
const mockAlertFindMany = vi.fn();
const mockAlertCount = vi.fn();
const mockAlertFindUnique = vi.fn();
const mockAlertUpdate = vi.fn();
const mockModerationCreate = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    audit_logs: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
      findMany: (...args: unknown[]) => mockAuditFindMany(...args),
      count: (...args: unknown[]) => mockAuditCount(...args),
    },
    system_alerts: {
      findMany: (...args: unknown[]) => mockAlertFindMany(...args),
      count: (...args: unknown[]) => mockAlertCount(...args),
      findUnique: (...args: unknown[]) => mockAlertFindUnique(...args),
      update: (...args: unknown[]) => mockAlertUpdate(...args),
    },
    moderation_decisions: {
      create: (...args: unknown[]) => mockModerationCreate(...args),
    },
  },
}));

import { createApp } from '../app.js';

const JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
const JWT_ISSUER = 'mindora-auth';

function adminToken(): string {
  return jwt.sign(
    { sub: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    JWT_SECRET,
    { issuer: JWT_ISSUER, expiresIn: '15m' }
  );
}

function patientToken(): string {
  return jwt.sign(
    { sub: 'patient-1', email: 'patient@example.com', role: 'PATIENT' },
    JWT_SECRET,
    { issuer: JWT_ISSUER, expiresIn: '15m' }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('role gate (requireAdmin, applied to every route below)', () => {
  it('rejects a request with no token at all with 401', async () => {
    const app = createApp();
    const response = await request(app).get('/users');

    expect(response.status).toBe(401);
  });

  it('rejects a non-admin (PATIENT) token with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required');
    expect(mockHttpGet).not.toHaveBeenCalled();
  });
});

describe('GET /users', () => {
  it('proxies to User Service and returns 200 with the user list', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        users: [
          {
            id: 'u1',
            email: 'a@example.com',
            role: 'PATIENT',
            isActive: true,
            createdAt: '2026-01-01',
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      },
    });

    const app = createApp();
    const response = await request(app)
      .get('/users?role=PATIENT&limit=5')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://localhost:8000',
      expect.stringContaining('/internal/users?'),
      { headers: { Authorization: 'Bearer test-internal-service-token' } }
    );
    const [, calledPath] = mockHttpGet.mock.calls[0] as [string, string];
    expect(calledPath).toContain('role=PATIENT');
    expect(calledPath).toContain('limit=5');
  });

  it('returns 400 for an invalid query parameter', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/users?role=NOT_A_ROLE')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(400);
    expect(mockHttpGet).not.toHaveBeenCalled();
  });

  it('returns 503 when User Service is unreachable', async () => {
    mockHttpGet.mockResolvedValue({ ok: false, status: 503, data: null });

    const app = createApp();
    const response = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(503);
  });
});

describe('GET /appointments', () => {
  it('returns the paginated register through the SERVICE-only Appointment Service route', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        appointments: [
          {
            id: 'appointment-1',
            patientId: 'patient-1',
            therapistId: 'therapist-1',
            slotStart: '2026-11-10T08:00:00.000Z',
            slotEnd: '2026-11-10T09:00:00.000Z',
            sessionType: 'VIDEO',
            status: 'CONFIRMED',
            createdAt: '2026-11-01T08:00:00.000Z',
            updatedAt: '2026-11-01T08:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      },
    });

    const app = createApp();
    const response = await request(app)
      .get('/appointments?status=CONFIRMED&page=1&limit=20')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.appointments[0].id).toBe('appointment-1');
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/internal/appointments/list?page=1&limit=20&status=CONFIRMED',
      { headers: { Authorization: 'Bearer test-internal-service-token' } }
    );
  });

  it('returns 400 for invalid status without calling the Appointment Service', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/appointments?status=NOT_A_STATUS')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(400);
    expect(mockHttpGet).not.toHaveBeenCalled();
  });

  it('returns 503 if Appointment Service is unavailable', async () => {
    mockHttpGet.mockResolvedValue({ ok: false, status: 503, data: null });

    const app = createApp();
    const response = await request(app)
      .get('/appointments')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(503);
  });
});

describe('PUT /users/:id/suspend', () => {
  it('suspends the user and writes an audit log entry only after the downstream call succeeds', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 200,
      data: { message: 'User suspended', userId: 'u1' },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-1' });

    const app = createApp();
    const response = await request(app)
      .put('/users/u1/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'policy violation' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'User suspended',
      userId: 'u1',
      auditLogId: 'audit-1',
    });
    expect(mockCallService).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/internal/users/u1/suspend',
      expect.objectContaining({
        method: 'PUT',
        body: { reason: 'policy violation' },
        headers: { Authorization: 'Bearer test-internal-service-token' },
      })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        actionType: 'USER_SUSPENDED',
        targetId: 'u1',
        metadata: expect.objectContaining({ reason: 'policy violation' }),
      }),
    });
  });

  it('returns 400 and never calls User Service when reason is missing', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/users/u1/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});

    expect(response.status).toBe(400);
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it('returns 404 and does NOT write an audit log when the user does not exist', async () => {
    mockCallService.mockResolvedValue({ ok: false, status: 404, data: null });

    const app = createApp();
    const response = await request(app)
      .put('/users/does-not-exist/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'policy violation' });

    expect(response.status).toBe(404);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('returns 503 and does NOT write an audit log when User Service is unreachable', async () => {
    mockCallService.mockResolvedValue({ ok: false, status: 503, data: null });

    const app = createApp();
    const response = await request(app)
      .put('/users/u1/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'policy violation' });

    expect(response.status).toBe(503);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller with 403 before touching User Service', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/users/u1/suspend')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ reason: 'policy violation' });

    expect(response.status).toBe(403);
    expect(mockCallService).not.toHaveBeenCalled();
  });
});

describe('PUT /users/:id/reactivate', () => {
  it('reactivates the user and writes a USER_REACTIVATED audit log entry', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 200,
      data: { message: 'User reactivated', userId: 'u1' },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-2' });

    const app = createApp();
    const response = await request(app)
      .put('/users/u1/reactivate')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'appeal approved' });

    expect(response.status).toBe(200);
    expect(response.body.auditLogId).toBe('audit-2');
    expect(mockCallService).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/internal/users/u1/reactivate',
      expect.objectContaining({
        method: 'PUT',
        body: { reason: 'appeal approved' },
      })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'USER_REACTIVATED',
        targetId: 'u1',
      }),
    });
  });

  it('returns 404 and does NOT write an audit log when the user does not exist', async () => {
    mockCallService.mockResolvedValue({ ok: false, status: 404, data: null });

    const app = createApp();
    const response = await request(app)
      .put('/users/does-not-exist/reactivate')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'appeal approved' });

    expect(response.status).toBe(404);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('GET /audit-log', () => {
  it('returns paginated entries', async () => {
    mockAuditFindMany.mockResolvedValue([
      {
        id: 'a1',
        adminId: 'admin-1',
        actionType: 'USER_SUSPENDED',
        targetId: 'u1',
        metadata: {},
        createdAt: new Date(),
      },
    ]);
    mockAuditCount.mockResolvedValue(1);

    const app = createApp();
    const response = await request(app)
      .get('/audit-log?limit=10')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.auditLogs).toHaveLength(1);
  });

  it('builds a where clause from actionType and targetId filters', async () => {
    mockAuditFindMany.mockResolvedValue([]);
    mockAuditCount.mockResolvedValue(0);

    const app = createApp();
    await request(app)
      .get('/audit-log?actionType=USER_SUSPENDED&targetId=u1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(mockAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actionType: 'USER_SUSPENDED', targetId: 'u1' },
      })
    );
    expect(mockAuditCount).toHaveBeenCalledWith({
      where: { actionType: 'USER_SUSPENDED', targetId: 'u1' },
    });
  });

  it('returns 400 for limit above the allowed maximum', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/audit-log?limit=999')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(400);
    expect(mockAuditFindMany).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/audit-log')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockAuditFindMany).not.toHaveBeenCalled();
  });
});

describe('GET /alerts', () => {
  it('returns unresolved alerts only, paginated', async () => {
    mockAlertFindMany.mockResolvedValue([
      {
        id: 'a1',
        eventType: 'AI_CRISIS',
        severity: 'HIGH',
        payload: {},
        resolved: false,
        createdAt: new Date(),
      },
    ]);
    mockAlertCount.mockResolvedValue(1);

    const app = createApp();
    const response = await request(app)
      .get('/alerts?limit=10')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(mockAlertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resolved: false } })
    );
  });

  it('rejects a non-admin caller with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/alerts')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockAlertFindMany).not.toHaveBeenCalled();
  });
});

describe('PUT /alerts/:id/resolve', () => {
  it('marks the alert resolved and writes an ALERT_RESOLVED audit log entry', async () => {
    mockAlertFindUnique.mockResolvedValue({
      id: 'a1',
      eventType: 'AI_CRISIS',
      severity: 'HIGH',
      resolved: false,
    });
    mockAlertUpdate.mockResolvedValue({});
    mockAuditCreate.mockResolvedValue({ id: 'audit-4' });

    const app = createApp();
    const response = await request(app)
      .put('/alerts/a1/resolve')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(mockAlertUpdate).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { resolved: true },
    });
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'ALERT_RESOLVED',
        targetId: 'a1',
        metadata: { eventType: 'AI_CRISIS', severity: 'HIGH' },
      }),
    });
  });

  it('returns 404 and writes nothing when the alert does not exist', async () => {
    mockAlertFindUnique.mockResolvedValue(null);

    const app = createApp();
    const response = await request(app)
      .put('/alerts/does-not-exist/resolve')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(404);
    expect(mockAlertUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('GET /moderation/queue', () => {
  it('proxies to Community Service for PENDING reports', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        reports: [{ _id: 'r1', status: 'PENDING' }],
        total: 1,
        page: 1,
        limit: 20,
      },
    });

    const app = createApp();
    const response = await request(app)
      .get('/moderation/queue')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://localhost:8000',
      expect.stringContaining('/internal/community/reports?status=PENDING'),
      { headers: { Authorization: 'Bearer test-internal-service-token' } }
    );
  });

  it('returns 503 when Community Service is unreachable', async () => {
    mockHttpGet.mockResolvedValue({ ok: false, status: 503, data: null });

    const app = createApp();
    const response = await request(app)
      .get('/moderation/queue')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(503);
  });
});

describe('PUT /moderation/:id/resolve', () => {
  it('maps REMOVED->REVIEWED, writes moderation_decisions AND audit_logs only after success', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 200,
      data: { _id: 'r1', contentId: 'c1', contentType: 'POST' },
    });
    mockModerationCreate.mockResolvedValue({ id: 'decision-1' });
    mockAuditCreate.mockResolvedValue({ id: 'audit-5' });

    const app = createApp();
    const token = adminToken();
    const response = await request(app)
      .put('/moderation/r1/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'REMOVED', reason: 'violates community guidelines' });

    expect(response.status).toBe(200);
    expect(response.body.moderationDecisionId).toBe('decision-1');
    expect(mockCallService).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/internal/community/reports/r1/resolve',
      expect.objectContaining({ method: 'PUT', body: { status: 'REVIEWED' } })
    );
    expect(mockModerationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reportId: 'r1',
        adminId: 'admin-1',
        decision: 'REMOVED',
        reason: 'violates community guidelines',
      }),
    });
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'REPORT_RESOLVED',
        targetId: 'r1',
        metadata: expect.objectContaining({
          contentId: 'c1',
          contentType: 'POST',
        }),
      }),
    });
  });

  it('maps DISMISSED->DISMISSED (no translation)', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 200,
      data: { _id: 'r1', contentId: 'c1', contentType: 'POST' },
    });
    mockModerationCreate.mockResolvedValue({ id: 'decision-2' });

    const app = createApp();
    await request(app)
      .put('/moderation/r1/resolve')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ decision: 'DISMISSED', reason: 'no violation found' });

    expect(mockCallService).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/internal/community/reports/r1/resolve',
      expect.objectContaining({ body: { status: 'DISMISSED' } })
    );
  });

  it('returns 400 and calls nothing when decision is invalid', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/moderation/r1/resolve')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ decision: 'BANNED', reason: 'x' });

    expect(response.status).toBe(400);
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it('returns 404 and writes nothing when the report does not exist', async () => {
    mockCallService.mockResolvedValue({ ok: false, status: 404, data: null });

    const app = createApp();
    const response = await request(app)
      .put('/moderation/does-not-exist/resolve')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ decision: 'DISMISSED', reason: 'x' });

    expect(response.status).toBe(404);
    expect(mockModerationCreate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('POST /moderation/decrypt/:postId', () => {
  it('decrypts the author and writes a POST_AUTHOR_DECRYPTED audit log', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'user-abc' },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-6' });

    const app = createApp();
    const response = await request(app)
      .post('/moderation/decrypt/post1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ postId: 'post1', userId: 'user-abc' });
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'POST_AUTHOR_DECRYPTED',
        targetId: 'post1',
      }),
    });
  });

  it('returns 404 and writes no audit log when the post does not exist', async () => {
    mockHttpGet.mockResolvedValue({ ok: false, status: 404, data: null });

    const app = createApp();
    const response = await request(app)
      .post('/moderation/decrypt/does-not-exist')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(404);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller with 403 before calling anything', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/moderation/decrypt/post1')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockHttpGet).not.toHaveBeenCalled();
  });
});

describe('GET /analytics', () => {
  it('aggregates all four dependent services, forwarding the caller JWT only to ai/usage', async () => {
    mockHttpGet.mockImplementation((_base: string, path: string) => {
      if (path === '/internal/users/analytics') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { totalUsers: 10, activeUsersLast30Days: 4 },
        });
      }
      if (path === '/internal/appointments/analytics') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { totalAppointments: 5, completedAppointments: 3 },
        });
      }
      if (path === '/internal/mood/analytics') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { totalMoodEntries: 20, avgMoodScorePlatform: 6.5 },
        });
      }
      if (path === '/api/v1/ai/usage') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { totalInteractions: 100, totalCrisisEvents: 2 },
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const app = createApp();
    const token = adminToken();
    const response = await request(app)
      .get('/analytics')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      totalUsers: 10,
      activeUsersLast30Days: 4,
      totalAppointments: 5,
      completedAppointments: 3,
      totalMoodEntries: 20,
      avgMoodScorePlatform: 6.5,
      totalCommunityPosts: null,
      totalAiInteractions: 100,
      totalCrisisEvents: 2,
    });

    // The ai/usage call must carry the admin's own token, not the internal
    // service token every other call in this router uses.
    const aiUsageCall = mockHttpGet.mock.calls.find(
      (call) => call[1] === '/api/v1/ai/usage'
    );
    expect(aiUsageCall?.[2]).toEqual({
      headers: { Authorization: `Bearer ${token}` },
    });

    const usersCall = mockHttpGet.mock.calls.find(
      (call) => call[1] === '/internal/users/analytics'
    );
    expect(usersCall?.[2]).toEqual({
      headers: { Authorization: 'Bearer test-internal-service-token' },
    });
  });

  it('returns null (not 503/500) for just the fields whose service is down', async () => {
    mockHttpGet.mockImplementation((_base: string, path: string) => {
      if (path === '/internal/users/analytics') {
        return Promise.resolve({ ok: false, status: 503, data: null });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { placeholder: true },
      });
    });

    const app = createApp();
    const response = await request(app)
      .get('/analytics')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.totalUsers).toBeNull();
    expect(response.body.activeUsersLast30Days).toBeNull();
  });

  it('fires all four calls in parallel, not sequentially', async () => {
    const callOrder: string[] = [];
    mockHttpGet.mockImplementation((_base: string, path: string) => {
      callOrder.push(path);
      return Promise.resolve({ ok: true, status: 200, data: {} });
    });

    const app = createApp();
    await request(app)
      .get('/analytics')
      .set('Authorization', `Bearer ${adminToken()}`);

    // All four requests were dispatched before any of them could have resolved
    // sequentially — Promise.all starts them together, so call order reflects
    // source order, not completion order, and all four happen in one tick.
    expect(callOrder).toHaveLength(4);
  });
});

describe('GET /analytics/detailed', () => {
  it('assembles users/therapists/appointments sections from the two extended internal endpoints', async () => {
    mockHttpGet.mockImplementation((_base: string, path: string) => {
      if (path.startsWith('/internal/users/analytics')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            totalUsers: 10,
            usersByRole: { PATIENT: 7, THERAPIST: 2, ADMIN: 1 },
            newUsersInRange: 3,
            suspendedUsers: 1,
            dau: 2,
            wau: 5,
            mau: 8,
            registrationTrend: [{ date: '2026-06-10', count: 3 }],
            therapistApplications: {
              byStatus: { APPROVED: 2, REJECTED: 1 },
              approvalRate: 2 / 3,
              rejectionRate: 1 / 3,
              applicationTrend: [{ date: '2026-06-10', count: 1 }],
            },
            totalTherapists: 2,
            suspendedTherapists: 0,
          },
        });
      }
      if (path.startsWith('/internal/appointments/analytics')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            totalAppointments: 5,
            completedAppointments: 3,
            statusBreakdown: { COMPLETED: 3, CANCELLED: 1 },
            completionRate: 0.75,
            cancellationRate: 0.25,
            sessionTrend: [
              {
                date: '2026-06-10',
                completed: 3,
                cancelled: 1,
                pending: 0,
                confirmed: 0,
              },
            ],
          },
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const app = createApp();
    const response = await request(app)
      .get('/analytics/detailed')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.users).toMatchObject({
      totalUsers: 10,
      usersByRole: { PATIENT: 7, THERAPIST: 2, ADMIN: 1 },
      dau: 2,
      wau: 5,
      mau: 8,
    });
    expect(response.body.therapists).toMatchObject({
      totalTherapists: 2,
      suspendedTherapists: 0,
      applications: { byStatus: { APPROVED: 2, REJECTED: 1 } },
    });
    expect(response.body.appointments).toMatchObject({
      totalAppointments: 5,
      completionRate: 0.75,
    });
    expect(response.body.range).toEqual({
      from: expect.any(String),
      to: expect.any(String),
    });
  });

  it('users and therapists sections are both null (not 503) when User Service is down, appointments unaffected', async () => {
    mockHttpGet.mockImplementation((_base: string, path: string) => {
      if (path.startsWith('/internal/users/analytics')) {
        return Promise.resolve({ ok: false, status: 503, data: null });
      }
      if (path.startsWith('/internal/appointments/analytics')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { totalAppointments: 5, completedAppointments: 3 },
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const app = createApp();
    const response = await request(app)
      .get('/analytics/detailed')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.users).toBeNull();
    expect(response.body.therapists).toBeNull();
    expect(response.body.appointments).toMatchObject({ totalAppointments: 5 });
  });

  it('accepts custom from/to and forwards them to both internal calls', async () => {
    mockHttpGet.mockResolvedValue({ ok: true, status: 200, data: {} });

    const app = createApp();
    await request(app)
      .get(
        '/analytics/detailed?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z'
      )
      .set('Authorization', `Bearer ${adminToken()}`);

    const usersCall = mockHttpGet.mock.calls.find((call) =>
      (call[1] as string).startsWith('/internal/users/analytics')
    );
    expect(usersCall?.[1]).toContain('from=2026-01-01T00%3A00%3A00.000Z');
    expect(usersCall?.[1]).toContain('to=2026-01-31T00%3A00%3A00.000Z');
  });

  it('rejects a non-admin caller with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/analytics/detailed')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockHttpGet).not.toHaveBeenCalled();
  });
});

describe('GET /ai/usage', () => {
  it('proxies successfully and writes an AI_USAGE_VIEWED audit log only after success', async () => {
    mockHttpGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { totalInteractions: 100, totalCrisisEvents: 2 },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-3' });

    const app = createApp();
    const token = adminToken();
    const response = await request(app)
      .get('/ai/usage')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      totalInteractions: 100,
      totalCrisisEvents: 2,
    });
    expect(mockHttpGet).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/api/v1/ai/usage',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        actionType: 'AI_USAGE_VIEWED',
      }),
    });
  });

  it('does NOT write an audit log when AI Service is unreachable', async () => {
    mockHttpGet.mockResolvedValue({ ok: false, status: 503, data: null });

    const app = createApp();
    const response = await request(app)
      .get('/ai/usage')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(503);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller with 403 before proxying anything', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/ai/usage')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockHttpGet).not.toHaveBeenCalled();
  });
});

describe('PUT /therapist-applications/:id/approve', () => {
  it('calls User Service then Auth Service in order, and writes an audit log only after both succeed', async () => {
    mockCallService
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          application: { id: 'app-1', userId: 'user-1', status: 'APPROVED' },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { id: 'user-1', role: 'THERAPIST' },
      });
    mockAuditCreate.mockResolvedValue({ id: 'audit-1' });

    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/approve')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.auditLogId).toBe('audit-1');
    expect(mockCallService).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000',
      '/internal/users/therapist-applications/app-1/status',
      expect.objectContaining({
        method: 'PATCH',
        body: { status: 'APPROVED', reviewedBy: 'admin-1' },
      })
    );
    expect(mockCallService).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000',
      '/internal/auth/users/user-1',
      expect.objectContaining({ method: 'PATCH', body: { role: 'THERAPIST' } })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        actionType: 'THERAPIST_APPLICATION_APPROVED',
        targetId: 'app-1',
      }),
    });
  });

  it('returns 503 and does NOT write an audit log when the role-activation call fails', async () => {
    mockCallService
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          application: { id: 'app-1', userId: 'user-1', status: 'APPROVED' },
        },
      })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null });

    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/approve')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(503);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('returns 409 without calling Auth Service when the application is not reviewable', async () => {
    mockCallService.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: null,
    });

    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/approve')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(409);
    expect(mockCallService).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-admin caller with 403', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/approve')
      .set('Authorization', `Bearer ${patientToken()}`);

    expect(response.status).toBe(403);
    expect(mockCallService).not.toHaveBeenCalled();
  });
});

describe('PUT /therapist-applications/:id/reject', () => {
  it('requires a reason', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/reject')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});

    expect(response.status).toBe(400);
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it('rejects the application and writes an audit log with the reason', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        application: { id: 'app-1', userId: 'user-1', status: 'REJECTED' },
      },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-2' });

    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/reject')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Unverifiable license' });

    expect(response.status).toBe(200);
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'THERAPIST_APPLICATION_REJECTED',
        targetId: 'app-1',
        metadata: expect.objectContaining({ reason: 'Unverifiable license' }),
      }),
    });
  });
});

describe('PUT /therapist-applications/:id/request-info', () => {
  it('requires a note', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/request-info')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});

    expect(response.status).toBe(400);
  });

  it('requests more information and writes an audit log with the note', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        application: {
          id: 'app-1',
          userId: 'user-1',
          status: 'MORE_INFORMATION_REQUIRED',
        },
      },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-3' });

    const app = createApp();
    const response = await request(app)
      .put('/therapist-applications/app-1/request-info')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ note: 'Please upload your license.' });

    expect(response.status).toBe(200);
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'THERAPIST_APPLICATION_MORE_INFO_REQUESTED',
        metadata: expect.objectContaining({
          note: 'Please upload your license.',
        }),
      }),
    });
  });
});

describe('POST /therapist-applications/:id/notes', () => {
  it('forwards the note with the caller as authorId and writes an audit log', async () => {
    mockCallService.mockResolvedValue({
      ok: true,
      status: 201,
      data: { note: { id: 'note-1', note: 'Internal comment' } },
    });
    mockAuditCreate.mockResolvedValue({ id: 'audit-4' });

    const app = createApp();
    const response = await request(app)
      .post('/therapist-applications/app-1/notes')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ note: 'Internal comment' });

    expect(response.status).toBe(201);
    expect(mockCallService).toHaveBeenCalledWith(
      'http://localhost:8000',
      '/internal/users/therapist-applications/app-1/notes',
      expect.objectContaining({
        method: 'POST',
        body: { authorId: 'admin-1', note: 'Internal comment' },
      })
    );
  });
});

describe('PUT /therapists/:id/suspend', () => {
  it('revokes access first, then flips the discovery flag, then audits — distinct actionType from generic user suspend', async () => {
    mockCallService
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { message: 'User suspended', userId: 't1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { userId: 't1', isSuspended: true },
      });
    mockAuditCreate.mockResolvedValue({ id: 'audit-5' });

    const app = createApp();
    const response = await request(app)
      .put('/therapists/t1/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'conduct violation' });

    expect(response.status).toBe(200);
    expect(mockCallService).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000',
      '/internal/users/t1/suspend',
      expect.objectContaining({
        method: 'PUT',
        body: { reason: 'conduct violation' },
      })
    );
    expect(mockCallService).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000',
      '/internal/users/t1/therapist-suspension',
      expect.objectContaining({ method: 'PATCH', body: { isSuspended: true } })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'THERAPIST_SUSPENDED',
        targetId: 't1',
      }),
    });
  });

  it('still audits the suspension even if the discovery-flag call fails (access revocation already succeeded)', async () => {
    mockCallService
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { message: 'User suspended', userId: 't1' },
      })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null });
    mockAuditCreate.mockResolvedValue({ id: 'audit-6' });

    const app = createApp();
    const response = await request(app)
      .put('/therapists/t1/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'conduct violation' });

    expect(response.status).toBe(200);
    expect(mockAuditCreate).toHaveBeenCalled();
  });

  it('404s and does not touch the discovery flag when the user does not exist', async () => {
    mockCallService.mockResolvedValueOnce({
      ok: false,
      status: 404,
      data: null,
    });

    const app = createApp();
    const response = await request(app)
      .put('/therapists/does-not-exist/suspend')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'conduct violation' });

    expect(response.status).toBe(404);
    expect(mockCallService).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('PUT /therapists/:id/reactivate', () => {
  it('restores access and clears the discovery flag', async () => {
    mockCallService
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { message: 'User reactivated', userId: 't1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { userId: 't1', isSuspended: false },
      });
    mockAuditCreate.mockResolvedValue({ id: 'audit-7' });

    const app = createApp();
    const response = await request(app)
      .put('/therapists/t1/reactivate')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'appeal approved' });

    expect(response.status).toBe(200);
    expect(mockCallService).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000',
      '/internal/users/t1/therapist-suspension',
      expect.objectContaining({ method: 'PATCH', body: { isSuspended: false } })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ actionType: 'THERAPIST_REACTIVATED' }),
    });
  });
});
