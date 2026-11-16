import { Readable } from 'node:stream';
import {
  Router,
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';
import multer from 'multer';
import type { AuthenticatedRequest } from '@mindora/auth-middleware';
import {
  ALLOWED_CV_TYPES_MESSAGE,
  ALLOWED_PHOTO_TYPES_MESSAGE,
  MAX_UPLOAD_BYTES,
  detectImageType,
  isPdf,
  listAdminTherapistsQuerySchema,
  updateTherapistProfileSchema,
} from '@mindora/validation';
import { asyncHandler } from '../middleware/async-handler.js';
import { prisma } from '../lib/prisma.js';

// Admin management of therapist photo / CV / short CV. The caller is already
// a verified ADMIN (authenticate + requireAdmin run before this router, see
// admin.routes.ts). Files are parsed and checked here, then forwarded to User
// Service (which owns therapist_profiles) as the raw body, authenticated with
// INTERNAL_SERVICE_TOKEN like every other inter-service hop. An audit_logs row
// is written only after User Service confirms the change.
export const therapistMediaRouter = Router();

const KONG_URL = process.env.KONG_URL ?? 'http://localhost:8000';
const UPSTREAM_TIMEOUT_MS = 30_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Memory storage: files are capped at 5 MB and forwarded, never written to
// this service's disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
}).single('file');

function parseUpload(
  req: Request,
  res: ExpressResponse,
  next: NextFunction
): void {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ message: 'File is too large (max 5 MB)' });
        return;
      }
      res.status(400).json({ message: `Invalid upload: ${err.message}` });
      return;
    }
    next(err);
  });
}

function validUserId(req: Request, res: ExpressResponse): string | null {
  const userId = req.params.userId as string;
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ message: 'userId must be a UUID' });
    return null;
  }
  return userId;
}

