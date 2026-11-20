import { prisma } from '../lib/prisma.js';
import {
  blacklistToken,
  setUserSuspended,
  verifyAccessToken,
} from '@mindora/auth-middleware';
import { publish, publishToExchange } from '@mindora/queue';
import { EXCHANGES } from '@mindora/events';
import {
  analyticsRangeQuerySchema,
  forgotPasswordSchema,
  listUsersQuerySchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  userRoleSchema,
} from '@mindora/validation';
import { Router, type Response } from 'express';
import type { UserRole } from '../generated/prisma/index.js';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import passport from 'passport';
import { config, isGoogleOAuthConfigured } from '../config.js';
import {
  authenticate,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import {
  authenticatedRouteLimiter,
  loginRouteLimiter,
  publicAuthRouteLimiter,
} from '../middleware/rate-limit.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { configureGoogleOAuth } from '../lib/google-oauth.js';
import { getRequestCookie } from '../lib/cookies.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  deletePasswordResetToken,
  getPasswordResetUserId,
  storePasswordResetToken,
  clearLoginFailures,
  clearLoginLock,
  getLoginLockRemainingSeconds,
  recordLoginFailure,
} from '../lib/redis.js';
import {
  clearRefreshCookie,
  issueAuthSession,
  setRefreshCookie,
} from '../lib/session.js';
import {
  createRefreshToken,
  getRefreshTokenExpiry,
  hashToken,
  signAccessToken,
} from '../lib/tokens.js';

export const authRouter = Router();

const SERVICE_NAME = 'auth-service';
const GATEWAY_HEALTH_PATH = '/api/v1/auth/health';

configureGoogleOAuth();

const healthResponse = () => ({
  status: 'ok',
  service: SERVICE_NAME,
});

authRouter.get('/health', (_req, res) => {
  res.status(200).json(healthResponse());
});

authRouter.get(GATEWAY_HEALTH_PATH, (_req, res) => {
  res.status(200).json(healthResponse());
});

authRouter.post(
  '/register',
  publicAuthRouteLimiter,
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password, userName } = parsed.data;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ message: 'Email already exists' });
      return;
    }

    // This endpoint is public and unauthenticated — self-registration must
    // never be able to grant THERAPIST or ADMIN. registerSchema still
    // accepts a `role` field for backward compatibility with any existing
    // caller, but it is intentionally ignored: every self-registered account
    // is a PATIENT, full stop. THERAPIST accounts are provisioned by
    // seed.ts; there is no self-service path to ADMIN at all.
    const role = 'PATIENT';
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, role },
      select: { id: true },
    });

    try {
      await publish('mindora.auth', {
        event: 'user.registered',
        userId: user.id,
        email,
        role,
        userName,
        registeredAt: new Date().toISOString(),
      });
      console.log(`Published user.registered event for userId=${user.id}`);
    } catch (queueError) {
      // Don't fail the request if RabbitMQ is down — the user record is
      // already saved. Profile creation is eventually consistent, not
      // synchronous with registration; the backfill script covers the gap.
      console.error('Failed to publish user.registered event:', queueError);
    }

    res.status(201).json({ userId: user.id });
  })
);

authRouter.post(
  '/login',
  loginRouteLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email, password } = parsed.data;
    const lockRemaining = await getLoginLockRemainingSeconds(email);
    if (lockRemaining > 0) {
      res.status(423).json({
        message:
          'Too many unsuccessful login attempts. Please try again in 15 minutes.',
        retryAfterSeconds: lockRemaining,
      });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    const validCredentials = Boolean(
      user && (await verifyPassword(user.passwordHash, password))
    );

    if (!validCredentials) {
      const failure = await recordLoginFailure(email);
      if (failure.lockedNow && user) {
        const lockedUntil = new Date(
          Date.now() + failure.retryAfterSeconds * 1000
        ).toISOString();
        try {
          await publishToExchange(EXCHANGES.AUTH, 'account.locked', {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            eventType: 'account.locked',
            recipientEmail: user.email,
            lockedUntil,
          });
        } catch (error) {
          console.error(
            '[auth] Failed to queue account-lock notification:',
            error
          );
        }
      }
      if (failure.locked) {
        res.status(423).json({
          message:
            'Too many unsuccessful login attempts. Your account is temporarily locked for 15 minutes.',
          retryAfterSeconds: failure.retryAfterSeconds,
        });
      } else {
        res.status(401).json({ message: 'Invalid credentials' });
      }
      return;
    }

    await clearLoginFailures(email);

    if (user!.isActive === false) {
      res.status(403).json({ message: 'Account suspended' });
      return;
    }

    const { accessToken } = await issueAuthSession(res, user!);
    res.status(200).json({ accessToken });
  })
);

