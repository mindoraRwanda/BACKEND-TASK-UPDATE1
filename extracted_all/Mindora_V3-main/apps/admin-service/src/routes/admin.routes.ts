import { Router } from 'express';
import type { AuthenticatedRequest } from '@mindora/auth-middleware';
import { callService, httpClient, sanitizeForLog } from '@mindora/http-client';
import {
  adminAddApplicationNoteSchema,
  adminRejectApplicationSchema,
  adminRequestInfoApplicationSchema,
  analyticsRangeQuerySchema,
  listAlertsQuerySchema,
  listAuditLogQuerySchema,
  listUsersQuerySchema,
  resolveModerationSchema,
  suspendUserSchema,
} from '@mindora/validation';
import type { Prisma } from '../generated/prisma/index.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { prisma } from '../lib/prisma.js';

export const adminRouter = Router();

// Apply admin guard to all routes
adminRouter.use(requireAdmin);

const KONG_URL = process.env.KONG_URL ?? 'http://localhost:8000';

type AuthUserRecord = {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
};

// User management

// GET /users — reached with the caller's own admin JWT (requireAdmin above
// already confirmed ADMIN), but the downstream call to User Service uses the
// INTERNAL_SERVICE_TOKEN, not that JWT — every inter-service hop in this
// codebase authenticates as SERVICE, never relays a user's own token.
adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
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
    }>(KONG_URL, `/internal/users?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    res.status(200).json(response.data);
  })
);

adminRouter.put(
  '/users/:id/suspend',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = suspendUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const userId = req.params.id as string;
    const { reason } = parsed.data;

    const response = await callService<{ message: string; userId: string }>(
      KONG_URL,
      `/internal/users/${encodeURIComponent(userId)}/suspend`,
      {
        method: 'PUT',
        body: { reason },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    if (!response.ok) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    // Audit log is written only after User Service confirms the suspension
    // actually happened — never record an action that didn't complete.
    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'USER_SUSPENDED',
        targetId: userId,
        metadata: { reason, suspendedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'User suspended',
      userId,
      auditLogId: auditLog.id,
    });
  })
);

// Mirrors PUT /users/:id/suspend above — same role gate (requireAdmin,
// applied to the whole router), same body shape (reused suspendUserSchema:
// { reason: string }), same "audit log only after the downstream call
// succeeds" rule.
adminRouter.put(
  '/users/:id/reactivate',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = suspendUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const userId = req.params.id as string;
    const { reason } = parsed.data;

    const response = await callService<{ message: string; userId: string }>(
      KONG_URL,
      `/internal/users/${encodeURIComponent(userId)}/reactivate`,
      {
        method: 'PUT',
        body: { reason },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    if (!response.ok) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'USER_REACTIVATED',
        targetId: userId,
        metadata: { reason, reactivatedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'User reactivated',
      userId,
      auditLogId: auditLog.id,
    });
  })
);

// Therapist applications

type TherapistApplicationRecord = {
  id: string;
  userId: string;
  status: string;
};

adminRouter.get(
  '/therapist-applications',
  asyncHandler(async (req, res) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') query.set(key, value);
    }

    const response = await httpClient.get<{
      applications: TherapistApplicationRecord[];
      total: number;
      page: number;
      limit: number;
    }>(KONG_URL, `/internal/users/therapist-applications?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    res.status(200).json(response.data);
  })
);

