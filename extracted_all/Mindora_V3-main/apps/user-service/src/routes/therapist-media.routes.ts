import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  ALLOWED_CV_TYPES_MESSAGE,
  ALLOWED_PHOTO_TYPES_MESSAGE,
  MAX_UPLOAD_BYTES,
  detectImageType,
  isPdf,
  listAdminTherapistsQuerySchema,
  updateTherapistProfileSchema,
} from '@mindora/validation';
import type { Prisma } from '../generated/prisma/index.js';
import { prisma } from '../lib/prisma.js';
import {
  deleteDocumentByKey,
  streamDocumentByKey,
  uploadDocument,
} from '../lib/object-storage.js';
import {
  buildCvStorageKey,
  deleteOwnPhotoFile,
  sanitizeFileName,
  savePhoto,
  toAdminTherapistSummary,
} from '../lib/therapist-media.js';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  verifyJwt,
  type AuthenticatedRequest,
} from '../middleware/authenticate.js';
import { authenticatedRouteLimiter } from '../middleware/rate-limit.js';

// INTERNAL SERVICE ENDPOINTS for admin-managed therapist photo / CV / short
// CV. Called only by admin-service (which authenticates the human admin,
// enforces the role and writes the audit log); here the caller must be the
// SERVICE role, same convention as the other /internal/users routes.
//
// Mounted in app.ts BEFORE userRouter: userRouter's GET /internal/users/:id
// would otherwise treat "therapists" as an :id and shadow the list route.
export const therapistMediaRouter = Router();

therapistMediaRouter.use(
  '/internal/users/therapists',
  authenticatedRouteLimiter,
  verifyJwt,
  (req, res, next) => {
    if ((req as AuthenticatedRequest).user?.role !== 'SERVICE') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    next();
  }
);

// Files arrive as the raw request body (admin-service parsed the multipart
// form and forwards the validated bytes). Any content type is accepted here
// on purpose: the type is decided from the bytes, never the header.
const rawFile = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

function getUploadedBytes(req: Request, res: Response): Buffer | null {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ message: 'No file received' });
    return null;
  }
  return req.body;
}

async function findProfile(userId: string, res: Response) {
  const profile = await prisma.therapistProfile.findUnique({
    where: { userId },
  });
  if (!profile) {
    res.status(404).json({ message: 'Therapist not found' });
    return null;
  }
  return profile;
}

