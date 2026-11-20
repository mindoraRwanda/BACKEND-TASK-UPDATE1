import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import {
  analyticsRangeQuerySchema,
  createCarePlanSchema,
  updateCarePlanSchema,
  listUsersQuerySchema,
  suspendUserSchema,
  therapistListQuerySchema,
  updateFcmTokenSchema,
  updateNotificationPreferencesSchema,
  updateProfileSchema,
} from '@mindora/validation';
import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  verifyJwt,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import { authenticatedRouteLimiter } from '../middleware/rate-limit.js';
import { Prisma } from '../generated/prisma/index.js';
import { callService, httpClient } from '@mindora/http-client';

export const userRouter = Router();

const SERVICE_NAME = 'user-service';
const GATEWAY_HEALTH_PATH = '/api/v1/users/health';
const KONG_URL = process.env.KONG_URL ?? 'http://localhost:8000';

type AuthUserRecord = {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
};

// Opt-out model — matches the column default in schema.prisma. Used when a
// profile's notificationPreferences is somehow null/absent.
const DEFAULT_NOTIFICATION_PREFERENCES = { push: true, email: true, sms: true };

// User Service no longer has a users table (that lives in Auth Service's
// isolated 'mindora_auth' database) — role/email are denormalized onto the
// profile tables for the common case, but this is the fallback for when
// a profile doesn't exist yet (e.g. ADMIN, who never gets one) or a
// profile's email hasn't been backfilled. Always through Kong, never
// auth-service directly, per the internal-service-call convention.

type CarePlanPayload = {
  title: string;
  goals: string[];
  milestones: Array<{ title: string; dueDate?: string }>;
  reviewDate?: string;
};