adminRouter.get(
  '/therapist-applications/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;

    const response = await httpClient.get<{
      application: TherapistApplicationRecord;
    }>(
      KONG_URL,
      `/internal/users/therapist-applications/${encodeURIComponent(id)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'Application not found' });
      return;
    }
    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    res.status(200).json(response.data);
  })
);

// Approve: two downstream calls, in order — User Service marks the
// application APPROVED (and upserts the TherapistProfile) first, then Auth
// Service flips role -> THERAPIST (the source of truth for role). If the
// second call fails, the application is already APPROVED and the profile
// already created, but the account is still PATIENT-role — this codebase
// has no distributed-transaction/rollback mechanism for any cross-service
// flow (same limitation applies to every other multi-call admin action
// here), so that partial state is surfaced as a 503 telling the admin to
// retry rather than silently dropped. A reconciliation endpoint would be a
// reasonable follow-up but is out of scope for this milestone. The audit
// log is written only once both calls have succeeded, per this file's
// existing "never record an action that didn't complete" rule.
adminRouter.put(
  '/therapist-applications/:id/approve',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;

    const statusResponse = await callService<{
      application: TherapistApplicationRecord;
    }>(
      KONG_URL,
      `/internal/users/therapist-applications/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: { status: 'APPROVED', reviewedBy: authReq.user!.userId },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (statusResponse.status === 404) {
      res.status(404).json({ message: 'Application not found' });
      return;
    }
    if (statusResponse.status === 409) {
      res.status(409).json({
        message: 'Application cannot be approved from its current status',
      });
      return;
    }
    if (!statusResponse.ok || !statusResponse.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const { userId } = statusResponse.data.application;

    const roleResponse = await callService<{ id: string; role: string }>(
      KONG_URL,
      `/internal/auth/users/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        body: { role: 'THERAPIST' },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (!roleResponse.ok) {
      console.error(
        `Application ${sanitizeForLog(String(id))} approved but role activation failed for user ${sanitizeForLog(String(userId))}`
      );
      res.status(503).json({
        message:
          'Application approved but role activation failed — retry required',
        userId,
      });
      return;
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'THERAPIST_APPLICATION_APPROVED',
        targetId: id,
        metadata: { userId, approvedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'Application approved',
      application: statusResponse.data.application,
      auditLogId: auditLog.id,
    });
  })
);

adminRouter.put(
  '/therapist-applications/:id/reject',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = adminRejectApplicationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const id = req.params.id as string;
    const { reason } = parsed.data;

    const statusResponse = await callService<{
      application: TherapistApplicationRecord;
    }>(
      KONG_URL,
      `/internal/users/therapist-applications/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: { status: 'REJECTED', reviewedBy: authReq.user!.userId, reason },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (statusResponse.status === 404) {
      res.status(404).json({ message: 'Application not found' });
      return;
    }
    if (statusResponse.status === 409) {
      res.status(409).json({
        message: 'Application cannot be rejected from its current status',
      });
      return;
    }
    if (!statusResponse.ok || !statusResponse.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'THERAPIST_APPLICATION_REJECTED',
        targetId: id,
        metadata: { reason, rejectedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'Application rejected',
      application: statusResponse.data.application,
      auditLogId: auditLog.id,
    });
  })
);

adminRouter.put(
  '/therapist-applications/:id/request-info',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = adminRequestInfoApplicationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const id = req.params.id as string;
    const { note } = parsed.data;

    const statusResponse = await callService<{
      application: TherapistApplicationRecord;
    }>(
      KONG_URL,
      `/internal/users/therapist-applications/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: {
          status: 'MORE_INFORMATION_REQUIRED',
          reviewedBy: authReq.user!.userId,
          note,
        },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (statusResponse.status === 404) {
      res.status(404).json({ message: 'Application not found' });
      return;
    }
    if (statusResponse.status === 409) {
      res.status(409).json({
        message:
          "Cannot request more information from the application's current status",
      });
      return;
    }
    if (!statusResponse.ok || !statusResponse.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'THERAPIST_APPLICATION_MORE_INFO_REQUESTED',
        targetId: id,
        metadata: { note, requestedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'More information requested',
      application: statusResponse.data.application,
      auditLogId: auditLog.id,
    });
  })
);

adminRouter.post(
  '/therapist-applications/:id/notes',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = adminAddApplicationNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const id = req.params.id as string;
    const adminId = authReq.user!.userId;

    const response = await callService<{ note: unknown }>(
      KONG_URL,
      `/internal/users/therapist-applications/${encodeURIComponent(id)}/notes`,
      {
        method: 'POST',
        body: { authorId: adminId, note: parsed.data.note },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'Application not found' });
      return;
    }
    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId,
        actionType: 'THERAPIST_APPLICATION_NOTE_ADDED',
        targetId: id,
        metadata: { notedAt: new Date().toISOString() },
      },
    });

    res.status(201).json({ note: response.data.note, auditLogId: auditLog.id });
  })
);

// Suspend/reactivate an already-approved therapist — distinct from the
// generic /users/:id/suspend above (which any admin action against any
// account uses) so the audit trail can tell conduct-based therapist
// suspension apart from generic account moderation. Two downstream calls,
// strictly in order: User Service's existing /internal/users/:id/suspend
// proxy (the real access revocation — isActive=false on Auth Service, Redis
// flag, refresh tokens revoked) must succeed BEFORE the discovery-visibility
// flag below is touched. Fail-closed: a therapist must never end up hidden
// from patient-facing search while still fully usable via a live token, or
// the reverse (visible in search but actually locked out).
adminRouter.put(
  '/therapists/:id/suspend',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = suspendUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const userId = req.params.id as string;
    const { reason } = parsed.data;

    const suspendResponse = await callService<{
      message: string;
      userId: string;
    }>(KONG_URL, `/internal/users/${encodeURIComponent(userId)}/suspend`, {
      method: 'PUT',
      body: { reason },
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });

    if (suspendResponse.status === 404) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    if (!suspendResponse.ok) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const flagResponse = await callService<{
      userId: string;
      isSuspended: boolean;
    }>(
      KONG_URL,
      `/internal/users/${encodeURIComponent(userId)}/therapist-suspension`,
      {
        method: 'PATCH',
        body: { isSuspended: true },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );
    if (!flagResponse.ok) {
      // Access is already revoked (the security-critical half, above) —
      // only the discovery-visibility flag failed to update. Not rolled
      // back; logged so it can be reconciled manually.
      console.error(
        `Therapist ${sanitizeForLog(String(userId))} suspended but discovery flag update failed`
      );
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'THERAPIST_SUSPENDED',
        targetId: userId,
        metadata: { reason, suspendedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'Therapist suspended',
      userId,
      auditLogId: auditLog.id,
    });
  })
);

adminRouter.put(
  '/therapists/:id/reactivate',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = suspendUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const userId = req.params.id as string;
    const { reason } = parsed.data;

    const reactivateResponse = await callService<{
      message: string;
      userId: string;
    }>(KONG_URL, `/internal/users/${encodeURIComponent(userId)}/reactivate`, {
      method: 'PUT',
      body: { reason },
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });

    if (reactivateResponse.status === 404) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    if (!reactivateResponse.ok) {
      res.status(503).json({ message: 'User Service unavailable' });
      return;
    }

    const flagResponse = await callService<{
      userId: string;
      isSuspended: boolean;
    }>(
      KONG_URL,
      `/internal/users/${encodeURIComponent(userId)}/therapist-suspension`,
      {
        method: 'PATCH',
        body: { isSuspended: false },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );
    if (!flagResponse.ok) {
      console.error(
        `Therapist ${sanitizeForLog(String(userId))} reactivated but discovery flag update failed`
      );
    }

    const auditLog = await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'THERAPIST_REACTIVATED',
        targetId: userId,
        metadata: { reason, reactivatedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({
      message: 'Therapist reactivated',
      userId,
      auditLogId: auditLog.id,
    });
  })
);

// Moderation

// Pull-based, not event-driven: community-service publishes a
// community.reported RabbitMQ event on every report, but nothing consumes
// it — this proxies live to community-service's own report list instead of
// mirroring reports into a new local table. Keeps admin-service's schema
// unchanged; the event is currently unused (flagged, not acted on further).
adminRouter.get(
  '/moderation/queue',
  asyncHandler(async (req, res) => {
    const page = (req.query.page as string) ?? '1';
    const limit = (req.query.limit as string) ?? '20';

    const response = await httpClient.get<{
      reports: unknown[];
      total: number;
      page: number;
      limit: number;
    }>(
      KONG_URL,
      `/internal/community/reports?status=PENDING&page=${page}&limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'Community Service unavailable' });
      return;
    }

    res.status(200).json(response.data);
  })
);

