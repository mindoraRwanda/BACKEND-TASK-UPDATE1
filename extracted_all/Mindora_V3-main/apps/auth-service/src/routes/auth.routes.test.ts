import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'mindora-dev-jwt-secret-change-in-production';
  process.env.JWT_ISSUER = 'mindora-auth';
  process.env.NODE_ENV = 'test';
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

const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn();
const mockUserCreate = vi.fn();
const mockRefreshCreate = vi.fn();
const mockRefreshUpdate = vi.fn();
const mockRefreshUpdateMany = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserCount = vi.fn();
const mockUserGroupBy = vi.fn();
const mockQueryRaw = vi.fn();
const mockIsBlacklisted = vi.fn();
const mockBlacklistToken = vi.fn();
const mockStoreReset = vi.fn();
const mockGetResetUser = vi.fn();
const mockDeleteReset = vi.fn();
const mockPublish = vi.fn();
const mockPublishToExchange = vi.fn();
const mockLockRemaining = vi.fn();
const mockRecordLoginFailure = vi.fn();
const mockClearLoginFailures = vi.fn();
const mockClearLoginLock = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
      count: (...args: unknown[]) => mockUserCount(...args),
      groupBy: (...args: unknown[]) => mockUserGroupBy(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    refreshToken: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      create: (...args: unknown[]) => mockRefreshCreate(...args),
      update: (...args: unknown[]) => mockRefreshUpdate(...args),
      updateMany: (...args: unknown[]) => mockRefreshUpdateMany(...args),
    },
  },
}));

vi.mock('@mindora/auth-middleware', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@mindora/auth-middleware')>();
  return {
    ...actual,
    isTokenBlacklisted: (...args: unknown[]) => mockIsBlacklisted(...args),
    blacklistToken: (...args: unknown[]) => mockBlacklistToken(...args),
  };
});

// /register publishes a user.registered event so User Service can provision
// a profile — mocked here so tests never attempt a real RabbitMQ connection.
vi.mock('@mindora/queue', () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
  publishToExchange: (...args: unknown[]) => mockPublishToExchange(...args),
}));

vi.mock('../lib/redis.js', () => ({
  connectRedis: vi.fn(),
  storePasswordResetToken: (...args: unknown[]) => mockStoreReset(...args),
  getPasswordResetUserId: (...args: unknown[]) => mockGetResetUser(...args),
  deletePasswordResetToken: (...args: unknown[]) => mockDeleteReset(...args),
  isTokenBlacklisted: (...args: unknown[]) => mockIsBlacklisted(...args),
  blacklistToken: (...args: unknown[]) => mockBlacklistToken(...args),
  getLoginLockRemainingSeconds: (...args: unknown[]) =>
    mockLockRemaining(...args),
  recordLoginFailure: (...args: unknown[]) => mockRecordLoginFailure(...args),
  clearLoginFailures: (...args: unknown[]) => mockClearLoginFailures(...args),
  clearLoginLock: (...args: unknown[]) => mockClearLoginLock(...args),
}));

import { createApp } from '../app.js';
import { hashPassword } from '../lib/password.js';
import { config } from '../config.js';
import { signAccessToken } from '../lib/tokens.js';