async function callUserService(
  path: string,
  init: { method: string; body?: Buffer | string; contentType?: string }
): Promise<globalThis.Response | null> {
  try {
    return await fetch(`${KONG_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
        ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

// Statuses that mean "your request was wrong" are passed through with User
// Service's message; anything else is reported as an upstream failure.
const PASS_THROUGH = new Set([400, 404, 413, 415]);

async function failFromUpstream(
  res: ExpressResponse,
  upstream: globalThis.Response | null
): Promise<void> {
  if (!upstream) {
    res.status(503).json({ message: 'User Service unavailable' });
    return;
  }
  if (PASS_THROUGH.has(upstream.status)) {
    const body = (await upstream.json().catch(() => ({}))) as {
      message?: string;
      errors?: unknown;
    };
    res.status(upstream.status).json({
      message: body.message ?? 'Request rejected',
      ...(body.errors ? { errors: body.errors } : {}),
    });
    return;
  }
  res.status(502).json({ message: 'User Service error' });
}

async function audit(
  req: Request,
  actionType: string,
  targetId: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const authReq = req as unknown as AuthenticatedRequest;
  const log = await prisma.audit_logs.create({
    data: {
      adminId: authReq.user!.userId,
      actionType,
      targetId,
      metadata: metadata as never,
    },
  });
  return log.id;
}

const base = (userId: string) =>
  `/internal/users/therapists/${encodeURIComponent(userId)}`;

// Forwards a mutating call, then audits. Shared by every PUT/DELETE below.
async function mutate(
  req: Request,
  res: ExpressResponse,
  opts: {
    userId: string;
    path: string;
    method: 'PUT' | 'DELETE';
    body?: Buffer | string;
    contentType?: string;
    actionType: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const upstream = await callUserService(opts.path, {
    method: opts.method,
    body: opts.body,
    contentType: opts.contentType,
  });
  if (!upstream || !upstream.ok) {
    await failFromUpstream(res, upstream);
    return;
  }
  const { therapist } = (await upstream.json()) as { therapist: unknown };
  const auditLogId = await audit(
    req,
    opts.actionType,
    opts.userId,
    opts.metadata
  );
  res.status(200).json({ therapist, auditLogId });
}

therapistMediaRouter.get(
  '/therapists',
  asyncHandler(async (req, res) => {
    const parsed = listAdminTherapistsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const upstream = await callUserService(
      `/internal/users/therapists?${query.toString()}`,
      { method: 'GET' }
    );
    if (!upstream || !upstream.ok) {
      await failFromUpstream(res, upstream);
      return;
    }
    res.status(200).json(await upstream.json());
  })
);

therapistMediaRouter.put(
  '/therapists/:userId/photo',
  parseUpload,
  asyncHandler(async (req, res) => {
    const userId = validUserId(req, res);
    if (!userId) return;
    if (!req.file) {
      res
        .status(400)
        .json({ message: 'Send the image as multipart field "file"' });
      return;
    }
    const type = detectImageType(req.file.buffer);
    if (!type) {
      res.status(415).json({ message: ALLOWED_PHOTO_TYPES_MESSAGE });
      return;
    }
    await mutate(req, res, {
      userId,
      path: `${base(userId)}/photo`,
      method: 'PUT',
      body: req.file.buffer,
      contentType: 'application/octet-stream',
      actionType: 'THERAPIST_PHOTO_UPDATED',
      metadata: { imageType: type, sizeBytes: req.file.size },
    });
  })
);

therapistMediaRouter.delete(
  '/therapists/:userId/photo',
  asyncHandler(async (req, res) => {
    const userId = validUserId(req, res);
    if (!userId) return;
    await mutate(req, res, {
      userId,
      path: `${base(userId)}/photo`,
      method: 'DELETE',
      actionType: 'THERAPIST_PHOTO_REMOVED',
      metadata: {},
    });
  })
);

therapistMediaRouter.put(
  '/therapists/:userId/cv',
  parseUpload,
  asyncHandler(async (req, res) => {
    const userId = validUserId(req, res);
    if (!userId) return;
    if (!req.file) {
      res
        .status(400)
        .json({ message: 'Send the PDF as multipart field "file"' });
      return;
    }
    if (!isPdf(req.file.buffer)) {
      res.status(415).json({ message: ALLOWED_CV_TYPES_MESSAGE });
      return;
    }
    const fileName = req.file.originalname;
    await mutate(req, res, {
      userId,
      path: `${base(userId)}/cv?fileName=${encodeURIComponent(fileName)}`,
      method: 'PUT',
      body: req.file.buffer,
      contentType: 'application/pdf',
      actionType: 'THERAPIST_CV_UPLOADED',
      metadata: { fileName, sizeBytes: req.file.size },
    });
  })
);

// Admin-only download. Every CV read is audited (it is personal data), and
// the response is forced to download with nosniff so a browser never renders
// or sniffs it as anything but an attachment.
therapistMediaRouter.get(
  '/therapists/:userId/cv',
  asyncHandler(async (req, res) => {
    const userId = validUserId(req, res);
    if (!userId) return;
    const upstream = await callUserService(`${base(userId)}/cv`, {
      method: 'GET',
    });
    if (!upstream || !upstream.ok || !upstream.body) {
      await failFromUpstream(res, upstream);
      return;
    }
    await audit(req, 'THERAPIST_CV_DOWNLOADED', userId, {});
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      upstream.headers.get('content-disposition') ??
        'attachment; filename="cv.pdf"'
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(upstream.body as never).pipe(res);
  })
);

therapistMediaRouter.delete(
  '/therapists/:userId/cv',
  asyncHandler(async (req, res) => {
    const userId = validUserId(req, res);
    if (!userId) return;
    await mutate(req, res, {
      userId,
      path: `${base(userId)}/cv`,
      method: 'DELETE',
      actionType: 'THERAPIST_CV_REMOVED',
      metadata: {},
    });
  })
);

therapistMediaRouter.put(
  '/therapists/:userId/profile',
  asyncHandler(async (req, res) => {
    const userId = validUserId(req, res);
    if (!userId) return;
    const parsed = updateTherapistProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    // Audit records which fields changed and how long the text is, not the
    // text itself (it is public content, but the log stays compact).
    await mutate(req, res, {
      userId,
      path: `${base(userId)}/profile`,
      method: 'PUT',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
      actionType: 'THERAPIST_PROFILE_UPDATED',
      metadata: {
        fields: Object.keys(parsed.data),
        cvSummaryLength: parsed.data.cvSummary?.length ?? null,
        bioLength: parsed.data.bio?.length ?? null,
      },
    });
  })
);