// decision REMOVED maps to community's REVIEWED status (community has no
// REMOVED value — admin-service's own moderation_decisions row below is the
// record of what was actually decided; community's status just needs to
// reflect "no longer pending").
adminRouter.put(
  '/moderation/:id/resolve',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const parsed = resolveModerationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const reportId = req.params.id as string;
    const { decision, reason } = parsed.data;
    const communityStatus = decision === 'REMOVED' ? 'REVIEWED' : 'DISMISSED';

    const response = await callService<{
      _id: string;
      contentId: string;
      contentType: string;
    }>(
      KONG_URL,
      `/internal/community/reports/${encodeURIComponent(reportId)}/resolve`,
      {
        method: 'PUT',
        body: { status: communityStatus },
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'Report not found' });
      return;
    }

    if (!response.ok) {
      res.status(503).json({ message: 'Community Service unavailable' });
      return;
    }

    // moderation_decisions is the structured, domain-specific record;
    // audit_logs is the universal admin-action trail — both are written,
    // only after Community Service confirms the resolution actually happened.
    const decisionRecord = await prisma.moderation_decisions.create({
      data: { reportId, adminId: authReq.user!.userId, decision, reason },
    });

    await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'REPORT_RESOLVED',
        targetId: reportId,
        metadata: {
          decision,
          reason,
          contentId: response.data?.contentId ?? null,
          contentType: response.data?.contentType ?? null,
        },
      },
    });

    res.status(200).json({
      message: 'Report resolved',
      reportId,
      decision,
      moderationDecisionId: decisionRecord.id,
    });
  })
);