authRouter.post(
  '/logout',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';

    try {
      const payload = verifyAccessToken(
        token,
        config.jwtSecret,
        config.jwtIssuer
      );
      if (payload.jti) {
        const decoded = jwt.decode(token) as jwt.JwtPayload | null;
        const exp = decoded?.exp ?? 0;
        const ttlSeconds = Math.max(0, exp - Math.floor(Date.now() / 1000));
        await blacklistToken(config.redisUrl, payload.jti, ttlSeconds);
      }
    } catch {
      // Token already invalid — still clear refresh cookie and return 200
    }

    const refreshToken = getRequestCookie(req, config.cookieName);
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: {
          tokenHash: hashToken(refreshToken),
          revoked: false,
        },
        data: { revoked: true },
      });
    }

    clearRefreshCookie(res);
    res.status(200).json({ message: 'Logged out' });
  })
);

authRouter.post(
  '/refresh',
  publicAuthRouteLimiter,
  asyncHandler(async (req, res) => {
    const refreshToken = getRequestCookie(req, config.cookieName);
    if (!refreshToken) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const tokenHash = hashToken(refreshToken);
    const stored = await prisma.refreshToken.findFirst({
      where: {
        tokenHash,
        revoked: false,
        replacedByTokenId: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!stored) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (stored.user.isActive === false) {
      res.status(403).json({ message: 'Account suspended' });
      return;
    }

    const newRefreshToken = createRefreshToken();
    const newRecord = await prisma.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: hashToken(newRefreshToken),
        expiresAt: getRefreshTokenExpiry(),
      },
    });

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: {
        revoked: true,
        replacedByTokenId: newRecord.id,
      },
    });

    const accessToken = signAccessToken({
      userId: stored.user.id,
      email: stored.user.email,
      role: stored.user.role,
    });

    setRefreshCookie(res, newRefreshToken);

    res.status(200).json({ accessToken });
  })
);

authRouter.post(
  '/forgot-password',
  publicAuthRouteLimiter,
  asyncHandler(async (req, res) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { email } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const resetToken = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(resetToken);
      let tokenStored = false;
      const resetUrl = `${config.appBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(resetToken)}`;
      try {
        await storePasswordResetToken(tokenHash, user.id);
        tokenStored = true;
        await publishToExchange(EXCHANGES.AUTH, 'password.reset', {
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          eventType: 'password.reset',
          recipientEmail: user.email,
          resetUrl,
          expiresInMinutes: 15,
        });
      } catch (error) {
        // Do not leave a usable token when storage or email enqueue fails.
        if (tokenStored)
          await deletePasswordResetToken(tokenHash).catch(() => undefined);
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        console.error(
          `[auth] Password reset request could not be queued (${errorName}); no recipient or token logged`
        );
      }
    }

    // Same public response for existing and unknown addresses. It deliberately
    // does not claim that an email was sent: delivery happens asynchronously
    // and can still fail at the provider.
    res.status(202).json({
      message:
        'If an account matches this address, a password reset message may be sent. This response does not confirm email delivery.',
    });
  })
);