function carePlanEncryptionKey(): Buffer {
  const secret = process.env.THERAPIST_CARE_PLAN_ENCRYPTION_KEY;
  if (!secret || secret.trim().length < 32) {
    throw new Error('THERAPIST_CARE_PLAN_ENCRYPTION_KEY is not configured');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptCarePlan(payload: CarePlanPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', carePlanEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

function decryptCarePlan(payload: string): CarePlanPayload {
  const [ivB64, tagB64, encryptedB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error('Invalid encrypted care plan payload');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    carePlanEncryptionKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as CarePlanPayload;
}

async function therapistHasPatientRelationship(
  therapistId: string,
  patientId: string
): Promise<boolean> {
  try {
    const response = await httpClient.get<{ hasRelationship: boolean }>(
      KONG_URL,
      `/internal/appointments/relationship/${encodeURIComponent(therapistId)}/${encodeURIComponent(patientId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );
    return response.ok && response.data?.hasRelationship === true;
  } catch {
    return false;
  }
}

function publicCarePlan(record: {
  id: string;
  therapistId: string;
  patientId: string;
  encryptedPayload: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  patientAcknowledgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    therapistId: record.therapistId,
    patientId: record.patientId,
    ...decryptCarePlan(record.encryptedPayload),
    status: record.status,
    patientAcknowledgedAt: record.patientAcknowledgedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function fetchAuthUser(
  userId: string
): Promise<{ id: string; email: string; role: string } | null> {
  const base = process.env.KONG_URL ?? 'http://localhost:8000';
  try {
    // encodeURIComponent, not raw interpolation — userId is caller-supplied
    // (route param or JWT sub) and must not be able to reshape the request
    // path (e.g. inject '/', '?', '#') sent to another internal service.
    const res = await fetch(
      `${base}/internal/auth/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as { id: string; email: string; role: string };
  } catch {
    return null;
  }
}

const healthResponse = () => ({
  status: 'ok',
  service: SERVICE_NAME,
});

userRouter.get('/health', (_req, res) => {
  res.status(200).json(healthResponse());
});

userRouter.get(GATEWAY_HEALTH_PATH, (_req, res) => {
  res.status(200).json(healthResponse());
});

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as /internal/users/:id
// below, but registered BEFORE it: Express matches routes in registration
// order, and /internal/users/:id would otherwise shadow this (treating
// "analytics" as :id and returning 404 "User not found" — caught live while
// testing GET /api/v1/admin/analytics through Kong, not by tsc).
// Proxies to Auth Service, the source of truth for the users table; User
// Service has no users table of its own to aggregate against.
userRouter.get(
  '/internal/users/analytics',
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

    const query = new URLSearchParams();
    if (parsed.data.from) query.set('from', parsed.data.from.toISOString());
    if (parsed.data.to) query.set('to', parsed.data.to.toISOString());

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const rangeFrom = parsed.data.from ?? thirtyDaysAgo;
    const rangeTo = parsed.data.to ?? now;

    const [
      authResponse,
      applicationsByStatusRaw,
      applicationTrendRaw,
      totalTherapists,
      suspendedTherapists,
    ] = await Promise.all([
      httpClient.get<{
        totalUsers: number;
        activeUsersLast30Days: number;
        usersByRole?: Record<string, number>;
        newUsersInRange?: number;
        suspendedUsers?: number;
        dau?: number;
        wau?: number;
        mau?: number;
        registrationTrend?: { date: string; count: number }[];
      }>(KONG_URL, `/internal/auth/analytics?${query.toString()}`, {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }),
      prisma.therapistApplication.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
          SELECT date_trunc('day', "submitted_at") AS bucket, COUNT(*)::bigint AS count
          FROM "therapist_applications"
          WHERE "submitted_at" >= ${rangeFrom} AND "submitted_at" <= ${rangeTo}
          GROUP BY bucket
          ORDER BY bucket ASC
        `,
      prisma.therapistProfile.count({
        where: { applicationStatus: 'APPROVED', isSuspended: false },
      }),
      prisma.therapistProfile.count({ where: { isSuspended: true } }),
    ]);

    if (!authResponse.ok || !authResponse.data) {
      res.status(503).json({ message: 'Auth Service unavailable' });
      return;
    }

    const applicationsByStatus = Object.fromEntries(
      applicationsByStatusRaw.map((r) => [r.status, r._count._all])
    );
    const decided =
      (applicationsByStatus.APPROVED ?? 0) +
      (applicationsByStatus.REJECTED ?? 0);

    res.status(200).json({
      ...authResponse.data,
      therapistApplications: {
        byStatus: applicationsByStatus,
        approvalRate:
          decided > 0 ? (applicationsByStatus.APPROVED ?? 0) / decided : 0,
        rejectionRate:
          decided > 0 ? (applicationsByStatus.REJECTED ?? 0) / decided : 0,
        applicationTrend: applicationTrendRaw.map((r) => ({
          date: r.bucket.toISOString().slice(0, 10),
          count: Number(r.count),
        })),
      },
      totalTherapists,
      suspendedTherapists,
    });
  })
);

// INTERNAL SERVICE ENDPOINT — not exposed through the public Kong user-api route.
// Requires SERVICE role JWT in Authorization header.
// SECURITY TODO: non-expiring token in use — replace with rotating credentials
// via AWS Secrets Manager before production deployment.
// See: BACKEND_COMPLETE.md → "Known Security Limitations"
userRouter.get(
  '/internal/users/:id',
  authenticatedRouteLimiter,
  verifyJwt,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const id = req.params.id as string;

    try {
      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: id },
      });
      if (patientProfile) {
        res.status(200).json({ id, userName: patientProfile.userName ?? null });
        return;
      }

      const therapistProfile = await prisma.therapistProfile.findUnique({
        where: { userId: id },
      });
      if (therapistProfile) {
        res
          .status(200)
          .json({ id, userName: therapistProfile.userName ?? null });
        return;
      }

      // No profile row (e.g. ADMIN, who never gets one) — fall back to Auth
      // Service to distinguish "exists, just no profile" (200, userName: null,
      // matching the original prisma.user-backed behavior) from "genuinely
      // doesn't exist" (404).
      const authUser = await fetchAuthUser(id);
      if (!authUser) {
        res.status(404).json({ message: 'User not found' });
        return;
      }
      res.status(200).json({ id, userName: null });
    } catch {
      // Malformed id (not a UUID) or lookup failure — treat as not found
      res.status(404).json({ message: 'User not found' });
    }
  }
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as
// GET /internal/users/:id above. Proxies to Auth Service, which is the
// source of truth for the users table; User Service has no users table
// of its own (see PatientProfile/TherapistProfile comment).
userRouter.get(
  '/internal/users',
  authenticatedRouteLimiter,
  verifyJwt,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const parsed = listUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const query = new URLSearchParams();
    const { role, isActive, page, limit } = parsed.data;
    if (role) query.set('role', role);
    if (isActive !== undefined) query.set('isActive', String(isActive));
    query.set('page', String(page));
    query.set('limit', String(limit));

    const response = await httpClient.get<{
      users: AuthUserRecord[];
      total: number;
      page: number;
      limit: number;
    }>(KONG_URL, `/internal/auth/users?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'Auth Service unavailable' });
      return;
    }

    res.status(200).json(response.data);
  }
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as above.
// Flips isActive=false on Auth Service; User Service holds no isActive
// state of its own.
userRouter.put(
  '/internal/users/:id/suspend',
  authenticatedRouteLimiter,
  verifyJwt,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const parsed = suspendUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const id = req.params.id as string;

    const response = await callService<AuthUserRecord>(
      KONG_URL,
      `/internal/auth/users/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: { isActive: false },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'Auth Service unavailable' });
      return;
    }

    res.status(200).json({ message: 'User suspended', userId: id });
  }
);

// INTERNAL SERVICE ENDPOINT — mirrors /internal/users/:id/suspend above,
// flipping isActive=true instead of false.
userRouter.put(
  '/internal/users/:id/reactivate',
  authenticatedRouteLimiter,
  verifyJwt,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const parsed = suspendUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const id = req.params.id as string;

    const response = await callService<AuthUserRecord>(
      KONG_URL,
      `/internal/auth/users/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: { isActive: true },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'Auth Service unavailable' });
      return;
    }

    res.status(200).json({ message: 'User reactivated', userId: id });
  }
);

// Called by Notification Service directly on USER_SERVICE_URL, bypassing
// Kong — so it needs the full '/api/v1/users/...' path since there's no
// Kong route in front of it to strip the prefix. Also mounted at the
// stripped path so the user themselves can reach it through Kong's public
// user-api route (which does strip '/api/v1/users'). Requires either a
// SERVICE-role JWT or the caller's own userId to match the requested :userId.
userRouter.get(
  ['/api/v1/users/:userId/preferences', '/:userId/preferences'],
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = req.params.userId as string;

    if (authReq.user?.role !== 'SERVICE' && authReq.user?.userId !== userId) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    try {
      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId },
      });
      const therapistProfile = patientProfile
        ? null
        : await prisma.therapistProfile.findUnique({ where: { userId } });
      const profile = patientProfile ?? therapistProfile;

      if (!profile) {
        // No profile row (e.g. ADMIN) or a genuinely nonexistent user —
        // Auth Service is the only place left to tell these apart.
        const authUser = await fetchAuthUser(userId);
        if (!authUser) {
          res.status(404).json({ message: 'User not found' });
          return;
        }
        res.status(200).json({
          fcmToken: null,
          email: authUser.email,
          phoneNumber: null,
          userName: null,
          notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
        });
        return;
      }

      // email is backfilled onto the profile for the common case (no
      // network call). Falls back to Auth Service only for profiles that
      // predate the backfill and haven't been patched yet.
      let email = profile.email;
      if (!email) {
        const authUser = await fetchAuthUser(userId);
        email = authUser?.email ?? null;
      }

      res.status(200).json({
        fcmToken: profile.fcmToken ?? null,
        email,
        phoneNumber: null,
        userName: profile.userName ?? null,
        notificationPreferences:
          profile.notificationPreferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
      });
    } catch {
      // Malformed id (not a UUID) or lookup failure — treat as not found,
      // matching /internal/users/:id's convention.
      res.status(404).json({ message: 'User not found' });
    }
  })
);