describe('POST /register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a user successfully', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'user-123' });

    const app = createApp();
    const response = await request(app).post('/register').send({
      email: 'patient@example.com',
      password: 'securePass1',
      role: 'PATIENT',
      userName: 'Test Patient',
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ userId: 'user-123' });
  });

  it('rejects duplicate email with 409', async () => {
    mockFindUnique.mockResolvedValue({ id: 'existing-user' });

    const app = createApp();
    const response = await request(app).post('/register').send({
      email: 'patient@example.com',
      password: 'securePass1',
      role: 'PATIENT',
      userName: 'Test Patient',
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Email already exists');
  });

  it('normalizes email casing before checking for duplicates and storing', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'user-123' });

    const app = createApp();
    const response = await request(app).post('/register').send({
      email: 'Patient@Example.com',
      password: 'securePass1',
      role: 'PATIENT',
      userName: 'Test Patient',
    });

    expect(response.status).toBe(201);
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { email: 'patient@example.com' },
    });
    expect(mockUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'patient@example.com' }),
      })
    );
  });

  it('rejects missing userName with 400', async () => {
    const app = createApp();
    const response = await request(app).post('/register').send({
      email: 'patient@example.com',
      password: 'securePass1',
      role: 'PATIENT',
    });

    expect(response.status).toBe(400);
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  // Regression test for a real vulnerability: this endpoint is public and
  // unauthenticated, so a client-supplied `role` must never be trusted —
  // self-registration must always create a PATIENT, no matter what role the
  // caller asks for. THERAPIST accounts are provisioned by seed.ts; there is
  // no self-service path to ADMIN at all.
  it('ignores a client-supplied ADMIN role and creates a PATIENT instead', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'user-123' });

    const app = createApp();
    const response = await request(app).post('/register').send({
      email: 'attacker@example.com',
      password: 'securePass1',
      role: 'ADMIN',
      userName: 'Attacker',
    });

    expect(response.status).toBe(201);
    expect(mockUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'PATIENT' }),
      })
    );
  });

  it('ignores a client-supplied THERAPIST role and creates a PATIENT instead', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'user-123' });

    const app = createApp();
    const response = await request(app).post('/register').send({
      email: 'aspiring-therapist@example.com',
      password: 'securePass1',
      role: 'THERAPIST',
      userName: 'Aspiring Therapist',
    });

    expect(response.status).toBe(201);
    expect(mockUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'PATIENT' }),
      })
    );
  });
});

