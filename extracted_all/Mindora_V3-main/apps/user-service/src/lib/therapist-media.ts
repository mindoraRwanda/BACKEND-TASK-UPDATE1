import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectedImageType } from '@mindora/validation';
import type { Prisma } from '../generated/prisma/index.js';

// Fields of TherapistProfile that must never leave the service through a
// public or self-service read. The CV file is admin-only: its storage key is
// an internal GridFS handle and the file name/size are admin UI metadata.
// Every public/self read of therapistProfile passes this as `omit`, so adding
// a column here is the single point of control.
export const therapistPrivateOmit = {
  cvStorageKey: true,
  cvFileName: true,
  cvSizeBytes: true,
} satisfies Prisma.TherapistProfileOmit;

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Same folder app.ts serves at /photos. PHOTOS_DIR exists so tests (and a
// deploy with a mounted volume) can point elsewhere.
export function getPhotosDir(): string {
  return (
    process.env.PHOTOS_DIR ??
    resolve(moduleDir, '../../public/therapist-photos')
  );
}

export function getPhotosBaseUrl(): string {
  return (
    process.env.PHOTOS_BASE_URL ?? 'http://localhost:8000/api/v1/users/photos'
  );
}

const EXTENSIONS: Record<DetectedImageType, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

// Files we generated ourselves: 32 hex chars + extension. Seeded photos
// (m1.jpg ...) are shared by several profiles and must never be deleted
// when one profile's photo is replaced, so only this pattern is removable.
const OWN_PHOTO_FILENAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

export async function savePhoto(
  bytes: Buffer,
  type: DetectedImageType
): Promise<{ filename: string; url: string }> {
  const dir = getPhotosDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomBytes(16).toString('hex')}.${EXTENSIONS[type]}`;
  await writeFile(join(dir, filename), bytes);
  return { filename, url: `${getPhotosBaseUrl()}/${filename}` };
}

// Best-effort removal of a previous photo file, given the stored photoUrl.
export async function deleteOwnPhotoFile(
  photoUrl: string | null | undefined
): Promise<boolean> {
  if (!photoUrl) return false;
  const filename = photoUrl.split('?')[0]?.split('/').pop() ?? '';
  if (!OWN_PHOTO_FILENAME.test(filename)) return false;
  try {
    await unlink(join(getPhotosDir(), filename));
    return true;
  } catch {
    return false;
  }
}

export function buildCvStorageKey(userId: string): string {
  return `therapist-cvs/${userId}/${randomUUID()}.pdf`;
}

// Display-only name: strips path parts and control characters, caps length.
export function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== 'string') return 'cv.pdf';
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f"]/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'cv.pdf';
}

type AdminProfileRow = Prisma.TherapistProfileGetPayload<object>;

// Admin-facing view of a therapist: booleans for what is missing, plus the
// editable text. Deliberately has no storage key.
export function toAdminTherapistSummary(p: AdminProfileRow) {
  return {
    userId: p.userId,
    name: p.userName,
    email: p.email,
    status: p.applicationStatus,
    isSuspended: p.isSuspended,
    photoUrl: p.photoUrl,
    hasPhoto: Boolean(p.photoUrl),
    hasCv: Boolean(p.cvStorageKey),
    hasCvSummary: Boolean(p.cvSummary && p.cvSummary.trim()),
    cvSummary: p.cvSummary,
    bio: p.bio,
    cvFileName: p.cvFileName,
    cvSizeBytes: p.cvSizeBytes,
  };
}