userRouter.put(
  '/me/fcm-token',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const parsed = updateFcmTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { userId, role } = authReq.user;
    const { fcmToken } = parsed.data;

    if (role === 'PATIENT') {
      await prisma.patientProfile.update({
        where: { userId },
        data: { fcmToken },
      });
    } else if (role === 'THERAPIST') {
      await prisma.therapistProfile.update({
        where: { userId },
        data: { fcmToken },
      });
    } else {
      res.status(400).json({
        message: 'FCM token registration not supported for this role',
      });
      return;
    }

    res.status(200).json({ message: 'FCM token updated' });
  })
);

userRouter.put(
  '/me/notification-preferences',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const parsed = updateNotificationPreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { userId, role } = authReq.user;

    // Partial update — merge onto the current stored value (or defaults if
    // null/absent) so e.g. {push: false} doesn't wipe out email/sms settings.
    if (role === 'PATIENT') {
      const existing = await prisma.patientProfile.findUnique({
        where: { userId },
      });
      const current = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...(existing?.notificationPreferences as Record<string, boolean>),
      };
      const notificationPreferences = { ...current, ...parsed.data };
      const profile = await prisma.patientProfile.update({
        where: { userId },
        data: { notificationPreferences },
      });
      res
        .status(200)
        .json({ notificationPreferences: profile.notificationPreferences });
      return;
    }

    if (role === 'THERAPIST') {
      const existing = await prisma.therapistProfile.findUnique({
        where: { userId },
      });
      const current = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...(existing?.notificationPreferences as Record<string, boolean>),
      };
      const notificationPreferences = { ...current, ...parsed.data };
      const profile = await prisma.therapistProfile.update({
        where: { userId },
        data: { notificationPreferences },
      });
      res
        .status(200)
        .json({ notificationPreferences: profile.notificationPreferences });
      return;
    }

    res.status(400).json({
      message: 'Notification preferences not supported for this role',
    });
  })
);