authRouter.post(
  '/reset-password',
  publicAuthRouteLimiter,
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { token, newPassword } = parsed.data;
    const tokenHash = hashToken(token);
    const userId = await getPasswordResetUserId(tokenHash);

    if (!userId) {
      res.status(400).json({ message: 'Invalid or expired reset token' });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    await deletePasswordResetToken(tokenHash);
    const resetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (resetUser?.email) await clearLoginLock(resetUser.email);
    await prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });

    res.status(200).json({ message: 'Password updated successfully' });
  })
);

authRouter.get(
  '/me',
  authenticatedRouteLimiter,
  authenticate,
  (req, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    res.status(200).json({
      userId: authReq.user.userId,
      email: authReq.user.email,
      role: authReq.user.role,
    });
  }
);

// INTERNAL SERVICE ENDPOINT — not exposed through a public Kong auth-api
// route. Requires SERVICE role JWT in Authorization header. Same pattern as
// User Service's GET /internal/users/:id: returns 404 rather than 500 for a
// malformed (non-UUID) id, since that's an unauthenticated-shaped input
// error, not a server fault.
// SECURITY TODO: non-expiring service token in use — replace with rotating
// credentials via AWS Secrets Manager before production deployment.
// See: BACKEND_COMPLETE.md → "Known Security Limitations"
authRouter.get(
  '/internal/auth/users/:id',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const id = req.params.id as string;

    try {
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true },
      });
      if (!user) {
        res.status(404).json({ message: 'User not found' });
        return;
      }
      res.status(200).json(user);
    } catch {
      // Malformed id (not a UUID) or lookup failure — treat as not found
      res.status(404).json({ message: 'User not found' });
    }
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as
// GET /internal/auth/users/:id above. Backs Admin Service's user list via
// User Service's GET /internal/users proxy.
authRouter.get(
  '/internal/auth/users',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
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

    const { role, isActive, page, limit } = parsed.data;
    const where = {
      ...(role ? { role } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    };
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    res.status(200).json({ users, total, page, limit });
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as above.
// Originally only flipped isActive when Admin Service suspends a user; now
// also accepts role, for the one place a role ever changes post-registration
// — approving a therapist application (admin-service's approve route calls
// this with { role: 'THERAPIST' } after user-service marks the application
// APPROVED). Both fields are optional but at least one must be present;
// either can be sent alone.
authRouter.patch(
  '/internal/auth/users/:id',
  authenticatedRouteLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const { isActive, role } = req.body as {
      isActive?: unknown;
      role?: unknown;
    };
    const hasIsActive = typeof isActive === 'boolean';

    let validatedRole: string | undefined;
    if (role !== undefined) {
      const parsedRole = userRoleSchema.safeParse(role);
      if (!parsedRole.success) {
        res
          .status(400)
          .json({ message: 'role must be PATIENT, THERAPIST, or ADMIN' });
        return;
      }
      validatedRole = parsedRole.data;
    }

    if (!hasIsActive && validatedRole === undefined) {
      res
        .status(400)
        .json({ message: 'isActive (boolean) or role must be provided' });
      return;
    }

    const id = req.params.id as string;

    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(hasIsActive ? { isActive: isActive as boolean } : {}),
          ...(validatedRole !== undefined
            ? { role: validatedRole as UserRole }
            : {}),
        },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      if (hasIsActive) {
        // Redis is the fast-path every authenticated request checks (see
        // createVerifyJwt) — without this, a still-valid access token would
        // keep working until it naturally expires, even though isActive
        // (the source of truth, just written above) already says otherwise.
        await setUserSuspended(config.redisUrl, id, !isActive);

        // Revoking refresh tokens closes the other loophole: without this, a
        // suspended user whose access token has expired could still silently
        // mint a new one via POST /refresh.
        if (!isActive) {
          await prisma.refreshToken.updateMany({
            where: { userId: id, revoked: false },
            data: { revoked: true },
          });
        }
      }

      res.status(200).json(user);
    } catch {
      // Prisma throws on update-not-found (P2025) as well as malformed ids
      res.status(404).json({ message: 'User not found' });
    }
  })
);

