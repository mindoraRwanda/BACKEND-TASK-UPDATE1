#!/usr/bin/env node
// Fallback tool: set a therapist's photo and short CV summary directly,
// without the admin portal. See the "Setting a therapist photo / CV summary"
// section of apps/user-service/README.md.
//
//   node scripts/set-therapist-profile.mjs --user <email|user-id> \
//        --photo <image file> --cv-summary <text file> [--dry-run]
//
// --photo and --cv-summary are each optional, but at least one is required.
// --dry-run validates the inputs (type by file signature, size, length) and
// prints what would happen WITHOUT touching the database or the photos folder.
//
// Targets whatever USER_DATABASE_URL points at (loaded from the repo .env).
// Check it before running: this writes to that database.

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 1500;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN_PHOTO_FILENAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

const here = dirname(fileURLToPath(import.meta.url));
const photosDir =
  process.env.PHOTOS_DIR ?? resolve(here, '../public/therapist-photos');
const photosBaseUrl =
  process.env.PHOTOS_BASE_URL ?? 'http://localhost:8000/api/v1/users/photos';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// Same signatures as packages/validation/src/file-signature.ts.
function detectImageExt(buf) {
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return 'jpg';
  }
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    photo: { type: 'string' },
    'cv-summary': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!values.user && !values['dry-run'])
  fail('--user <email|user-id> is required');
if (!values.photo && !values['cv-summary']) {
  fail('provide --photo and/or --cv-summary');
}

let photoExt = null;
if (values.photo) {
  const info = await stat(values.photo).catch(() => null);
  if (!info?.isFile()) fail(`photo file not found: ${values.photo}`);
  if (info.size > MAX_PHOTO_BYTES) fail('photo is larger than 5 MB');
  photoExt = detectImageExt(await readFile(values.photo));
  if (!photoExt)
    fail('photo must be a real JPEG, PNG or WebP (checked by file signature)');
}

let summary = null;
if (values['cv-summary']) {
  const raw = await readFile(values['cv-summary'], 'utf8').catch(() => null);
  if (raw === null) fail(`summary file not found: ${values['cv-summary']}`);
  summary = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!summary) fail('summary file is empty');
  if (summary.length > MAX_SUMMARY_CHARS) {
    fail(
      `summary is ${summary.length} characters; the limit is ${MAX_SUMMARY_CHARS}`
    );
  }
}

if (values['dry-run']) {
  console.log('Dry run - nothing written.');
  if (photoExt)
    console.log(
      `  photo OK (${photoExt}), would be copied under a random name`
    );
  if (summary)
    console.log(
      `  cvSummary OK (${summary.length}/${MAX_SUMMARY_CHARS} chars)`
    );
  process.exit(0);
}

// Load env and the generated client only for a real run.
const { config } = await import('dotenv');
config({ path: resolve(here, '../../../.env') });
config();
if (!process.env.USER_DATABASE_URL) fail('USER_DATABASE_URL is not set');

const { PrismaClient } = await import('../src/generated/prisma/index.js');
const prisma = new PrismaClient();

try {
  const where = UUID_RE.test(values.user)
    ? { userId: values.user }
    : { email: values.user };
  const profile = await prisma.therapistProfile.findFirst({ where });
  if (!profile) fail(`no therapist profile found for ${values.user}`);

  const data = {};
  let newFile = null;
  if (photoExt) {
    await mkdir(photosDir, { recursive: true });
    newFile = `${randomBytes(16).toString('hex')}.${photoExt}`;
    await copyFile(values.photo, join(photosDir, newFile));
    data.photoUrl = `${photosBaseUrl}/${newFile}`;
  }
  if (summary !== null) data.cvSummary = summary;

  try {
    await prisma.therapistProfile.update({ where: { id: profile.id }, data });
  } catch (error) {
    if (newFile) await unlink(join(photosDir, newFile)).catch(() => {});
    throw error;
  }

  // Remove the replaced photo, but only if we generated it (never the
  // seeded m1.jpg/w1.jpg files, which several profiles share).
  const oldName = profile.photoUrl?.split('?')[0]?.split('/').pop() ?? '';
  if (newFile && OWN_PHOTO_FILENAME.test(oldName)) {
    await unlink(join(photosDir, oldName)).catch(() => {});
  }

  console.log(`Updated therapist ${profile.userName ?? profile.userId}:`);
  if (data.photoUrl) console.log(`  photoUrl  -> ${data.photoUrl}`);
  if (data.cvSummary)
    console.log(`  cvSummary -> ${data.cvSummary.length} chars`);
} finally {
  await prisma.$disconnect();
}