userRouter.get(
  '/me',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const { userId, role } = authReq.user;

    if (role === 'PATIENT') {
      const profile = await prisma.patientProfile.findUnique({
        where: { userId },
      });
      if (!profile) {
        res.status(404).json({ message: 'Profile not found' });
        return;
      }
      res.status(200).json({ role, profile });
      return;
    }

    if (role === 'THERAPIST') {
      const profile = await prisma.therapistProfile.findUnique({
        where: { userId },
      });
      if (!profile) {
        res.status(404).json({ message: 'Profile not found' });
        return;
      }
      res.status(200).json({ role, profile });
      return;
    }

    res.status(200).json({
      role,
      message: 'No extended profile for this role',
      userId,
    });
  })
);

userRouter.put(
  '/me',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const data = parsed.data;
    const { userId, role } = authReq.user;

    if (role === 'PATIENT') {
      const profile = await prisma.patientProfile.update({
        where: { userId },
        data: {
          userName: data.userName,
          bio: data.bio,
          timezone: data.timezone,
          languagePreference: data.languagePreference,
        },
      });
      res.status(200).json({ role, profile });
      return;
    }

    if (role === 'THERAPIST') {
      const profile = await prisma.therapistProfile.update({
        where: { userId },
        data: {
          userName: data.userName,
          bio: data.bio,
          timezone: data.timezone,
          languagePreference: data.languagePreference,
        },
      });
      res.status(200).json({ role, profile });
      return;
    }

    res
      .status(400)
      .json({ message: 'Profile updates not supported for this role' });
  })
);

userRouter.get(
  '/therapists',
  authenticatedRouteLimiter,
  // Public directory data is limited to approved profiles. Application, document,
  // booking and dashboard routes remain authenticated and role-protected.
  asyncHandler(async (req, res) => {
    const parsed = therapistListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit, specialisation, language } = parsed.data;
    const skip = (page - 1) * limit;

    const where: Prisma.TherapistProfileWhereInput = {
      isAcceptingPatients: true,
      // Only surface therapists who cleared the application review and
      // aren't currently suspended. applicationStatus is nullable for rows
      // that predate the application system (seed.ts stamps those APPROVED
      // directly) — anyone else defaults to hidden until approved.
      applicationStatus: 'APPROVED',
      isSuspended: false,
      ...(specialisation
        ? { specialisation: { contains: specialisation, mode: 'insensitive' } }
        : {}),
      ...(language ? { languages: { has: language } } : {}),
    };

    const [therapists, total] = await Promise.all([
      prisma.therapistProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.therapistProfile.count({ where }),
    ]);

    res.status(200).json({
      therapists,
      total,
      page,
      limit,
    });
  })
);

// ---------------------------------------------------------------------------
// Therapist care-plan drafts — encrypted goal-setting content only.
// The therapist must have an existing appointment relationship with the
// patient. The assigned patient can review drafts; a plan becomes active only
// after patient acknowledgement. Diagnosis, medication instructions and prescriptions are out of scope.
// ---------------------------------------------------------------------------