// INTERNAL SERVICE ENDPOINT — same SERVICE-role convention as above.
// Backs Admin Service's platform-wide analytics aggregation.
//
// totalUsers/activeUsersLast30Days are kept exactly as before, semantics
// included (existing consumer: admin-service's original GET /analytics) —
// everything else is an additive extension for the newer
// GET /analytics/detailed.
//
// "Active" throughout = registered in the window OR had a RefreshToken row
// created in the window (login, or POST /refresh's rotation creating a new
// row) — matches the original activeUsersLast30Days definition exactly, so
// dau/wau/mau (new) and activeUsersLast30Days (existing) stay consistent
// with each other instead of quietly using different rules.
authRouter.get(
  '/internal/auth/analytics',
  authenticatedRouteLimiter,
  authenticate,
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
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const rangeFrom = parsed.data.from ?? thirtyDaysAgo;
    const rangeTo = parsed.data.to ?? now;

    const activeSince = (since: Date) =>
      prisma.user.count({
        where: {
          OR: [
            { createdAt: { gte: since } },
            { refreshTokens: { some: { createdAt: { gte: since } } } },
          ],
        },
      });

    const [
      totalUsers,
      activeUsersLast30Days,
      usersByRoleRaw,
      newUsersInRange,
      suspendedUsers,
      dau,
      wau,
      registrationTrendRaw,
    ] = await Promise.all([
      prisma.user.count(),
      activeSince(thirtyDaysAgo),
      prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      prisma.user.count({
        where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
      }),
      prisma.user.count({ where: { isActive: false } }),
      activeSince(oneDayAgo),
      activeSince(sevenDaysAgo),
      prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
        SELECT date_trunc('day', "created_at") AS bucket, COUNT(*)::bigint AS count
        FROM "users"
        WHERE "created_at" >= ${rangeFrom} AND "created_at" <= ${rangeTo}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    ]);

    const usersByRole = Object.fromEntries(
      usersByRoleRaw.map((r) => [r.role, r._count._all])
    );

    res.status(200).json({
      totalUsers,
      activeUsersLast30Days,
      usersByRole,
      newUsersInRange,
      suspendedUsers,
      dau,
      wau,
      mau: activeUsersLast30Days,
      registrationTrend: registrationTrendRaw.map((r) => ({
        date: r.bucket.toISOString().slice(0, 10),
        count: Number(r.count),
      })),
    });
  })
);

authRouter.get('/oauth/google', publicAuthRouteLimiter, (req, res, next) => {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({
      message:
        'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    });
    return;
  }
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  })(req, res, next);
});

authRouter.get(
  '/oauth/google/callback',
  publicAuthRouteLimiter,
  (req, res, next) => {
    // This endpoint is only ever hit by a real browser navigation (Google's
    // own redirect back to us), never fetch/XHR — every exit path below must
    // be a redirect, not a JSON response, or the user's browser is left
    // stranded on this API origin instead of landing back on the frontend.
    // The frontend's /oauth/success route does no token parsing; it just
    // waits on its own mount-time POST /refresh to pick up the refreshToken
    // cookie issueAuthSession sets below (same mechanism as normal login),
    // then routes by role, or back to /login if no session was established
    // — so redirecting there unconditionally on both success and failure is
    // correct, not just a shortcut.
    if (!isGoogleOAuthConfigured()) {
      res.redirect(config.oauthSuccessRedirectUrl);
      return;
    }

    passport.authenticate('google', { session: false }, (err, user) => {
      // Not routed through asyncHandler — this is passport's own callback
      // shape (err, user), not an Express (req, res) handler — so a rejected
      // promise here needs its own explicit catch to reach next(), same
      // reasoning as asyncHandler elsewhere in this file.
      (async () => {
        if (err || !user) {
          res.redirect(config.oauthSuccessRedirectUrl);
          return;
        }

        await issueAuthSession(res, user);
        res.redirect(config.oauthSuccessRedirectUrl);
      })().catch(next);
    })(req, res, next);
  }
);
