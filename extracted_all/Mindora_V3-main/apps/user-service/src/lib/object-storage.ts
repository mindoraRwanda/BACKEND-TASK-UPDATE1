import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { config } from '../config.js';
import { getDocumentsBucket } from './mongo.js';

// Therapist application documents (credential PDFs/images) live in MongoDB
// GridFS - not the express.static pattern already used for therapist
// profile photos (app.ts), which writes to local container disk (fine for
// a low-stakes photo, wrong for PII-bearing credential documents on
// Railway, where disk is ephemeral and not shared across replicas/
// redeploys). GridFS lives on the same shared Mongo instance messaging-
// service/community-service already use in this stack, own database.
//
// Previously S3-compatible object storage (see git history) - swapped to
// GridFS so this feature doesn't need its own object-storage credentials/
// bucket, just the Mongo connection every deploy of this stack already has.

const DOWNLOAD_TOKEN_PURPOSE = 'therapist-document-download';
const DOWNLOAD_TOKEN_TTL_SECONDS = 300;

export function buildDocumentStorageKey(
  applicationId: string,
  fileName: string
): string {
  // uuid prefix prevents same-filename collisions within one application
  // (e.g. two files both named "license.pdf") and avoids leaking the
  // original filename as a guessable GridFS lookup key.
  return `therapist-applications/${applicationId}/${randomUUID()}-${fileName}`;
}

export async function uploadDocument(
  storageKey: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const bucket = getDocumentsBucket();
  await new Promise<void>((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(storageKey, { contentType });
    uploadStream.once('finish', () => resolve());
    uploadStream.once('error', reject);
    uploadStream.end(body);
  });
}

interface DownloadTokenPayload {
  purpose: typeof DOWNLOAD_TOKEN_PURPOSE;
  storageKey: string;
  fileName: string;
  mimeType: string;
}

// GridFS has no equivalent of an S3 presigned URL (no public HTTP surface
// of its own), so this mints a short-lived, self-contained signed token
// instead and points the browser at this service's own download route -
// same job a presigned URL did, just self-issued. The route that consumes
// this (GET /api/v1/users/therapist-documents/download) is deliberately
// NOT behind Kong's jwt plugin (a plain `window.open()`/`<a href>` can't
// attach an Authorization header - same reason user-photos has its own
// jwt-free Kong route) - the token itself, not Kong, is what authorizes
// the request, and it's only ever minted by a route that already did its
// own ownership/SERVICE-role check before calling this.
export async function getDocumentDownloadUrl(
  storageKey: string,
  fileName: string,
  mimeType: string
): Promise<string> {
  const token = jwt.sign(
    {
      purpose: DOWNLOAD_TOKEN_PURPOSE,
      storageKey,
      fileName,
      mimeType,
    } satisfies DownloadTokenPayload,
    config.jwtSecret,
    { expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS }
  );

  return `${config.publicKongUrl}/api/v1/users/therapist-documents/download?token=${encodeURIComponent(token)}`;
}

export class InvalidDownloadTokenError extends Error {}

// Verifies the token and streams the GridFS file straight to the response
// with the original Content-Type/filename - used by the download route
// above. Throws InvalidDownloadTokenError on a bad/expired/wrong-purpose
// token so the route can 401 without leaking whether a file exists.
export async function streamDocumentForToken(
  token: string,
  res: Response
): Promise<void> {
  let payload: DownloadTokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as DownloadTokenPayload;
  } catch {
    throw new InvalidDownloadTokenError('Invalid or expired download link');
  }
  if (payload.purpose !== DOWNLOAD_TOKEN_PURPOSE) {
    throw new InvalidDownloadTokenError('Invalid download token');
  }

  const bucket = getDocumentsBucket();
  res.setHeader('Content-Type', payload.mimeType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${payload.fileName.replace(/"/g, '')}"`
  );

  await new Promise<void>((resolve, reject) => {
    const downloadStream = bucket.openDownloadStreamByName(payload.storageKey);
    downloadStream.once('error', reject);
    downloadStream.once('end', () => resolve());
    downloadStream.pipe(res);
  });
}

// Removes a stored document by its storage key. Missing files are ignored:
// callers delete best-effort after the DB row has already been updated, and
// a stale key must not turn a successful replace into an error.
export async function deleteDocumentByKey(storageKey: string): Promise<void> {
  const bucket = getDocumentsBucket();
  const files = await bucket.find({ filename: storageKey }).toArray();
  await Promise.all(files.map((file) => bucket.delete(file._id)));
}

// Streams a stored document to the response. Unlike streamDocumentForToken
// this performs NO authorization of its own - only call it from a route that
// has already verified the caller (the SERVICE-role internal CV route).
export async function streamDocumentByKey(
  storageKey: string,
  res: Response
): Promise<void> {
  const bucket = getDocumentsBucket();
  await new Promise<void>((resolve, reject) => {
    const downloadStream = bucket.openDownloadStreamByName(storageKey);
    downloadStream.once('error', reject);
    downloadStream.once('end', () => resolve());
    downloadStream.pipe(res);
  });
}