userRouter.post(
  '/care-plans',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || authReq.user.role !== 'THERAPIST') {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = createCarePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { patientId, ...payload } = parsed.data;
    if (
      !(await therapistHasPatientRelationship(authReq.user.userId, patientId))
    ) {
      res.status(403).json({ message: "Not this patient's therapist" });
      return;
    }

    let encryptedPayload: string;
    try {
      encryptedPayload = encryptCarePlan(payload);
    } catch {
      res
        .status(503)
        .json({ message: 'Care-plan encryption is not configured' });
      return;
    }

    const record = await prisma.therapistCarePlan.create({
      data: {
        therapistId: authReq.user.userId,
        patientId,
        encryptedPayload,
        status: 'DRAFT',
      },
    });

    res.status(201).json({ carePlan: publicCarePlan(record) });
  })
);

userRouter.get(
  '/care-plans',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || authReq.user.role !== 'THERAPIST') {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const patientId =
      typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
    if (
      patientId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        patientId
      )
    ) {
      res.status(400).json({ message: 'Invalid patientId' });
      return;
    }
    if (
      patientId &&
      !(await therapistHasPatientRelationship(authReq.user.userId, patientId))
    ) {
      res.status(403).json({ message: "Not this patient's therapist" });
      return;
    }

    const records = await prisma.therapistCarePlan.findMany({
      where: {
        therapistId: authReq.user.userId,
        ...(patientId ? { patientId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    try {
      res.status(200).json({ carePlans: records.map(publicCarePlan) });
    } catch {
      res.status(503).json({
        message:
          'Care-plan encryption key is unavailable or data could not be decrypted',
      });
    }
  })
);

userRouter.get(
  '/care-plans/mine',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || authReq.user.role !== 'PATIENT') {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires PATIENT role' });
      return;
    }

    const records = await prisma.therapistCarePlan.findMany({
      where: {
        patientId: authReq.user.userId,
        status: { in: ['DRAFT', 'ACTIVE'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    try {
      res.status(200).json({ carePlans: records.map(publicCarePlan) });
    } catch {
      res.status(503).json({
        message:
          'Care-plan encryption key is unavailable or data could not be decrypted',
      });
    }
  })
);

userRouter.patch(
  '/care-plans/:id',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || authReq.user.role !== 'THERAPIST') {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires THERAPIST role' });
      return;
    }

    const parsed = updateCarePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const record = await prisma.therapistCarePlan.findUnique({
      where: { id: req.params.id as string },
    });
    if (!record || record.therapistId !== authReq.user.userId) {
      res.status(404).json({ message: 'Care plan not found' });
      return;
    }

    let encryptedPayload: string;
    try {
      const merged = {
        ...decryptCarePlan(record.encryptedPayload),
        ...parsed.data,
      };
      encryptedPayload = encryptCarePlan(merged);
    } catch {
      res.status(503).json({
        message:
          'Care-plan encryption is unavailable or stored data could not be decrypted',
      });
      return;
    }

    // An edit requires the patient to acknowledge the revised plan again.
    const updated = await prisma.therapistCarePlan.update({
      where: { id: record.id },
      data: {
        encryptedPayload,
        status: 'DRAFT',
        patientAcknowledgedAt: null,
      },
    });
    res.status(200).json({ carePlan: publicCarePlan(updated) });
  })
);

userRouter.post(
  '/care-plans/:id/acknowledge',
  authenticatedRouteLimiter,
  verifyJwt,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || authReq.user.role !== 'PATIENT') {
      res
        .status(authReq.user ? 403 : 401)
        .json({ message: 'Requires PATIENT role' });
      return;
    }

    const record = await prisma.therapistCarePlan.findUnique({
      where: { id: req.params.id as string },
    });
    if (!record || record.patientId !== authReq.user.userId) {
      res.status(404).json({ message: 'Care plan not found' });
      return;
    }
    if (record.status !== 'DRAFT') {
      res
        .status(409)
        .json({ message: 'Only a draft care plan can be acknowledged' });
      return;
    }

    const updated = await prisma.therapistCarePlan.update({
      where: { id: record.id },
      data: {
        status: 'ACTIVE',
        patientAcknowledgedAt: new Date(),
      },
    });
    try {
      res.status(200).json({ carePlan: publicCarePlan(updated) });
    } catch {
      res.status(503).json({
        message:
          'Care-plan encryption key is unavailable or data could not be decrypted',
      });
    }
  })
);