// Reveals the real identity behind an anonymous post — sensitive enough to
// audit like AI_USAGE_VIEWED: logged only after a successful lookup.
adminRouter.post(
  '/moderation/decrypt/:postId',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const postId = req.params.postId as string;

    const response = await httpClient.get<{ userId: string }>(
      KONG_URL,
      `/internal/community/posts/${encodeURIComponent(postId)}/author`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'Community Service unavailable' });
      return;
    }

    await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'POST_AUTHOR_DECRYPTED',
        targetId: postId,
        metadata: { decryptedAt: new Date().toISOString() },
      },
    });

    res.status(200).json({ postId, userId: response.data.userId });
  })
);

// Appointment register — admin-only read proxy to Appointment Service.
adminRouter.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const status =
      typeof req.query.status === 'string' ? req.query.status : undefined;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      res.status(400).json({ message: 'Invalid pagination parameters' });
      return;
    }
    if (
      status &&
      !['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'].includes(status)
    ) {
      res.status(400).json({ message: 'Invalid appointment status' });
      return;
    }

    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (status) query.set('status', status);
    const response = await httpClient.get<{
      appointments: {
        id: string;
        patientId: string;
        therapistId: string;
        slotStart: string;
        slotEnd: string;
        sessionType: string;
        status: string;
        createdAt: string;
      }[];
      total: number;
      page: number;
      limit: number;
    }>(KONG_URL, `/internal/appointments/list?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      },
    });

    if (!response.ok || !response.data) {
      res.status(503).json({ message: 'Appointment Service unavailable' });
      return;
    }
    res.status(200).json(response.data);
  })
);

// Analytics — every downstream call is independent and null-safe: one
// service being down degrades that slice of the response, never the whole
// request. All fired in parallel so nothing waits on anything else.
adminRouter.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const serviceHeaders = {
      Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
    };

    const [userStats, appointmentStats, moodStats, aiStats] = await Promise.all(
      [
        httpClient.get<{ totalUsers: number; activeUsersLast30Days: number }>(
          KONG_URL,
          '/internal/users/analytics',
          { headers: serviceHeaders }
        ),
        httpClient.get<{
          totalAppointments: number;
          completedAppointments: number;
        }>(KONG_URL, '/internal/appointments/analytics', {
          headers: serviceHeaders,
        }),
        httpClient.get<{
          totalMoodEntries: number;
          avgMoodScorePlatform: number | null;
        }>(KONG_URL, '/internal/mood/analytics', { headers: serviceHeaders }),
        // /api/v1/ai/usage requires an ADMIN JWT specifically (requireRole('ADMIN')
        // in ai-integration-service) — the SERVICE token used for every other call
        // here would be rejected there, so this one forwards the caller's own token.
        httpClient.get<{
          totalInteractions: number;
          totalCrisisEvents: number;
        }>(KONG_URL, '/api/v1/ai/usage', {
          headers: { Authorization: req.headers.authorization ?? '' },
        }),
      ]
    );

    res.status(200).json({
      totalUsers: userStats.ok ? (userStats.data?.totalUsers ?? null) : null,
      activeUsersLast30Days: userStats.ok
        ? (userStats.data?.activeUsersLast30Days ?? null)
        : null,
      totalAppointments: appointmentStats.ok
        ? (appointmentStats.data?.totalAppointments ?? null)
        : null,
      completedAppointments: appointmentStats.ok
        ? (appointmentStats.data?.completedAppointments ?? null)
        : null,
      totalMoodEntries: moodStats.ok
        ? (moodStats.data?.totalMoodEntries ?? null)
        : null,
      avgMoodScorePlatform: moodStats.ok
        ? (moodStats.data?.avgMoodScorePlatform ?? null)
        : null,
      totalCommunityPosts: null, // Community Service not deployed in V1
      totalAiInteractions: aiStats.ok
        ? (aiStats.data?.totalInteractions ?? null)
        : null,
      totalCrisisEvents: aiStats.ok
        ? (aiStats.data?.totalCrisisEvents ?? null)
        : null,
    });
  })
);

// Detailed analytics for the charts-driven Analytics page — distinct from
// GET /analytics above (kept as-is, still backs the plain Overview stat
// cards). Same null-safe-per-service convention: each top-level section is
// null if that service was unreachable, never the whole request. `from`/
// `to` are forwarded to every downstream service so a single date-range
// picker on the frontend drives all three sections consistently.
adminRouter.get(
  '/analytics/detailed',
  asyncHandler(async (req, res) => {
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

    const query = new URLSearchParams({
      from: rangeFrom.toISOString(),
      to: rangeTo.toISOString(),
    });
    const serviceHeaders = {
      Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
    };

    type UserAnalytics = {
      totalUsers: number;
      usersByRole: Record<string, number>;
      newUsersInRange: number;
      suspendedUsers: number;
      dau: number;
      wau: number;
      mau: number;
      registrationTrend: { date: string; count: number }[];
      therapistApplications: {
        byStatus: Record<string, number>;
        approvalRate: number;
        rejectionRate: number;
        applicationTrend: { date: string; count: number }[];
      };
      totalTherapists: number;
      suspendedTherapists: number;
    };

    type AppointmentAnalytics = {
      totalAppointments: number;
      completedAppointments: number;
      statusBreakdown: Record<string, number>;
      completionRate: number;
      cancellationRate: number;
      sessionTrend: {
        date: string;
        completed: number;
        cancelled: number;
        pending: number;
        confirmed: number;
      }[];
    };

    const [userStats, appointmentStats] = await Promise.all([
      httpClient.get<UserAnalytics>(
        KONG_URL,
        `/internal/users/analytics?${query.toString()}`,
        { headers: serviceHeaders }
      ),
      httpClient.get<AppointmentAnalytics>(
        KONG_URL,
        `/internal/appointments/analytics?${query.toString()}`,
        { headers: serviceHeaders }
      ),
    ]);

    res.status(200).json({
      range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
      users:
        userStats.ok && userStats.data
          ? {
              totalUsers: userStats.data.totalUsers,
              usersByRole: userStats.data.usersByRole,
              newUsersInRange: userStats.data.newUsersInRange,
              suspendedUsers: userStats.data.suspendedUsers,
              dau: userStats.data.dau,
              wau: userStats.data.wau,
              mau: userStats.data.mau,
              registrationTrend: userStats.data.registrationTrend,
            }
          : null,
      therapists:
        userStats.ok && userStats.data
          ? {
              totalTherapists: userStats.data.totalTherapists,
              suspendedTherapists: userStats.data.suspendedTherapists,
              applications: userStats.data.therapistApplications,
            }
          : null,
      appointments: appointmentStats.ok ? appointmentStats.data : null,
    });
  })
);

// Audit log — read only, no update or delete routes (hard requirement,
// see the "Do not" list this service was scaffolded under).
adminRouter.get(
  '/audit-log',
  asyncHandler(async (req, res) => {
    const parsed = listAuditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { adminId, actionType, targetId, startDate, endDate, page, limit } =
      parsed.data;
    const where: Prisma.audit_logsWhereInput = {
      ...(adminId ? { adminId } : {}),
      ...(actionType ? { actionType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };
    const skip = (page - 1) * limit;

    const [auditLogs, total] = await Promise.all([
      prisma.audit_logs.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.audit_logs.count({ where }),
    ]);

    res.status(200).json({ auditLogs, total, page, limit });
  })
);

// System alerts — created by the ai.crisis / mood.concern RabbitMQ
// consumers in consumers.ts, never by an admin route directly.
adminRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const parsed = listAlertsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit } = parsed.data;
    const skip = (page - 1) * limit;
    const where = { resolved: false };

    const [alerts, total] = await Promise.all([
      prisma.system_alerts.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.system_alerts.count({ where }),
    ]);

    res.status(200).json({ alerts, total, page, limit });
  })
);

adminRouter.put(
  '/alerts/:id/resolve',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;

    const alert = await prisma.system_alerts.findUnique({ where: { id } });
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    await prisma.system_alerts.update({
      where: { id },
      data: { resolved: true },
    });

    await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'ALERT_RESOLVED',
        targetId: id,
        metadata: { eventType: alert.eventType, severity: alert.severity },
      },
    });

    res.status(200).json({ message: 'Alert resolved', id });
  })
);

// AI usage proxy — forwards the caller's own JWT, not the internal service
// token: /api/v1/ai/usage requires requireRole('ADMIN') on ai-integration-
// service, which a SERVICE-role token would fail. Audit log is written only
// after a successful fetch (consistent with every other write in this file
// — "viewed" should mean they actually saw the data, not merely attempted to).
adminRouter.get(
  '/ai/usage',
  asyncHandler(async (req, res) => {
    const authReq = req as unknown as AuthenticatedRequest;

    const response = await httpClient.get<Record<string, unknown>>(
      KONG_URL,
      '/api/v1/ai/usage',
      { headers: { Authorization: req.headers.authorization ?? '' } }
    );

    if (!response.ok || !response.data) {
      res
        .status(response.status || 503)
        .json({ message: 'AI Service unavailable' });
      return;
    }

    await prisma.audit_logs.create({
      data: {
        adminId: authReq.user!.userId,
        actionType: 'AI_USAGE_VIEWED',
        metadata: { viewedAt: new Date().toISOString() },
      },
    });

    res.status(200).json(response.data);
  })
);