therapistMediaRouter.get(
  '/internal/users/therapists',
  asyncHandler(async (req, res) => {
    const parsed = listAdminTherapistsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { page, limit, search, missing } = parsed.data;

    const and: Prisma.TherapistProfileWhereInput[] = [];
    if (search) {
      and.push({
        OR: [
          { userName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (missing === 'photo') {
      and.push({ OR: [{ photoUrl: null }, { photoUrl: '' }] });
    } else if (missing === 'cv') {
      and.push({ cvStorageKey: null });
    } else if (missing === 'summary') {
      and.push({ OR: [{ cvSummary: null }, { cvSummary: '' }] });
    }
    const where: Prisma.TherapistProfileWhereInput = { AND: and };

    const [rows, total] = await Promise.all([
      prisma.therapistProfile.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ userName: 'asc' }, { id: 'asc' }],
      }),
      prisma.therapistProfile.count({ where }),
    ]);

    res.status(200).json({
      therapists: rows.map(toAdminTherapistSummary),
      total,
      page,
      limit,
    });
  })
);

therapistMediaRouter.put(
  '/internal/users/therapists/:userId/photo',
  rawFile,
  asyncHandler(async (req, res) => {
    const bytes = getUploadedBytes(req, res);
    if (!bytes) return;
    const type = detectImageType(bytes);
    if (!type) {
      res.status(415).json({ message: ALLOWED_PHOTO_TYPES_MESSAGE });
      return;
    }
    const existing = await findProfile(req.params.userId as string, res);
    if (!existing) return;

    // No image library is installed, so the validated file is stored as
    // uploaded (no crop/resize/metadata strip).
    const saved = await savePhoto(bytes, type);
    const updated = await prisma.therapistProfile.update({
      where: { userId: existing.userId },
      data: { photoUrl: saved.url },
    });
    await deleteOwnPhotoFile(existing.photoUrl);
    res.status(200).json({ therapist: toAdminTherapistSummary(updated) });
  })
);

therapistMediaRouter.delete(
  '/internal/users/therapists/:userId/photo',
  asyncHandler(async (req, res) => {
    const existing = await findProfile(req.params.userId as string, res);
    if (!existing) return;
    const updated = await prisma.therapistProfile.update({
      where: { userId: existing.userId },
      data: { photoUrl: null },
    });
    await deleteOwnPhotoFile(existing.photoUrl);
    res.status(200).json({ therapist: toAdminTherapistSummary(updated) });
  })
);

therapistMediaRouter.put(
  '/internal/users/therapists/:userId/cv',
  rawFile,
  asyncHandler(async (req, res) => {
    const bytes = getUploadedBytes(req, res);
    if (!bytes) return;
    if (!isPdf(bytes)) {
      res.status(415).json({ message: ALLOWED_CV_TYPES_MESSAGE });
      return;
    }
    const existing = await findProfile(req.params.userId as string, res);
    if (!existing) return;

    const storageKey = buildCvStorageKey(existing.userId);
    await uploadDocument(storageKey, bytes, 'application/pdf');
    const updated = await prisma.therapistProfile.update({
      where: { userId: existing.userId },
      data: {
        cvStorageKey: storageKey,
        cvFileName: sanitizeFileName(req.query.fileName),
        cvSizeBytes: bytes.length,
      },
    });
    if (existing.cvStorageKey) {
      await deleteDocumentByKey(existing.cvStorageKey).catch(() => undefined);
    }
    res.status(200).json({ therapist: toAdminTherapistSummary(updated) });
  })
);

therapistMediaRouter.get(
  '/internal/users/therapists/:userId/cv',
  asyncHandler(async (req, res) => {
    const existing = await findProfile(req.params.userId as string, res);
    if (!existing) return;
    if (!existing.cvStorageKey) {
      res.status(404).json({ message: 'No CV on file' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFileName(existing.cvFileName)}"`
    );
    await streamDocumentByKey(existing.cvStorageKey, res);
  })
);

therapistMediaRouter.delete(
  '/internal/users/therapists/:userId/cv',
  asyncHandler(async (req, res) => {
    const existing = await findProfile(req.params.userId as string, res);
    if (!existing) return;
    const updated = await prisma.therapistProfile.update({
      where: { userId: existing.userId },
      data: { cvStorageKey: null, cvFileName: null, cvSizeBytes: null },
    });
    if (existing.cvStorageKey) {
      await deleteDocumentByKey(existing.cvStorageKey).catch(() => undefined);
    }
    res.status(200).json({ therapist: toAdminTherapistSummary(updated) });
  })
);

therapistMediaRouter.put(
  '/internal/users/therapists/:userId/profile',
  asyncHandler(async (req, res) => {
    const parsed = updateTherapistProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Validation failed',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const existing = await findProfile(req.params.userId as string, res);
    if (!existing) return;

    const { cvSummary, bio } = parsed.data;
    const updated = await prisma.therapistProfile.update({
      where: { userId: existing.userId },
      data: {
        ...(cvSummary !== undefined ? { cvSummary: cvSummary || null } : {}),
        ...(bio !== undefined ? { bio: bio || null } : {}),
      },
    });
    res.status(200).json({ therapist: toAdminTherapistSummary(updated) });
  })
);

// express.raw reports an over-limit body as a 413 with type
// 'entity.too.large'; surface that (and only that) as a clean client error.
therapistMediaRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { type?: string }).type === 'entity.too.large'
    ) {
      res.status(413).json({ message: 'File is too large (max 5 MB)' });
      return;
    }
    next(err);
  }
);