describe('POST /login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshCreate.mockResolvedValue({ id: 'refresh-1' });
    mockIsBlacklisted.mockResolvedValue(false);
    mockLockRemaining.mockResolvedValue(0);
    mockRecordLoginFailure.mockResolvedValue({
      locked: false,
      lockedNow: false,
      retryAfterSeconds: 0,
    });
    mockClearLoginFailures.mockResolvedValue(undefined);
    mockClearLoginLock.mockResolvedValue(undefined);
    mockPublishToExchange.mockResolvedValue(undefined);
  });

  it('returns an access token for valid credentials', async () => {
    const passwordHash = await hashPassword('securePass1');
    mockFindUnique.mockResolvedValue({
      id: 'user-123',
      email: 'patient@example.com',
      passwordHash,
      role: 'PATIENT',
      isActive: true,
    });

    const app = createApp();
    const response = await request(app).post('/login').send({
      email: 'patient@example.com',
      password: 'securePass1',
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTypeOf('string');
    expect(response.headers['set-cookie']?.[0]).toContain('refreshToken=');
  });

  it('scopes the refresh cookie to COOKIE_DOMAIN and drops the host-only one', async () => {
    const passwordHash = await hashPassword('securePass1');
    mockFindUnique.mockResolvedValue({
      id: 'user-123',
      email: 'patient@example.com',
      passwordHash,
      role: 'PATIENT',
      isActive: true,
    });
    config.cookieDomain = '.mindora.rw';

    try {
      const app = createApp();
      const response = await request(app).post('/login').send({
        email: 'patient@example.com',
        password: 'securePass1',
      });

      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(response.status).toBe(200);
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(/^refreshToken=[^;]+;.*Domain=\.mindora\.rw/);
      expect(cookies[1]).toMatch(/^refreshToken=;/);
      expect(cookies[1]).not.toContain('Domain=');
    } finally {
      config.cookieDomain = undefined;
    }
  });

  it('rejects invalid credentials with 401', async () => {
    const passwordHash = await hashPassword('securePass1');
    mockFindUnique.mockResolvedValue({
      id: 'user-123',
      email: 'patient@example.com',
      passwordHash,
      role: 'PATIENT',
    });

    const app = createApp();
    const response = await request(app).post('/login').send({
      email: 'patient@example.com',
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid credentials');
  });

  it('logs in successfully when email casing differs from what was stored', async () => {
    const passwordHash = await hashPassword('securePass1');
    mockFindUnique.mockResolvedValue({
      id: 'user-123',
      email: 'patient@example.com',
      passwordHash,
      role: 'PATIENT',
      isActive: true,
    });

    const app = createApp();
    const response = await request(app).post('/login').send({
      email: 'Patient@Example.com',
      password: 'securePass1',
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTypeOf('string');
    // The lookup must use the normalized (lowercased) email, not the raw input
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { email: 'patient@example.com' },
    });
  });

  it('locks a user after the fifth invalid attempt and emits a security notification', async () => {
    const passwordHash = await hashPassword('securePass1');
    mockFindUnique.mockResolvedValue({
      id: 'user-123',
      email: 'patient@example.com',
      passwordHash,
      role: 'PATIENT',
      isActive: true,
    });
    mockRecordLoginFailure.mockResolvedValue({
      locked: true,
      lockedNow: true,
      retryAfterSeconds: 900,
    });
    const app = createApp();
    const response = await request(app)
      .post('/login')
      .send({ email: 'patient@example.com', password: 'wrong-password' });
    expect(response.status).toBe(423);
    expect(mockPublishToExchange).toHaveBeenCalledWith(
      expect.any(String),
      'account.locked',
      expect.objectContaining({ recipientEmail: 'patient@example.com' })
    );
  });

  it('rejects login for a suspended account with 403', async () => {
    const passwordHash = await hashPassword('securePass1');
    mockFindUnique.mockResolvedValue({
      id: 'user-123',
      email: 'patient@example.com',
      passwordHash,
      role: 'PATIENT',
      isActive: false,
    });

    const app = createApp();
    const response = await request(app).post('/login').send({
      email: 'patient@example.com',
      password: 'securePass1',
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Account suspended');
  });
});

describe('POST /logout', () => {
  beforeEach(() => {
    mockIsBlacklisted.mockResolvedValue(false);
    mockBlacklistToken.mockResolvedValue(undefined);
    mockRefreshUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('returns 200 and blacklists token', async () => {
    const accessToken = signAccessToken({
      userId: 'user-123',
      email: 'patient@example.com',
      role: 'PATIENT',
    });

    const app = createApp();
    const response = await request(app)
      .post('/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', 'refreshToken=test-refresh');

    expect(response.status).toBe(200);
    expect(mockBlacklistToken).toHaveBeenCalled();
    expect(mockRefreshUpdateMany).toHaveBeenCalled();
  });
});

describe('POST /refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rotates refresh token and returns new access token', async () => {
    const oldRefresh = 'old-refresh-token-value';
    mockFindFirst.mockResolvedValue({
      id: 'rt-old',
      userId: 'user-123',
      user: {
        id: 'user-123',
        email: 'patient@example.com',
        role: 'PATIENT',
        isActive: true,
      },
    });
    mockRefreshCreate.mockResolvedValue({ id: 'rt-new' });
    mockRefreshUpdate.mockResolvedValue({});

    const app = createApp();
    const response = await request(app)
      .post('/refresh')
      .set('Cookie', `refreshToken=${oldRefresh}`);

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTypeOf('string');
    expect(mockRefreshCreate).toHaveBeenCalled();
    expect(mockRefreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt-old' },
        data: expect.objectContaining({
          revoked: true,
          replacedByTokenId: 'rt-new',
        }),
      })
    );
  });

  it('rejects missing refresh cookie with 401', async () => {
    const app = createApp();
    const response = await request(app).post('/refresh');

    expect(response.status).toBe(401);
  });

  it('rejects refresh for a suspended account with 403', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'rt-old',
      userId: 'user-123',
      user: {
        id: 'user-123',
        email: 'patient@example.com',
        role: 'PATIENT',
        isActive: false,
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/refresh')
      .set('Cookie', 'refreshToken=some-refresh-token');

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Account suspended');
    expect(mockRefreshCreate).not.toHaveBeenCalled();
  });
});

describe('POST /forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreReset.mockResolvedValue(undefined);
    mockPublishToExchange.mockResolvedValue(undefined);
    mockDeleteReset.mockResolvedValue(undefined);
  });

  it('creates a hashed, short-lived token and queues the email without claiming delivery', async () => {
    mockFindUnique.mockResolvedValue({ id: 'user-123', email: 'a@b.com' });

    const app = createApp();
    const response = await request(app)
      .post('/forgot-password')
      .send({ email: 'a@b.com' });

    expect(response.status).toBe(202);
    expect(response.body.message).toContain('does not confirm email delivery');
    expect(JSON.stringify(response.body)).not.toMatch(/token|a@b\.com/i);
    expect(mockStoreReset).toHaveBeenCalledOnce();
    expect(mockPublishToExchange).toHaveBeenCalledWith(
      expect.any(String),
      'password.reset',
      expect.objectContaining({
        eventType: 'password.reset',
        recipientEmail: 'a@b.com',
        expiresInMinutes: 15,
        resetUrl: expect.stringContaining('/reset-password?token='),
      })
    );
  });

  it('returns the same public response for an unknown address', async () => {
    mockFindUnique.mockResolvedValue(null);

    const app = createApp();
    const response = await request(app)
      .post('/forgot-password')
      .send({ email: 'unknown@example.com' });

    expect(response.status).toBe(202);
    expect(response.body.message).toContain('does not confirm email delivery');
    expect(mockStoreReset).not.toHaveBeenCalled();
    expect(mockPublishToExchange).not.toHaveBeenCalled();
  });

  it('invalidates the reset token if RabbitMQ does not accept the reset event', async () => {
    mockFindUnique.mockResolvedValue({ id: 'user-123', email: 'a@b.com' });
    mockPublishToExchange.mockRejectedValue(new Error('broker unavailable'));

    const app = createApp();
    const response = await request(app)
      .post('/forgot-password')
      .send({ email: 'a@b.com' });

    expect(response.status).toBe(202);
    expect(mockDeleteReset).toHaveBeenCalledOnce();
  });
});

describe('POST /reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserUpdate.mockResolvedValue({});
    mockFindUnique.mockResolvedValue({ email: 'a@b.com' });
    mockDeleteReset.mockResolvedValue(undefined);
    mockClearLoginLock.mockResolvedValue(undefined);
    mockRefreshUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('rejects an invalid, expired, or previously consumed token', async () => {
    mockGetResetUser.mockResolvedValue(null);
    const app = createApp();
    const response = await request(app)
      .post('/reset-password')
      .send({ token: 'not-valid', newPassword: 'SecurePass123' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid or expired reset token');
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('hashes the new password, consumes the token, and revokes existing refresh sessions', async () => {
    mockGetResetUser.mockResolvedValue('user-123');
    const app = createApp();
    const response = await request(app)
      .post('/reset-password')
      .send({ token: 'one-time-reset-token', newPassword: 'SecurePass123' });

    expect(response.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { passwordHash: expect.any(String) },
    });
    expect(mockDeleteReset).toHaveBeenCalledOnce();
    expect(mockRefreshUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-123', revoked: false },
      data: { revoked: true },
    });
  });
});

describe('GET /me', () => {
  beforeEach(() => {
    mockIsBlacklisted.mockResolvedValue(false);
  });

  it('rejects expired access tokens with 401', async () => {
    const expiredToken = jwt.sign(
      {
        sub: 'user-123',
        email: 'patient@example.com',
        role: 'PATIENT',
      },
      config.jwtSecret,
      {
        expiresIn: -1,
        issuer: config.jwtIssuer,
        jwtid: 'expired-jti',
      }
    );

    const app = createApp();
    const response = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(response.status).toBe(401);
  });
});

describe('GET /internal/auth/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  function serviceToken(): string {
    return signAccessToken({
      userId: 'user-service',
      email: 'service@mindora.internal',
      role: 'SERVICE',
    });
  }

  it('returns totalUsers and activeUsersLast30Days, plus the new breakdown/trend fields', async () => {
    // Call order: totalUsers, activeUsersLast30Days (mau), newUsersInRange,
    // suspendedUsers, dau, wau — see the Promise.all in the handler.
    mockUserCount
      .mockResolvedValueOnce(50) // totalUsers
      .mockResolvedValueOnce(12) // activeUsersLast30Days / mau
      .mockResolvedValueOnce(3) // newUsersInRange
      .mockResolvedValueOnce(2) // suspendedUsers
      .mockResolvedValueOnce(1) // dau
      .mockResolvedValueOnce(5); // wau
    mockUserGroupBy.mockResolvedValueOnce([
      { role: 'PATIENT', _count: { _all: 40 } },
      { role: 'THERAPIST', _count: { _all: 9 } },
      { role: 'ADMIN', _count: { _all: 1 } },
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      { bucket: new Date('2026-06-10T00:00:00.000Z'), count: 3n },
    ]);

    const app = createApp();
    const response = await request(app)
      .get('/internal/auth/analytics')
      .set('Authorization', `Bearer ${serviceToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalUsers: 50,
      activeUsersLast30Days: 12,
      usersByRole: { PATIENT: 40, THERAPIST: 9, ADMIN: 1 },
      newUsersInRange: 3,
      suspendedUsers: 2,
      dau: 1,
      wau: 5,
      mau: 12,
      registrationTrend: [{ date: '2026-06-10', count: 3 }],
    });
    // Second call (activeUsersLast30Days) is the "active" filter —
    // createdAt OR refreshTokens.some within the window. dau/wau (5th/6th
    // calls) reuse the exact same OR shape at 1-day/7-day windows.
    expect(mockUserCount.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ createdAt: expect.any(Object) }),
            expect.objectContaining({ refreshTokens: expect.any(Object) }),
          ]),
        }),
      })
    );
  });

  it('rejects a non-SERVICE (ADMIN) token with 403', async () => {
    const adminToken = signAccessToken({
      userId: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    const app = createApp();
    const response = await request(app)
      .get('/internal/auth/analytics')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(403);
    expect(mockUserCount).not.toHaveBeenCalled();
  });

  it('rejects a request with no token with 401', async () => {
    const app = createApp();
    const response = await request(app).get('/internal/auth/analytics');

    expect(response.status).toBe(401);
  });
});

describe('PATCH /internal/auth/users/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlacklisted.mockResolvedValue(false);
  });

  function serviceToken(): string {
    return signAccessToken({
      userId: 'user-service',
      email: 'service@mindora.internal',
      role: 'SERVICE',
    });
  }

  it('flips role when called with { role } — the therapist-application approval path', async () => {
    mockUserUpdate.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      role: 'THERAPIST',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    const app = createApp();
    const response = await request(app)
      .patch('/internal/auth/users/user-1')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ role: 'THERAPIST' });

    expect(response.status).toBe(200);
    expect(response.body.role).toBe('THERAPIST');
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: { role: 'THERAPIST' },
      })
    );
    // role-only update must not touch the isActive/suspension machinery
    expect(mockRefreshUpdateMany).not.toHaveBeenCalled();
  });

  it('still accepts { isActive } alone, unchanged from before role support was added', async () => {
    mockUserUpdate.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      role: 'PATIENT',
      isActive: false,
      createdAt: new Date().toISOString(),
    });
    mockRefreshUpdateMany.mockResolvedValue({ count: 1 });

    const app = createApp();
    const response = await request(app)
      .patch('/internal/auth/users/user-1')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ isActive: false });

    expect(response.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } })
    );
    expect(mockRefreshUpdateMany).toHaveBeenCalled();
  });

  it('rejects an invalid role value with 400 and never calls update', async () => {
    const app = createApp();
    const response = await request(app)
      .patch('/internal/auth/users/user-1')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ role: 'SUPERADMIN' });

    expect(response.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('rejects an empty body with 400', async () => {
    const app = createApp();
    const response = await request(app)
      .patch('/internal/auth/users/user-1')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({});

    expect(response.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('rejects a non-SERVICE caller with 403', async () => {
    const adminToken = signAccessToken({
      userId: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    const app = createApp();
    const response = await request(app)
      .patch('/internal/auth/users/user-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'THERAPIST' });

    expect(response.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });
});
